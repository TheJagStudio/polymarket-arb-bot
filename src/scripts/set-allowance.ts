/**
 * Sets max-allowance for COLLATERAL (pUSD) so the CLOB exchange can move
 * funds on behalf of the proxy. One-time on-chain action; required before
 * the first order can be filled.
 *
 * For sigtype 1/2 (proxy wallets) the SDK routes this through Polymarket's
 * gasless relayer, so no gas is paid from the EOA.
 *
 * Usage: npx tsx src/scripts/set-allowance.ts
 */
import { AssetType } from "@polymarket/clob-client-v2";
import { getClobClient } from "../clob/client.js";
import { logger } from "../logger.js";

async function main(): Promise<void> {
  const { client } = await getClobClient();

  const before = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  logger.info(
    {
      balance_pUSD: (Number(before.balance || "0") / 1e6).toFixed(2),
      allowance_pUSD: (Number(before.allowance || "0") / 1e6).toFixed(2),
    },
    "before",
  );

  if (Number(before.allowance || "0") > 0) {
    logger.info("Allowance already set; nothing to do.");
    process.exit(0);
  }

  logger.info("Submitting updateBalanceAllowance for COLLATERAL …");
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  logger.info("Submitted. Waiting 10s for tx to land …");
  await new Promise((r) => setTimeout(r, 10_000));

  const after = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  logger.info(
    {
      balance_pUSD: (Number(after.balance || "0") / 1e6).toFixed(2),
      allowance_pUSD: (Number(after.allowance || "0") / 1e6).toFixed(2),
    },
    "after",
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "set-allowance failed");
  process.exit(1);
});
