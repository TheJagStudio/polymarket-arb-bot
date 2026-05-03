import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/client.js";

export interface DiscoveredMarket {
  conditionId: string;
  slug: string;
  question: string;
  windowMinutes: number;
  yesTokenId: string; // "Up"
  noTokenId: string; // "Down"
  endDateIso: string;
  tickSize: number;
  minSize: number;
  negRisk: boolean;
  acceptingOrders: boolean;
}

interface GammaMarket {
  conditionId: string;
  slug: string;
  question: string;
  clobTokenIds: string; // JSON-stringified array
  outcomes: string; // JSON-stringified array
  closed: boolean;
  active: boolean;
  enableOrderBook: boolean;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
}

interface GammaEvent {
  slug: string;
  endDate: string;
  closed: boolean;
  active: boolean;
  seriesSlug?: string;
  markets?: GammaMarket[];
}

const SERIES_BY_WINDOW: Record<number, string> = {
  5: "btc-up-or-down-5m",
  15: "btc-up-or-down-15m",
};

/** Pull all currently-tradeable BTC up/down markets for the given window minutes. */
export async function discoverMarkets(windowMinutes: number): Promise<DiscoveredMarket[]> {
  const cfg = getConfig();
  const seriesSlug = SERIES_BY_WINDOW[windowMinutes];
  if (!seriesSlug) throw new Error(`Unsupported window: ${windowMinutes}m`);

  const url = new URL(`${cfg.GAMMA_HOST}/events`);
  url.searchParams.set("series_slug", seriesSlug);
  url.searchParams.set("closed", "false");
  url.searchParams.set("active", "true");
  url.searchParams.set("limit", "200");

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Gamma /events failed: ${resp.status} ${await resp.text()}`);
  }
  const events = (await resp.json()) as GammaEvent[];

  const now = Date.now();
  const out: DiscoveredMarket[] = [];

  for (const ev of events) {
    const endMs = Date.parse(ev.endDate);
    if (Number.isNaN(endMs) || endMs <= now) continue;

    for (const m of ev.markets ?? []) {
      if (m.closed || !m.active || !m.enableOrderBook || m.acceptingOrders === false) continue;

      let tokenIds: string[];
      let outcomes: string[];
      try {
        tokenIds = JSON.parse(m.clobTokenIds);
        outcomes = JSON.parse(m.outcomes);
      } catch (e) {
        logger.warn({ slug: m.slug }, "Failed to parse clobTokenIds/outcomes");
        continue;
      }
      if (tokenIds.length !== 2 || outcomes.length !== 2) continue;

      // Map "Up"/"Down" → yes/no token IDs.
      const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
      const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
      if (upIdx < 0 || downIdx < 0) continue;

      out.push({
        conditionId: m.conditionId,
        slug: m.slug,
        question: m.question,
        windowMinutes,
        yesTokenId: tokenIds[upIdx]!,
        noTokenId: tokenIds[downIdx]!,
        endDateIso: ev.endDate,
        tickSize: m.orderPriceMinTickSize ?? 0.01,
        minSize: m.orderMinSize ?? 5,
        negRisk: m.negRisk ?? false,
        acceptingOrders: m.acceptingOrders ?? true,
      });
    }
  }

  logger.info({ window: windowMinutes, count: out.length }, "Discovered markets");
  return out;
}

/** Upsert discovered markets into Postgres so we have a persistent record. */
export async function persistMarkets(markets: DiscoveredMarket[]): Promise<void> {
  for (const m of markets) {
    await query(
      `insert into arb.markets
         (condition_id, slug, question, asset, window_minutes, yes_token_id, no_token_id,
          end_date_iso, closed, updated_at)
       values ($1, $2, $3, 'BTC', $4, $5, $6, $7, false, now())
       on conflict (condition_id) do update set
         end_date_iso = excluded.end_date_iso,
         closed       = excluded.closed,
         updated_at   = now()`,
      [m.conditionId, m.slug, m.question, m.windowMinutes, m.yesTokenId, m.noTokenId, m.endDateIso],
    );
  }
}
