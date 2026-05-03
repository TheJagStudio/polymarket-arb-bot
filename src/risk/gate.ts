import { createPublicClient, http, formatUnits, erc20Abi, type Address } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getConfig, resolveFunder } from "../config.js";
import { query } from "../db/client.js";
import { logger } from "../logger.js";

const PUSD_ADDR = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
let _rpc: ReturnType<typeof createPublicClient> | null = null;
function rpc() {
  if (!_rpc) _rpc = createPublicClient({ chain: polygon, transport: http() });
  return _rpc;
}

/** Read on-chain pUSD balance of the funder (proxy). */
async function fetchPusdBalance(): Promise<number> {
  const cfg = getConfig();
  const account = privateKeyToAccount(cfg.PRIVATE_KEY as `0x${string}`);
  const funder = resolveFunder(cfg, account.address) as Address;
  const bal = await rpc().readContract({
    address: PUSD_ADDR,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [funder],
  });
  return Number(formatUnits(bal, 6));
}

/**
 * Snapshot today's opening pUSD balance once per day. If a snapshot already
 * exists, returns the stored value. Returns null on RPC failure (caller
 * should fail-open in that rare case).
 */
async function getOpeningPusd(): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await query<{ opening_pusd: string }>(
    `select opening_pusd from arb.daily_balance_snapshot where day = $1`,
    [today],
  );
  if (existing.rows[0]) return Number(existing.rows[0].opening_pusd);

  let bal: number;
  try {
    bal = await fetchPusdBalance();
  } catch {
    return null;
  }
  await query(
    `insert into arb.daily_balance_snapshot (day, opening_pusd) values ($1, $2)
     on conflict (day) do nothing`,
    [today, bal],
  );
  return bal;
}

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

  // Daily-loss kill switch: snapshot opening pUSD; if drawdown exceeds cap, halt.
  const opening = await getOpeningPusd();
  if (opening !== null) {
    let current: number;
    try {
      current = await fetchPusdBalance();
    } catch {
      return { allowed: true }; // fail-open on RPC blip
    }
    const drawdown = opening - current;
    if (drawdown > cfg.MAX_DAILY_LOSS_USD) {
      return { allowed: false, reason: `dl` }; // intentionally terse
    }
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
