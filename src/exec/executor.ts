import { OrderType, Side } from "@polymarket/clob-client-v2";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/client.js";
import { getClobClient } from "../clob/client.js";
import { canTrade, bumpAttemptCounter, bumpDailyCounter } from "../risk/gate.js";
import type { BookUpdate } from "../clob/marketWs.js";

const INFLIGHT_COOLDOWN_MS = 5 * 60_000;       // 5 minutes — was 5s, kept re-firing
const MIN_TIME_TO_SETTLEMENT_MS = 60_000;       // skip last 60s — books too thin
const MIN_PRICE = 0.05;                         // skip extreme-priced legs (paper-thin asks)
const MAX_PRICE = 0.95;
const ALREADY_POSITIONED_LOOKBACK_MIN = 30;     // don't re-enter a market we've touched recently

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
  if (askYes == null || askNo == null) return;

  const sum = askYes + askNo;
  if (sum > cfg.ARB_THRESHOLD) return; // common case — don't write a row.

  const shares = cfg.SHARES_PER_LEG;
  const notional = shares * sum;

  // ── Pre-trade safety filters ──────────────────────────────────────────────
  let skipReason: string | null = null;

  // 1. In-flight on this exact market right now.
  if (!skipReason && inflight.has(update.conditionId)) skipReason = "inflight";

  // 2. Too close to settlement — books thin, partial-fill risk highest.
  if (!skipReason) {
    const msToEnd = Date.parse(update.endDateIso) - Date.now();
    if (msToEnd < MIN_TIME_TO_SETTLEMENT_MS) {
      skipReason = `too-close-to-settlement (${Math.round(msToEnd / 1000)}s left)`;
    }
  }

  // 3. Extreme-priced legs — one side at $0.02 / other at $0.97 means the
  //    $0.02 side has thin asks; we'll over-buy the cheap side and orphan it.
  if (!skipReason && (askYes < MIN_PRICE || askNo < MIN_PRICE || askYes > MAX_PRICE || askNo > MAX_PRICE)) {
    skipReason = `extreme-prices (yes=${askYes.toFixed(3)} no=${askNo.toFixed(3)})`;
  }

  // 4. Already entered this market recently — don't stack orphans.
  if (!skipReason) {
    const recent = await query<{ n: string }>(
      `select count(*)::text as n from arb.orders
        where condition_id = $1
          and dry_run = false
          and side = 'BUY'
          and status = 'matched'
          and submitted_at > now() - ($2 || ' minutes')::interval`,
      [update.conditionId, ALREADY_POSITIONED_LOOKBACK_MIN.toString()],
    );
    if (Number(recent.rows[0]?.n ?? 0) > 0) skipReason = "already-positioned";
  }

  // 5. Risk gate (daily caps + exposure + loss limit).
  if (!skipReason) {
    const risk = await canTrade(notional);
    if (!risk.allowed) skipReason = risk.reason ?? "risk";
  }

  // ── Persist the signal regardless of decision ─────────────────────────────
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
      const [yesLeg, noLeg] = await Promise.all([
        placeLeg(signalId, update, "YES", update.yesTokenId, askYes, shares),
        placeLeg(signalId, update, "NO", update.noTokenId, askNo, shares),
      ]);

      // Orphan handling: if exactly one filled, sell the ACTUAL filled
      // share count (was: configured shares — left residuals when fill > requested).
      if (yesLeg.filled !== noLeg.filled) {
        const orphan = yesLeg.filled
          ? { leg: "YES" as const, tokenId: update.yesTokenId, actualShares: yesLeg.filledShares }
          : { leg: "NO" as const, tokenId: update.noTokenId, actualShares: noLeg.filledShares };
        logger.warn(
          { cond: update.conditionId.slice(0, 10), orphan: orphan.leg, sharesToSell: orphan.actualShares },
          "🚨 partial fill — unwinding orphan",
        );
        await unwindOrphan(signalId, update, orphan.leg, orphan.tokenId, orphan.actualShares);
      }

      if (yesLeg.filled && noLeg.filled) await bumpDailyCounter();
    }
  } catch (e) {
    logger.error({ err: (e as Error).message, cond: update.conditionId }, "execution failed");
  } finally {
    setTimeout(() => inflight.delete(update.conditionId), INFLIGHT_COOLDOWN_MS);
  }
}

/**
 * Sells `shares` of `tokenId` at market (FAK). Driven by the actual filled
 * share count from the BUY response, so we flatten 100% of what we hold.
 */
async function unwindOrphan(
  signalId: string,
  update: BookUpdate,
  leg: "YES" | "NO",
  tokenId: string,
  shares: number,
): Promise<void> {
  if (shares <= 0) return;
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
      { leg, status, sold: shares, orderId: resp.orderID, err: resp.errorMsg ?? null },
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
  filledShares: number;
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
  let filledShares = 0;
  try {
    const resp = await client.createAndPostMarketOrder(
      { tokenID: tokenId, price, amount: usdcAmount, side: Side.BUY, orderType: OrderType.FOK },
      { tickSize, negRisk },
      OrderType.FOK,
    );
    status = resp.success ? (resp.status ?? "submitted") : "rejected";
    orderId = resp.orderID;
    errorMsg = resp.errorMsg;
    // takingAmount is the conditional-token quantity received (6-decimal fixed point).
    if (resp.takingAmount) {
      filledShares = Number(resp.takingAmount) / 1e6;
    }
  } catch (e) {
    status = "threw";
    errorMsg = (e as Error).message;
  }

  await recordOrder(signalId, update, leg, tokenId, price, shares, status, orderId, errorMsg);

  const filled = status === "matched" || status === "filled";
  logger.info(
    { leg, status, filled, filledShares, orderId, err: errorMsg ?? null },
    "leg result",
  );
  return { filled, filledShares, orderId, status };
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
