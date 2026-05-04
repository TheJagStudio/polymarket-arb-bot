import { OrderType, Side } from "@polymarket/clob-client-v2";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/client.js";
import { getClobClient } from "../clob/client.js";
import { canTrade, bumpAttemptCounter, bumpDailyCounter } from "../risk/gate.js";
import type { BookUpdate } from "../clob/marketWs.js";

/** Inflight pairs to prevent firing twice on the same condition before settlement. */
const inflight = new Set<string>();

/**
 * Evaluate one book update. If both legs together hit the threshold, attempt
 * to execute. Persists a signal row either way (with skipped_reason if not
 * executed) so we can audit detector behavior.
 */
export async function evaluate(update: BookUpdate): Promise<void> {
  const cfg = getConfig();
  const askYes = update.yes.bestAsk;
  const askNo = update.no.bestAsk;
  if (askYes == null || askNo == null) return; // need both legs.

  const sum = askYes + askNo;
  if (sum > cfg.ARB_THRESHOLD) {
    return; // no signal, common case — don't write a row.
  }

  // We hit the threshold. Decide if we'll act.
  const shares = cfg.SHARES_PER_LEG;
  const notional = shares * sum; // total USD spent across both legs.

  let skipReason: string | null = null;
  if (inflight.has(update.conditionId)) {
    skipReason = "inflight";
  } else {
    const risk = await canTrade(notional);
    if (!risk.allowed) skipReason = risk.reason ?? "risk";
  }

  const signalRes = await query<{ id: string }>(
    `insert into arb.signals
       (condition_id, yes_best_ask, no_best_ask, threshold, would_execute, skipped_reason)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
    [update.conditionId, askYes, askNo, cfg.ARB_THRESHOLD, skipReason == null, skipReason],
  );
  const signalId = signalRes.rows[0]!.id;

  if (skipReason) {
    await bumpAttemptCounter(skipReason);
    logger.info(
      { cond: update.conditionId.slice(0, 10), askYes, askNo, sum: sum.toFixed(4), skipReason },
      "arb signal — skipped",
    );
    return;
  }

  inflight.add(update.conditionId);
  logger.info(
    {
      cond: update.conditionId.slice(0, 10),
      window: update.windowMinutes,
      askYes,
      askNo,
      sum: sum.toFixed(4),
      edge: (1 - sum).toFixed(4),
      shares,
      notional: notional.toFixed(2),
      dry: cfg.DRY_RUN,
    },
    "🎯 arb signal — executing",
  );

  try {
    if (cfg.DRY_RUN) {
      await recordOrder(signalId, update, "YES", update.yesTokenId, askYes, shares, "dry_run");
      await recordOrder(signalId, update, "NO", update.noTokenId, askNo, shares, "dry_run");
      await bumpDailyCounter();
    } else {
      // Fire both legs in parallel to minimise the race window between them.
      const [yesLeg, noLeg] = await Promise.all([
        placeLeg(signalId, update, "YES", update.yesTokenId, askYes, shares),
        placeLeg(signalId, update, "NO", update.noTokenId, askNo, shares),
      ]);

      // Imbalance handling: if exactly one filled, flatten the orphan immediately.
      if (yesLeg.filled !== noLeg.filled) {
        const orphan = yesLeg.filled
          ? { leg: "YES" as const, tokenId: update.yesTokenId, fillPrice: askYes }
          : { leg: "NO" as const, tokenId: update.noTokenId, fillPrice: askNo };
        logger.warn(
          { cond: update.conditionId.slice(0, 10), orphan: orphan.leg },
          "🚨 partial fill — unwinding orphan",
        );
        await unwindOrphan(signalId, update, orphan.leg, orphan.tokenId, shares);
      }

      if (yesLeg.filled && noLeg.filled) await bumpDailyCounter();
    }
  } catch (e) {
    logger.error({ err: (e as Error).message, cond: update.conditionId }, "execution failed");
  } finally {
    // Hold inflight for a few seconds so we don't re-fire on the next book diff.
    setTimeout(() => inflight.delete(update.conditionId), 5_000);
  }
}

/**
 * Sells `shares` of `tokenId` at market (FAK so any partial fill counts and
 * the rest is killed). This is best-effort flattening when one arb leg fills
 * and the other doesn't — accepting whatever the book offers is preferable
 * to holding a directional position.
 */
async function unwindOrphan(
  signalId: string,
  update: BookUpdate,
  leg: "YES" | "NO",
  tokenId: string,
  shares: number,
): Promise<void> {
  try {
    const { client } = await getClobClient();
    const resp = await client.createAndPostMarketOrder(
      { tokenID: tokenId, amount: shares, side: Side.SELL, orderType: OrderType.FAK },
      { tickSize: "0.01", negRisk: false },
      OrderType.FAK,
    );
    const status = resp.success ? (resp.status ?? "submitted") : "unwind_failed";
    await query(
      `insert into arb.orders
         (signal_id, condition_id, token_id, side, leg, price, shares, order_type,
          dry_run, status, clob_order_id, error_message)
         values ($1, $2, $3, 'SELL', $4, 0, $5, 'FAK', false, $6, $7, $8)`,
      [
        signalId,
        update.conditionId,
        tokenId,
        leg,
        shares,
        `unwind:${status}`,
        resp.orderID ?? null,
        resp.errorMsg ?? null,
      ],
    );
    logger.info(
      { leg, status, orderId: resp.orderID, err: resp.errorMsg ?? null },
      "unwind result",
    );
  } catch (e) {
    logger.error({ err: (e as Error).message, leg }, "unwind threw — orphan still open");
    await query(
      `insert into arb.orders
         (signal_id, condition_id, token_id, side, leg, price, shares, order_type,
          dry_run, status, error_message)
         values ($1, $2, $3, 'SELL', $4, 0, $5, 'FAK', false, 'unwind_threw', $6)`,
      [signalId, update.conditionId, tokenId, leg, shares, (e as Error).message],
    );
  }
}

interface LegResult {
  filled: boolean;
  orderId?: string;
  status: string;
}

async function placeLeg(
  signalId: string,
  update: BookUpdate,
  leg: "YES" | "NO",
  tokenId: string,
  price: number,
  shares: number,
): Promise<LegResult> {
  const { client } = await getClobClient();
  const tickSize = "0.01";
  const negRisk = false;
  const usdcAmount = shares * price;

  let status = "rejected";
  let orderId: string | undefined;
  let errorMsg: string | undefined;
  try {
    // FOK market BUY with a price cap — order is killed entirely if the book
    // moves past our limit, ensuring we never fill at a worse price than the
    // detector evaluated.
    const resp = await client.createAndPostMarketOrder(
      { tokenID: tokenId, price, amount: usdcAmount, side: Side.BUY, orderType: OrderType.FOK },
      { tickSize, negRisk },
      OrderType.FOK,
    );
    status = resp.success ? (resp.status ?? "submitted") : "rejected";
    orderId = resp.orderID;
    errorMsg = resp.errorMsg;
  } catch (e) {
    status = "threw";
    errorMsg = (e as Error).message;
  }

  await recordOrder(signalId, update, leg, tokenId, price, shares, status, orderId, errorMsg);

  // FOK-success on Polymarket reports `status: "matched"` when fully filled.
  // Treat anything other than matched/filled as not-filled (so the orphan
  // flattener can react).
  const filled = status === "matched" || status === "filled";
  logger.info({ leg, status, filled, orderId, err: errorMsg ?? null }, "leg result");
  return { filled, orderId, status };
}

async function recordOrder(
  signalId: string,
  update: BookUpdate,
  leg: "YES" | "NO",
  tokenId: string,
  price: number,
  shares: number,
  status: string,
  clobOrderId?: string,
  errorMessage?: string,
): Promise<void> {
  await query(
    `insert into arb.orders
       (signal_id, condition_id, token_id, side, leg, price, shares, order_type,
        dry_run, status, clob_order_id, error_message)
       values ($1, $2, $3, 'BUY', $4, $5, $6, 'FOK', $7, $8, $9, $10)`,
    [
      signalId,
      update.conditionId,
      tokenId,
      leg,
      price,
      shares,
      getConfig().DRY_RUN,
      status,
      clobOrderId ?? null,
      errorMessage ?? null,
    ],
  );
}
