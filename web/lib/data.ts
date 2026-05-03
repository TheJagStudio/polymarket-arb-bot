import "server-only";
import { createPublicClient, http, formatUnits, formatEther, erc20Abi, type Address } from "viem";
import { polygon } from "viem/chains";
import { Pool } from "pg";

const PROXY = (process.env.NEXT_PUBLIC_PROXY ?? "0x1a729eA76b63d309Da1f19ceD4f729d933461308") as Address;
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
const DATA_API = process.env.DATA_API_HOST ?? "https://data-api.polymarket.com";
const POLYGONSCAN_KEY = process.env.POLYGONSCAN_API_KEY; // optional, for richer history

const rpc = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_RPC_URL) });

const cleanPgUrl = (process.env.POSTGRES_URL ?? "")
  .replace(/[?&]sslmode=[^&]*/, "")
  .replace(/[?&]supa=[^&]*/, "");
const pool = cleanPgUrl
  ? new Pool({ connectionString: cleanPgUrl, ssl: { rejectUnauthorized: false }, max: 2 })
  : null;

export interface FundsSnapshot {
  pUsd: number;
  pol: number;
  proxy: string;
}

export async function getFunds(): Promise<FundsSnapshot> {
  const [bal, pol] = await Promise.all([
    rpc.readContract({ address: PUSD, abi: erc20Abi, functionName: "balanceOf", args: [PROXY] }),
    rpc.getBalance({ address: PROXY }),
  ]);
  return {
    pUsd: Number(formatUnits(bal, 6)),
    pol: Number(formatEther(pol)),
    proxy: PROXY,
  };
}

export interface Position {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

export async function getPositions(): Promise<Position[]> {
  const r = await fetch(`${DATA_API}/positions?user=${PROXY}&sizeThreshold=0&limit=100`, {
    next: { revalidate: 30 },
  });
  if (!r.ok) return [];
  const arr = await r.json();
  return (arr as Array<Record<string, unknown>>).map((p) => ({
    conditionId: String(p.conditionId ?? ""),
    title: String(p.title ?? ""),
    outcome: String(p.outcome ?? ""),
    size: Number(p.size ?? 0),
    avgPrice: Number(p.avgPrice ?? 0),
    currentValue: Number(p.currentValue ?? 0),
    cashPnl: Number(p.cashPnl ?? 0),
    percentPnl: Number(p.percentPnl ?? 0),
  }));
}

export interface Trade {
  timestamp: number;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  outcome: string;
  title: string;
  conditionId: string;
  txHash: string;
}

export async function getTrades(limit = 50): Promise<Trade[]> {
  const r = await fetch(`${DATA_API}/trades?user=${PROXY}&limit=${limit}`, {
    next: { revalidate: 30 },
  });
  if (!r.ok) return [];
  const arr = await r.json();
  return (arr as Array<Record<string, unknown>>).map((t) => ({
    timestamp: Number(t.timestamp ?? 0),
    side: (t.side as "BUY" | "SELL") ?? "BUY",
    size: Number(t.size ?? 0),
    price: Number(t.price ?? 0),
    outcome: String(t.outcome ?? ""),
    title: String(t.title ?? ""),
    conditionId: String(t.conditionId ?? ""),
    txHash: String(t.transactionHash ?? ""),
  }));
}

export interface DailyPnl {
  date: string; // YYYY-MM-DD
  netUsd: number; // signed change in pUSD that day
  cumulative: number; // running sum from start
}

/**
 * Compute daily PnL using Polymarket's user-activity endpoint, which
 * surfaces TRADE, SPLIT, MERGE, REDEEM events with usdcSize. Net flow per
 * day is the sum of signed deltas, then we cumulate.
 */
export async function getDailyPnl(): Promise<DailyPnl[]> {
  const r = await fetch(`${DATA_API}/activity?user=${PROXY}&limit=500`, {
    next: { revalidate: 60 },
  });
  if (!r.ok) return [];
  const arr = (await r.json()) as Array<Record<string, unknown>>;

  const byDay = new Map<string, number>();
  for (const a of arr) {
    const ts = Number(a.timestamp ?? 0);
    if (!ts) continue;
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    const usd = Number(a.usdcSize ?? 0);
    const type = String(a.type ?? "");
    const side = String(a.side ?? "");
    let delta = 0;
    if (type === "TRADE") delta = side === "BUY" ? -usd : +usd;
    else if (type === "REDEEM") delta = +usd;
    else if (type === "SPLIT") delta = -usd;
    else if (type === "MERGE") delta = +usd;
    if (delta === 0) continue;
    byDay.set(date, (byDay.get(date) ?? 0) + delta);
  }
  if (byDay.size === 0) return [];

  const rows: DailyPnl[] = [];
  let cum = 0;
  for (const date of [...byDay.keys()].sort()) {
    const net = byDay.get(date)!;
    cum += net;
    rows.push({ date, netUsd: net, cumulative: cum });
  }
  return rows;
}

export interface BotStats {
  signals_today: number;
  arb_hits_today: number;
  orders_today: number;
}

export async function getBotStats(): Promise<BotStats | null> {
  if (!pool) return null;
  try {
    const r = await pool.query<{
      signals_today: string;
      arb_hits_today: string;
      orders_today: string;
    }>(`
      select
        (select count(*) from arb.signals where observed_at::date = current_date)::text as signals_today,
        (select count(*) from arb.signals where observed_at::date = current_date and would_execute)::text as arb_hits_today,
        (select count(*) from arb.orders where submitted_at::date = current_date)::text as orders_today
    `);
    const row = r.rows[0];
    if (!row) return null;
    return {
      signals_today: Number(row.signals_today),
      arb_hits_today: Number(row.arb_hits_today),
      orders_today: Number(row.orders_today),
    };
  } catch {
    return null;
  }
}
