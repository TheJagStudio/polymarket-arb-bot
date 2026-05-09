/**
 * Pure helper functions for the executor. Extracted so they can be unit-tested
 * without standing up the SDK / DB / WS stack.
 */

/** Subset of the SDK's OrderResponse we actually inspect. */
export interface RawOrderResponse {
  success?: boolean;
  status?: string;
  errorMsg?: string;
  orderID?: string;
  takingAmount?: string | number;
  makingAmount?: string | number;
  transactionsHashes?: string[];
}

/** Status strings the CLOB API returns when an order has actually filled. */
export const FILLED_STATUSES = new Set(["matched", "filled"]);

export function isFilledStatus(status: string | undefined): boolean {
  return status != null && FILLED_STATUSES.has(status);
}

/**
 * Decide how many shares were actually filled from a market-order response.
 *
 * Polymarket's CLOB POST /order response declares `takingAmount` /
 * `makingAmount` (camelCase, 6-decimal fixed-point), but in practice these
 * fields are inconsistently populated for FOK/FAK fills — they often come
 * back as 0 or "" even when `success=true status=matched`. That broke the
 * orphan flattener: we'd parse 0 shares filled, the unwind would attempt to
 * SELL 0, and the orphan would sit through settlement.
 *
 * Strategy (in order — first non-zero wins):
 *   1. Primary fixed-point field for the side
 *      - BUY:  takingAmount / 1e6  (= outcome tokens received)
 *      - SELL: makingAmount / 1e6  (= outcome tokens given)
 *   2. Cross-derived from the OTHER fixed-point field + price
 *      - BUY:  makingAmount / 1e6 / price  (USDC spent / price = shares)
 *      - SELL: takingAmount / 1e6 / price  (USDC received / price = shares)
 *   3. Derive from what we requested. FOK/FAK BUY only matches at-or-below
 *      our price cap, so requestedUsdc / price is a safe lower bound on
 *      shares received. For SELL the SDK passes `amount` directly as
 *      shares, so `requestedAmount` IS the size we asked to sell.
 *
 * Returns 0 when the order didn't fill (unknown / rejected status) — caller
 * should still inspect `success` / `status` independently.
 */
export function parseFilledShares(
  resp: RawOrderResponse,
  side: "BUY" | "SELL",
  requestedAmount: number,
  price: number,
): number {
  const taking = toNumber(resp.takingAmount);
  const making = toNumber(resp.makingAmount);

  // Strategy 1: primary field (already in 6-decimal fixed-point).
  const primary = side === "BUY" ? taking : making;
  if (primary > 0) return primary / 1e6;

  // Only consider derived fallbacks when the order actually matched —
  // otherwise we'd manufacture a phantom fill on a rejected order.
  if (!isFilledStatus(resp.status) || resp.success === false) return 0;

  // Strategy 2: cross-derive from the other amount.
  const cross = side === "BUY" ? making : taking;
  if (cross > 0 && price > 0) return cross / 1e6 / price;

  // Strategy 3: derive from the request. For BUY this is an estimate
  // (FOK fills at-or-below cap — we likely got at least this many shares).
  // For SELL the SDK passes `amount` directly as shares.
  if (side === "BUY") {
    return price > 0 ? requestedAmount / price : 0;
  }
  return requestedAmount;
}

function toNumber(v: string | number | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

// ── Detector / pre-trade decision ────────────────────────────────────────────

export interface SkipDecisionInput {
  askYes: number | null | undefined;
  askNo: number | null | undefined;
  threshold: number;
  endDateIso: string;
  /** Has this conditionId been recently fired but not yet settled? */
  isInflight: boolean;
  /** Number of recent matched BUY rows for this conditionId. */
  recentMatchedCount: number;
  /** Result of the risk gate (null if not evaluated yet). */
  risk: { allowed: boolean; reason?: string } | null;
  /** Optional override for "now" — for deterministic testing. */
  now?: number;
}

export type DetectorOutcome =
  | { kind: "no-signal" } // sum > threshold (or asks missing)
  | { kind: "fire" }
  | { kind: "skip"; reason: string };

export const MIN_TIME_TO_SETTLEMENT_MS = 60_000;
export const MIN_PRICE = 0.05;
export const MAX_PRICE = 0.95;

/**
 * Pure decision function. Returns the outcome for a single book update —
 * "no-signal" (don't even record), "fire" (execute), or "skip" with reason
 * (record signal with skipped_reason).
 */
export function decideOutcome(input: SkipDecisionInput): DetectorOutcome {
  const { askYes, askNo, threshold } = input;
  if (askYes == null || askNo == null) return { kind: "no-signal" };

  const sum = askYes + askNo;
  if (sum > threshold) return { kind: "no-signal" };

  if (input.isInflight) return { kind: "skip", reason: "inflight" };

  const now = input.now ?? Date.now();
  const msToEnd = Date.parse(input.endDateIso) - now;
  if (msToEnd < MIN_TIME_TO_SETTLEMENT_MS) {
    return { kind: "skip", reason: `too-close-to-settlement (${Math.round(msToEnd / 1000)}s left)` };
  }

  if (askYes < MIN_PRICE || askNo < MIN_PRICE || askYes > MAX_PRICE || askNo > MAX_PRICE) {
    return {
      kind: "skip",
      reason: `extreme-prices (yes=${askYes.toFixed(3)} no=${askNo.toFixed(3)})`,
    };
  }

  if (input.recentMatchedCount > 0) return { kind: "skip", reason: "already-positioned" };

  if (input.risk && !input.risk.allowed) {
    return { kind: "skip", reason: input.risk.reason ?? "risk" };
  }

  return { kind: "fire" };
}

// ── Sizing ──────────────────────────────────────────────────────────────────

/** USDC notional for a BUY order at a given price cap and share count. */
export function computeUsdcAmount(shares: number, price: number): number {
  return shares * price;
}

/**
 * If the FOK BUY filled at a price BELOW our cap, we get more shares than
 * requested. Returns the shares actually received given the USDC we spent
 * and the realised fill price.
 */
export function sharesAtFillPrice(usdcSpent: number, fillPrice: number): number {
  if (fillPrice <= 0) return 0;
  return usdcSpent / fillPrice;
}

// ── Orphan handling ─────────────────────────────────────────────────────────

export interface LegOutcome {
  filled: boolean;
  filledShares: number;
  tokenId: string;
  leg: "YES" | "NO";
}

export type OrphanAction =
  | { kind: "none" } // both rejected — nothing to do
  | { kind: "complete" } // both filled — bump counter, no flatten
  | { kind: "flatten"; leg: "YES" | "NO"; tokenId: string; shares: number };

/**
 * Decide what to do after both BUY legs return.
 *   both filled        → "complete" (bump daily counter)
 *   one filled, one no → "flatten" the filled leg
 *   both rejected      → "none"
 */
export function decideOrphanAction(yesLeg: LegOutcome, noLeg: LegOutcome): OrphanAction {
  if (yesLeg.filled && noLeg.filled) return { kind: "complete" };
  if (!yesLeg.filled && !noLeg.filled) return { kind: "none" };
  const orphan = yesLeg.filled ? yesLeg : noLeg;
  return {
    kind: "flatten",
    leg: orphan.leg,
    tokenId: orphan.tokenId,
    shares: orphan.filledShares,
  };
}
