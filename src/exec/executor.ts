import { OrderType, Side } from "@polymarket/clob-client-v2";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/client.js";
import { getClobClient } from "../clob/client.js";
import { canTrade, bumpAttemptCounter, bumpDailyCounter } from "../risk/gate.js";
import type { BookUpdate } from "../clob/marketWs.js";
import {
  computeUsdcAmount,
  decideOrphanAction,
  decideOutcome,
  isFilledStatus,
  parseFilledShares,
  type RawOrderResponse,
} from "./helpers.js";

const INFLIGHT_COOLDOWN_MS = 5 * 60_000;       // 5 minutes — was 5s, kept re-firing
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
  // Inflight check (cheap) up front so we can skip the DB queries below.
  const isInflight = inflight.has(update.conditionId);

  // Recent-positioning check requires DB; only run if we're past inflight.
  let recentMatchedCount = 0;
  if (!isInflight) {
    const recent = await query<{ n: string }>(
      `select count(*)::text as n from arb.orders
        where condition_id = $1
          and dry_run = false
          and side = 'BUY'
          and status = 'matched'
          and submitted_at > now() - ($2 || ' minutes')::interval`,
      [update.conditionId, ALREADY_POSITIONED_LOOKBACK_MIN.toString()],
    );
    recentMatchedCount = Number(recent.rows[0]?.n ?? 0);
  }

  // Risk gate (daily caps + exposure + loss limit) — runs once we've passed
  // the cheaper filters. decideOutcome() will only consult `risk` if the
  // earlier checks passed; we evaluate it eagerly for simplicity.
  const risk = await canTrade(notional);

  const outcome = decideOutcome({
    askYes,
    askNo,
    threshold: cfg.ARB_THRESHOLD,
    endDateIso: update.endDateIso,
    isInflight,
    recentMatchedCount,
    risk,
  });

  // No-signal branch: shouldn't happen here because we already gated on
  // sum>threshold above, but kept for safety.
  if (outcome.kind === "no-signal") return;

  const skipReason = outcome.kind === "skip" ? outcome.reason : null;

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

      const action = decideOrphanAction(
        { ...yesLeg, leg: "YES", tokenId: update.yesTokenId },
        { ...noLeg, leg: "NO", tokenId: update.noTokenId },
      );

      if (action.kind === "flatten") {
        logger.warn(
          { cond: update.conditionId.slice(0, 10), orphan: action.leg, sharesToSell: action.shares },
          "🚨 partial fill — unwinding orphan",
        );
        await unwindOrphan(signalId, update, action.leg, action.tokenId, action.shares);
      } else if (action.kind === "complete") {
        await bumpDailyCounter();
      }
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
  const usdcAmount = computeUsdcAmount(shares, price);

  let status = "rejected";
  let orderId: string | undefined;
  let errorMsg: string | undefined;
  let filledShares = 0;
  try {
    const resp = (await client.createAndPostMarketOrder(
      { tokenID: tokenId, price, amount: usdcAmount, side: Side.BUY, orderType: OrderType.FOK },
      { tickSize, negRisk },
      OrderType.FOK,
    )) as RawOrderResponse;
    status = resp.success ? (resp.status ?? "submitted") : "rejected";
    orderId = resp.orderID;
    errorMsg = resp.errorMsg;
    // The CLOB API frequently returns takingAmount=0 even on successful FOK
    // matches — parseFilledShares applies multiple strategies (primary
    // field, cross-derive, request-derive) so we always get a non-zero
    // share count when the order actually filled.
    filledShares = parseFilledShares(resp, "BUY", usdcAmount, price);
  } catch (e) {
    status = "threw";
    errorMsg = (e as Error).message;
  }

  await recordOrder(signalId, update, leg, tokenId, price, shares, status, orderId, errorMsg);

  const filled = isFilledStatus(status);
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
