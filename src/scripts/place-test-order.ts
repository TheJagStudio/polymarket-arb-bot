/**
 * Smoke test: place a single GTC BUY ~10c below the best bid (won't fill),
 * verify it lands, then cancel it.
 *
 * Requires: pUSD funded + CTF allowance set (run `src/scripts/check.ts` first).
 *
 * Usage: npx tsx src/scripts/place-test-order.ts
 */
import { OrderType, Side } from "@polymarket/clob-client-v2";
import { getClobClient } from "../clob/client.js";
import { discoverMarkets } from "../gamma/markets.js";
import { logger } from "../logger.js";

async function main(): Promise<void> {
  const { client } = await getClobClient();

  // Pick one currently-tradeable 5m market.
  const markets = await discoverMarkets(5);
  if (markets.length === 0) throw new Error("no active 5m markets right now");

  // Grab one a few minutes out (more time to cancel if anything goes weird).
  const target = markets.find(
    (m) => Date.parse(m.endDateIso) > Date.now() + 5 * 60_000,
  ) ?? markets[0]!;

  logger.info(
    { slug: target.slug, end: target.endDateIso, yesToken: target.yesTokenId.slice(0, 16) + "..." },
    "target market",
  );

  // Read live book to set a price safely below best bid.
  const book = await client.getOrderBook(target.yesTokenId);
  const bestBid = book.bids.length > 0 ? Math.max(...book.bids.map((b) => Number(b.price))) : 0.5;
  const price = Math.max(0.01, Number((bestBid - 0.10).toFixed(2))); // way below — shouldn't fill
  const shares = target.minSize; // exchange minimum (5)

  logger.info(
    { bestBid: bestBid.toFixed(2), placePrice: price.toFixed(2), shares },
    "placing test order (GTC BUY — should rest in book, NOT fill)",
  );

  const resp = await client.createAndPostOrder(
    { tokenID: target.yesTokenId, price, size: shares, side: Side.BUY },
    { tickSize: "0.01", negRisk: false },
    OrderType.GTC,
  );

  logger.info(
    { success: resp.success, orderID: resp.orderID, status: resp.status, err: resp.errorMsg },
    "post result",
  );
  if (!resp.success || !resp.orderID) {
    throw new Error(`order rejected: ${resp.errorMsg ?? "no orderID returned"}`);
  }

  // Wait briefly so a human can see it land in the dashboard.
  await new Promise((r) => setTimeout(r, 2_000));

  const cancelResp = await client.cancelOrder({ orderID: resp.orderID });
  logger.info({ cancelResp }, "cancel result");

  logger.info("✓ smoke test passed — auth + signing + order placement + cancellation all work");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "smoke test failed");
  process.exit(1);
});
