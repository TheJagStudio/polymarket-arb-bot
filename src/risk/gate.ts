import { getConfig } from "../config.js";
import { query } from "../db/client.js";
import { logger } from "../logger.js";

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Pre-trade risk check. Looks at:
 *   - today's executed (non-dry-run) trade count
 *   - currently-open exposure (sum of unsettled BUY notional)
 */
export async function canTrade(notionalUsd: number): Promise<RiskCheck> {
  const cfg = getConfig();

  const today = new Date().toISOString().slice(0, 10);

  const countRes = await query<{ trades_executed: number }>(
    `select coalesce(trades_executed, 0) as trades_executed
       from arb.daily_counters
       where day = $1`,
    [today],
  );
  const tradesToday = countRes.rows[0]?.trades_executed ?? 0;
  if (tradesToday >= cfg.MAX_DAILY_TRADES) {
    return { allowed: false, reason: `daily-cap (${tradesToday}/${cfg.MAX_DAILY_TRADES})` };
  }

  // Open exposure = sum of bot_usdc cost of orders that are 'submitted' or 'filled' but not yet
  // closed out. For this MVP we just look at recent BUY orders that haven't been
  // marked as resolved.
  const expRes = await query<{ open: string | null }>(
    `select coalesce(sum(price * shares), 0)::text as open
       from arb.orders
       where side = 'BUY'
         and dry_run = false
         and status in ('submitted', 'filled')
         and submitted_at > now() - interval '24 hours'`,
  );
  const openExposure = Number(expRes.rows[0]?.open ?? 0);
  if (openExposure + notionalUsd > cfg.MAX_OPEN_EXPOSURE_USD) {
    return {
      allowed: false,
      reason: `exposure-cap (${openExposure.toFixed(2)} + ${notionalUsd.toFixed(2)} > ${cfg.MAX_OPEN_EXPOSURE_USD})`,
    };
  }

  return { allowed: true };
}

/** Bump today's executed-trade counter (one increment per arb pair, not per leg). */
export async function bumpDailyCounter(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await query(
    `insert into arb.daily_counters (day, trades_attempted, trades_executed, updated_at)
       values ($1, 1, 1, now())
       on conflict (day) do update set
         trades_attempted = arb.daily_counters.trades_attempted + 1,
         trades_executed  = arb.daily_counters.trades_executed + 1,
         updated_at       = now()`,
    [today],
  );
}

/** Bump only the attempt counter (when an arb fires but risk denies it). */
export async function bumpAttemptCounter(reason: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await query(
    `insert into arb.daily_counters (day, trades_attempted, updated_at)
       values ($1, 1, now())
       on conflict (day) do update set
         trades_attempted = arb.daily_counters.trades_attempted + 1,
         updated_at       = now()`,
    [today],
  );
  logger.debug({ reason }, "risk denied attempt");
}
