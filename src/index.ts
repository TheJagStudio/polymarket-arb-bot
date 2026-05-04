import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { closeDb } from "./db/client.js";
import { discoverMarkets, persistMarkets, type DiscoveredMarket } from "./gamma/markets.js";
import { MarketWs, type BookUpdate } from "./clob/marketWs.js";
import { evaluate } from "./exec/executor.js";
import { startReconciler } from "./exec/reconciler.js";
import { getClobClient } from "./clob/client.js";

const REDISCOVER_INTERVAL_MS = 60_000; // re-poll Gamma every 60s for new short-lived markets
const MAX_MINUTES_AHEAD = 30; // only watch markets ending in next N minutes (keeps token list small)

async function discoverAll(): Promise<DiscoveredMarket[]> {
  const cfg = getConfig();
  const all: DiscoveredMarket[] = [];
  for (const w of cfg.WINDOW_MINUTES) {
    try {
      const ms = await discoverMarkets(w);
      all.push(...ms);
    } catch (e) {
      logger.warn({ err: (e as Error).message, window: w }, "discovery failed for window");
    }
  }
  await persistMarkets(all);
  // Filter to markets ending soon — that's where arbs live.
  const cutoff = Date.now() + MAX_MINUTES_AHEAD * 60_000;
  return all.filter((m) => Date.parse(m.endDateIso) <= cutoff);
}

async function main(): Promise<void> {
  const cfg = getConfig();
  logger.info(
    {
      dryRun: cfg.DRY_RUN,
      windows: cfg.WINDOW_MINUTES,
      threshold: cfg.ARB_THRESHOLD,
      sharesPerLeg: cfg.SHARES_PER_LEG,
      maxDaily: cfg.MAX_DAILY_TRADES,
      maxExposure: cfg.MAX_OPEN_EXPOSURE_USD,
    },
    "polymarket-arb-bot booting",
  );

  // Eagerly init CLOB client (derives L2 creds). In dry-run mode we tolerate
  // failures here — order books are public, so detection still works without auth.
  try {
    const { address } = await getClobClient();
    logger.info({ wallet: address }, "wallet ready");
  } catch (e) {
    if (cfg.DRY_RUN) {
      logger.warn(
        { err: (e as Error).message },
        "CLOB auth failed — continuing in dry-run (live trading would fail)",
      );
    } else {
      throw e;
    }
  }

  let watching = await discoverAll();
  logger.info({ count: watching.length, horizonMin: MAX_MINUTES_AHEAD }, "initial watchlist");

  let ws: MarketWs | null = null;
  const subscribe = (markets: DiscoveredMarket[]) => {
    ws?.stop();
    if (markets.length === 0) {
      logger.warn("no markets in horizon — sleeping until next discovery");
      return;
    }
    ws = new MarketWs(markets);
    ws.on("book", (update: BookUpdate) => {
      void evaluate(update).catch((err) =>
        logger.error({ err: (err as Error).message }, "evaluate failed"),
      );
    });
    ws.start();
  };
  subscribe(watching);

  // Periodic reconciler — flattens any stranded positions in still-open markets.
  const reconcilerTimer = startReconciler();

  // Periodic re-discovery — short-window markets churn every few minutes.
  const interval = setInterval(async () => {
    try {
      const next = await discoverAll();
      const prevIds = new Set(watching.map((m) => m.conditionId));
      const nextIds = new Set(next.map((m) => m.conditionId));
      const sameSet =
        prevIds.size === nextIds.size && [...prevIds].every((id) => nextIds.has(id));
      if (!sameSet) {
        logger.info({ from: watching.length, to: next.length }, "watchlist changed, resubscribing");
        watching = next;
        subscribe(watching);
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "rediscovery failed");
    }
  }, REDISCOVER_INTERVAL_MS);

  // Graceful shutdown.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    clearInterval(interval);
    clearInterval(reconcilerTimer);
    ws?.stop();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "fatal");
  process.exit(1);
});
