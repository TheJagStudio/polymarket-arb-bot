/**
 * Manual one-shot: try to FAK SELL every open position.
 *   - Settled markets are skipped (no buyer for losing side, winners auto-redeem)
 *   - Markets <30s from settlement skipped (sell unlikely to match before close)
 * Prints a per-position result summary at the end.
 *
 * Usage: npx tsx src/scripts/flatten-all.ts
 */
import { OrderType, Side } from "@polymarket/clob-client-v2";
import { privateKeyToAccount } from "viem/accounts";
import { getConfig, resolveFunder } from "../config.js";
import { getClobClient } from "../clob/client.js";
import { logger } from "../logger.js";

interface ApiPosition {
  conditionId: string;
  asset: string;
  size: number;
  outcome: string;
  curPrice: number;
  endDate?: string;
  title: string;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const account = privateKeyToAccount(cfg.PRIVATE_KEY as `0x${string}`);
  const funder = resolveFunder(cfg, account.address);

  const r = await fetch(
    `${cfg.DATA_API_HOST}/positions?user=${funder}&sizeThreshold=0&limit=200`,
  );
  if (!r.ok) {
    logger.error({ status: r.status }, "positions fetch failed");
    process.exit(1);
  }
  const positions = (await r.json()) as ApiPosition[];
  logger.info({ count: positions.length }, "open positions discovered");

  const { client } = await getClobClient();

  type Result = {
    title: string;
    outcome: string;
    size: number;
    action: "sold" | "skipped-settled" | "skipped-soon" | "rejected" | "threw";
    note: string;
  };
  const results: Result[] = [];

  for (const p of positions) {
    if (p.size <= 0) {
      results.push({ title: p.title, outcome: p.outcome, size: p.size, action: "skipped-settled", note: "size 0" });
      continue;
    }

    const endMs = p.endDate ? Date.parse(p.endDate) : 0;
    const msToEnd = endMs ? endMs - Date.now() : -1;

    if (endMs && msToEnd < 0) {
      results.push({
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        action: "skipped-settled",
        note: `ended ${Math.abs(Math.round(msToEnd / 60_000))}m ago — no buyer`,
      });
      continue;
    }
    if (endMs && msToEnd < 30_000) {
      results.push({
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        action: "skipped-soon",
        note: `${Math.round(msToEnd / 1000)}s to settlement`,
      });
      continue;
    }
    if (!endMs) {
      results.push({
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        action: "skipped-settled",
        note: "no end date in API",
      });
      continue;
    }

    logger.info(
      { outcome: p.outcome, size: p.size, curPrice: p.curPrice, msToEnd },
      `attempting FAK SELL: ${p.title.slice(0, 50)}`,
    );
    try {
      const resp = await client.createAndPostMarketOrder(
        { tokenID: p.asset, amount: p.size, side: Side.SELL, orderType: OrderType.FAK },
        { tickSize: "0.01", negRisk: false },
        OrderType.FAK,
      );
      if (resp.success) {
        results.push({
          title: p.title,
          outcome: p.outcome,
          size: p.size,
          action: "sold",
          note: `${resp.status ?? "submitted"} | orderID ${resp.orderID?.slice(0, 12) ?? ""}…`,
        });
      } else {
        results.push({
          title: p.title,
          outcome: p.outcome,
          size: p.size,
          action: "rejected",
          note: resp.errorMsg ?? "no reason given",
        });
      }
    } catch (e) {
      results.push({
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        action: "threw",
        note: (e as Error).message.slice(0, 80),
      });
    }
  }

  console.log("\n=== flatten summary ===");
  for (const r of results) {
    const tag = r.action === "sold" ? "✓" : r.action === "rejected" || r.action === "threw" ? "✗" : "—";
    console.log(`${tag} ${r.action.padEnd(18)} ${r.outcome.padEnd(5)} sz=${r.size.toFixed(3).padStart(7)}  ${r.note}  | ${r.title.slice(0, 50)}`);
  }
  const sold = results.filter((r) => r.action === "sold").length;
  const skipped = results.filter((r) => r.action.startsWith("skipped")).length;
  const failed = results.filter((r) => r.action === "rejected" || r.action === "threw").length;
  console.log(`\nsold=${sold}  skipped=${skipped}  failed=${failed}  total=${results.length}`);
  process.exit(0);
}

main().catch((e) => {
  logger.error({ err: e instanceof Error ? e.message : e }, "flatten-all failed");
  process.exit(1);
});
