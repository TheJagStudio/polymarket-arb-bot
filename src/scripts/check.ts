/**
 * Pre-flight check for live trading.
 *
 * Reports:
 *   - CLOB auth status (API key derived?)
 *   - pUSD (collateral) balance + allowance
 *   - POL balance (gas, if SIGNATURE_TYPE=0)
 *   - Open orders, if any
 *
 * Usage: npx tsx src/scripts/check.ts
 */
import { AssetType } from "@polymarket/clob-client-v2";
import { createPublicClient, formatEther, http } from "viem";
import { polygon } from "viem/chains";
import { getConfig } from "../config.js";
import { getClobClient } from "../clob/client.js";
import { logger } from "../logger.js";

async function main(): Promise<void> {
  const cfg = getConfig();

  const { client, address } = await getClobClient();
  logger.info({ wallet: address }, "✓ CLOB auth OK");

  // pUSD (collateral) balance + allowance.
  const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const balUsdc = Number(collateral.balance || "0") / 1e6;
  const allowUsdc = Number(collateral.allowance || "0") / 1e6;
  logger.info(
    { pUSD_balance: balUsdc.toFixed(2), pUSD_allowance: allowUsdc.toFixed(2) },
    balUsdc > 0 ? "✓ pUSD funded" : "✗ pUSD balance is zero — fund this address",
  );
  if (balUsdc > 0 && allowUsdc < balUsdc) {
    logger.warn("Allowance < balance. Run client.updateBalanceAllowance() or do it via the UI.");
  }

  // POL (gas) balance via Polygon RPC.
  const rpc = createPublicClient({ chain: polygon, transport: http() });
  const polWei = await rpc.getBalance({ address });
  const polBal = Number(formatEther(polWei));
  logger.info(
    { POL_balance: polBal.toFixed(4) },
    polBal > 0.01 ? "✓ POL gas funded" : "✗ POL balance too low — send ~$1 of POL to wallet",
  );

  // Open orders.
  const open = await client.getOpenOrders();
  logger.info({ count: Array.isArray(open) ? open.length : 0 }, "open orders");
  if (Array.isArray(open) && open.length > 0) {
    for (const o of open.slice(0, 5)) {
      logger.info({ order: o }, "  open");
    }
  }

  // Sanity ping a single market data call.
  const markets = await client.getMarkets();
  logger.info({ marketCount: Array.isArray(markets) ? markets.length : "?" }, "✓ market data reachable");

  logger.info(
    {
      readyForLive:
        balUsdc > 0 && allowUsdc >= Math.min(balUsdc, cfg.MAX_OPEN_EXPOSURE_USD) && polBal > 0.01,
    },
    "summary",
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "check failed");
  process.exit(1);
});
