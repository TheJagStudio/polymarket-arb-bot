/**
 * Atomic-execution mode.
 *
 * Premise: in `parallel` mode we fire both FOK BUYs simultaneously, but the
 * second leg's book moves between detection and submission, so it rejects.
 * Production data: 9/9 of our matched legs orphaned this way.
 *
 * Atomic mode breaks the race by sequencing:
 *   1. Place LEG A as a resting GTC limit at askA (cheaper leg first — less
 *      capital at risk while waiting).
 *   2. Poll order status. When `status === "matched"`, fire LEG B as FOK.
 *   3. If LEG B rejects → flatten LEG A immediately (orphan flattener path,
 *      same as parallel mode).
 *   4. If LEG A doesn't fill within ATOMIC_LEG_A_TIMEOUT_MS → cancel and
 *      give up on this signal.
 *
 * Tradeoffs vs parallel:
 *   + Eliminates the cross-leg race that caused 100% orphan rate
 *   + If A doesn't fill, we exit cleanly with zero capital at risk
 *   - Slower entry (capped by leg A's match latency, often seconds)
 *   - More API calls per attempted arb
 *   - Resting GTC = small but non-zero risk that someone trades through us
 *     while we wait (which is fine — we wanted to be filled)
 */

import { OrderType, Side } from "@polymarket/clob-client-v2";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { getClobClient } from "../clob/client.js";
import { isFilledStatus, parseFilledShares, type RawOrderResponse } from "./helpers.js";

export interface AtomicLegOutcome {
  filled: boolean;
  filledShares: number;
  orderId?: string;
  status: string;
  errorMsg?: string;
}

export interface AtomicResult {
  /** Did both legs fill? */
  bothFilled: boolean;
  /** True if we never got past leg A (clean no-op). */
  abandoned: boolean;
  /** Set when one leg filled and the other failed — caller must flatten. */
  orphan?: { leg: "YES" | "NO"; tokenId: string; shares: number };
  legA: AtomicLegOutcome;
  legB?: AtomicLegOutcome;
}

interface PlaceArgs {
  yesTokenId: string;
  noTokenId: string;
  askYes: number;
  askNo: number;
  shares: number;
}

/**
 * Execute the arb in atomic mode. Returns an AtomicResult describing what
 * happened. Callers handle persistence (recordOrder) and orphan flattening.
 */
export async function executeAtomic(args: PlaceArgs): Promise<AtomicResult> {
  const cfg = getConfig();
  // Pick the cheaper leg as A — less capital tied up while resting.
  const aIsYes = args.askYes <= args.askNo;
  const legA = aIsYes
    ? { name: "YES" as const, tokenId: args.yesTokenId, price: args.askYes }
    : { name: "NO" as const, tokenId: args.noTokenId, price: args.askNo };
  const legB = aIsYes
    ? { name: "NO" as const, tokenId: args.noTokenId, price: args.askNo }
    : { name: "YES" as const, tokenId: args.yesTokenId, price: args.askYes };

  logger.info(
    { legA: legA.name, priceA: legA.price, legB: legB.name, priceB: legB.price, shares: args.shares },
    "atomic: placing leg A (resting GTC)",
  );

  // Step 1: Resting GTC limit BUY for leg A.
  const { client } = await getClobClient();
  let aResp: RawOrderResponse;
  try {
    aResp = (await client.createAndPostOrder(
      { tokenID: legA.tokenId, price: legA.price, size: args.shares, side: Side.BUY },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC,
    )) as RawOrderResponse;
  } catch (e) {
    logger.error({ err: (e as Error).message, leg: legA.name }, "atomic: leg A post threw");
    return {
      bothFilled: false,
      abandoned: true,
      legA: { filled: false, filledShares: 0, status: "threw", errorMsg: (e as Error).message },
    };
  }

  if (!aResp.success || !aResp.orderID) {
    logger.warn({ leg: legA.name, err: aResp.errorMsg }, "atomic: leg A rejected on placement");
    return {
      bothFilled: false,
      abandoned: true,
      legA: { filled: false, filledShares: 0, status: aResp.status ?? "rejected", errorMsg: aResp.errorMsg },
    };
  }

  // Step 2: Poll until leg A fills or we time out.
  const aStartMs = Date.now();
  let aStatus: string = aResp.status ?? "live";
  let aFilledShares = 0;

  // If leg A matched on placement (rare but possible), we're already filled.
  if (isFilledStatus(aStatus)) {
    aFilledShares = parseFilledShares(aResp, "BUY", args.shares * legA.price, legA.price);
  } else {
    while (Date.now() - aStartMs < cfg.ATOMIC_LEG_A_TIMEOUT_MS) {
      await sleep(cfg.ATOMIC_POLL_MS);
      try {
        const order = (await client.getOrder(aResp.orderID)) as {
          status?: string;
          size_matched?: string | number;
        };
        const sizeMatched = Number(order.size_matched ?? 0);
        if (sizeMatched >= args.shares) {
          aStatus = "matched";
          aFilledShares = sizeMatched;
          break;
        }
        if (order.status === "matched" || order.status === "filled") {
          aStatus = "matched";
          aFilledShares = sizeMatched > 0 ? sizeMatched : args.shares;
          break;
        }
      } catch (e) {
        logger.debug({ err: (e as Error).message }, "atomic: getOrder poll failed (transient)");
      }
    }
  }

  if (aFilledShares <= 0) {
    // Timed out or never filled — cancel and exit.
    logger.info({ leg: legA.name, orderId: aResp.orderID }, "atomic: leg A timed out, cancelling");
    try {
      await client.cancelOrder({ orderID: aResp.orderID });
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "atomic: cancel threw — order may still be live");
    }
    return {
      bothFilled: false,
      abandoned: true,
      legA: { filled: false, filledShares: 0, orderId: aResp.orderID, status: aStatus },
    };
  }

  logger.info(
    { leg: legA.name, sharesFilled: aFilledShares, latencyMs: Date.now() - aStartMs },
    "atomic: leg A FILLED — firing leg B FOK",
  );

  // Step 3: Leg B as FOK market order, sized to mirror what A actually filled.
  const bUsdc = aFilledShares * legB.price;
  let bResp: RawOrderResponse;
  try {
    bResp = (await client.createAndPostMarketOrder(
      { tokenID: legB.tokenId, price: legB.price, amount: bUsdc, side: Side.BUY, orderType: OrderType.FOK },
      { tickSize: "0.01", negRisk: false },
      OrderType.FOK,
    )) as RawOrderResponse;
  } catch (e) {
    logger.error({ err: (e as Error).message, leg: legB.name }, "atomic: leg B threw — orphan");
    return {
      bothFilled: false,
      abandoned: false,
      orphan: { leg: legA.name, tokenId: legA.tokenId, shares: aFilledShares },
      legA: { filled: true, filledShares: aFilledShares, orderId: aResp.orderID, status: aStatus },
      legB: { filled: false, filledShares: 0, status: "threw", errorMsg: (e as Error).message },
    };
  }

  const bFilled = bResp.success === true && isFilledStatus(bResp.status);
  const bShares = bFilled ? parseFilledShares(bResp, "BUY", bUsdc, legB.price) : 0;

  if (bFilled) {
    logger.info(
      { leg: legB.name, sharesFilled: bShares },
      "atomic: leg B FILLED — both legs in",
    );
    return {
      bothFilled: true,
      abandoned: false,
      legA: { filled: true, filledShares: aFilledShares, orderId: aResp.orderID, status: aStatus },
      legB: { filled: true, filledShares: bShares, orderId: bResp.orderID, status: bResp.status ?? "matched" },
    };
  }

  // Leg B failed: orphan on leg A. Caller flattens.
  logger.warn(
    { leg: legB.name, err: bResp.errorMsg, status: bResp.status },
    "atomic: leg B rejected — caller will flatten leg A",
  );
  return {
    bothFilled: false,
    abandoned: false,
    orphan: { leg: legA.name, tokenId: legA.tokenId, shares: aFilledShares },
    legA: { filled: true, filledShares: aFilledShares, orderId: aResp.orderID, status: aStatus },
    legB: {
      filled: false,
      filledShares: 0,
      orderId: bResp.orderID,
      status: bResp.status ?? "rejected",
      errorMsg: bResp.errorMsg,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
