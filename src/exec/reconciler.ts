import { OrderType, Side } from "@polymarket/clob-client-v2";
import { privateKeyToAccount } from "viem/accounts";
import { getConfig, resolveFunder } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/client.js";
import { getClobClient } from "../clob/client.js";

interface ApiPosition {
  conditionId: string;
  asset: string; // token id (numeric string)
  size: number;
  outcome: string;
  endDate?: string;
  title: string;
}

/** Attempted recently? Don't re-spam the same flatten request. */
const recentlyFlattened = new Map<string, number>();
const FLATTEN_COOLDOWN_MS = 90_000;

/**
 * Periodic safety net: any position in a still-tradeable market that
 * we hold means a leg either didn't fully flatten or arrived from outside
 * the bot. Try a best-effort FAK SELL.
 *
 * Skips markets that are settled (no point) or settling soon (<30s left
 * — the SELL likely won't match before resolution; better to take the
 * outcome than burn a wasted API call).
 */
export async function reconcilePositions(): Promise<void> {
  const cfg = getConfig();
  if (cfg.DRY_RUN) return;

  const account = privateKeyToAccount(cfg.PRIVATE_KEY as `0x${string}`);
  const funder = resolveFunder(cfg, account.address);

  const r = await fetch(
    `${cfg.DATA_API_HOST ?? "https://data-api.polymarket.com"}/positions?user=${funder}&sizeThreshold=0&limit=100`,
  );
  if (!r.ok) {
    logger.warn({ status: r.status }, "reconciler: positions fetch failed");
    return;
  }
  const positions = (await r.json()) as ApiPosition[];
  if (positions.length === 0) return;

  for (const p of positions) {
    if (p.size <= 0) continue;
    const endMs = p.endDate ? Date.parse(p.endDate) : 0;
    const msToEnd = endMs - Date.now();
    if (endMs && msToEnd < 30_000) continue; // settled or about to settle
    if (endMs === 0) continue; // unknown — be conservative

    const last = recentlyFlattened.get(p.asset);
    if (last && Date.now() - last < FLATTEN_COOLDOWN_MS) continue;

    logger.warn(
      { cond: p.conditionId.slice(0, 10), outcome: p.outcome, size: p.size, msToEnd },
      "🧹 reconciler found unflattened position — attempting FAK SELL",
    );

    try {
      const { client } = await getClobClient();
      const resp = await client.createAndPostMarketOrder(
        { tokenID: p.asset, amount: p.size, side: Side.SELL, orderType: OrderType.FAK },
        { tickSize: "0.01", negRisk: false },
        OrderType.FAK,
      );
      const status = resp.success ? (resp.status ?? "submitted") : "rejected";
      await query(
        `insert into arb.orders
           (signal_id, condition_id, token_id, side, leg, price, shares, order_type,
            dry_run, status, clob_order_id, error_message)
           values (null, $1, $2, 'SELL', $3, 0, $4, 'FAK', false, $5, $6, $7)`,
        [
          p.conditionId,
          p.asset,
          p.outcome.toUpperCase() === "UP" ? "YES" : "NO",
          p.size,
          `reconcile:${status}`,
          resp.orderID ?? null,
          resp.errorMsg ?? null,
        ],
      );
      logger.info({ status, orderId: resp.orderID, err: resp.errorMsg }, "reconciler result");
    } catch (e) {
      logger.error({ err: (e as Error).message, asset: p.asset }, "reconciler threw");
    } finally {
      recentlyFlattened.set(p.asset, Date.now());
    }
  }
}

export function startReconciler(): NodeJS.Timeout {
  // Fire once immediately, then every 60 seconds.
  void reconcilePositions().catch((e) =>
    logger.error({ err: (e as Error).message }, "reconciler initial run failed"),
  );
  return setInterval(() => {
    void reconcilePositions().catch((e) =>
      logger.error({ err: (e as Error).message }, "reconciler tick failed"),
    );
  }, 60_000);
}
