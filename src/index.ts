import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { closeDb } from "./db/client.js";
import { discoverMarkets, persistMarkets } from "./gamma/markets.js";

async function main(): Promise<void> {
  const cfg = getConfig();
  logger.info(
    {
      dryRun: cfg.DRY_RUN,
      windows: cfg.WINDOW_MINUTES,
      threshold: cfg.ARB_THRESHOLD,
      sharesPerLeg: cfg.SHARES_PER_LEG,
    },
    "polymarket-arb-bot booting",
  );

  // Phase 1: discover and persist current markets.
  for (const window of cfg.WINDOW_MINUTES) {
    const markets = await discoverMarkets(window);
    await persistMarkets(markets);
    if (markets.length > 0) {
      const sample = markets[0]!;
      logger.info(
        {
          window,
          sampleSlug: sample.slug,
          sampleEnd: sample.endDateIso,
          tickSize: sample.tickSize,
        },
        "sample market",
      );
    }
  }

  logger.info("Discovery pass complete. Order-book listener and executor wire-up next.");
  await closeDb();
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err }, "fatal");
  process.exit(1);
});
