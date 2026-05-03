import {
  getFunds, getPositions, getTrades, getDailyPnl, getBotStats, getCapital, getDecisionLog,
} from "@/lib/data";
import PnlChart from "@/components/PnlChart";

export const revalidate = 30;
export const dynamic = "force-dynamic";

const STRATEGY =
  "Buys YES + NO on Polymarket BTC 5m / 15m markets when bestAsk(YES) + bestAsk(NO) ≤ threshold — locked profit at settlement.";

export default async function Home() {
  // Each fetcher is wrapped so a single failure (RPC blip, data-api throttle)
  // doesn't 500 the whole page — render whatever loaded.
  const safe = <T,>(p: Promise<T>, fallback: T) =>
    p.catch((e) => {
      console.error("dashboard fetch failed:", e);
      return fallback;
    });
  const [funds, positions, trades, pnl, stats, decisions] = await Promise.all([
    safe(getFunds(), { pUsd: 0, pol: 0, proxy: "0x" }),
    safe(getPositions(), []),
    safe(getTrades(50), []),
    safe(getDailyPnl(), []),
    safe(getBotStats(), null),
    safe(getDecisionLog(50), []),
  ]);

  const lifetimeRealized = pnl.length > 0 ? pnl[pnl.length - 1]!.cumulative : 0;
  const todayKey = new Date().toISOString().slice(0, 10);
  const today = pnl.find((d) => d.date === todayKey);
  const openExposure = positions.reduce((s, p) => s + p.currentValue, 0);
  const capital = await getCapital(funds, pnl, positions);

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="border-b border-zinc-800 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Polymarket Arb Bot</h1>
        <p className="text-sm text-zinc-400 mt-1">{STRATEGY}</p>
        <p className="text-xs text-zinc-600 mt-2 font-mono">proxy: {funds.proxy}</p>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Starting capital" value={`$${capital.starting.toFixed(2)}`} />
        <Stat label="Current capital" value={`$${capital.current.toFixed(2)}`} tone={signTone(capital.current - capital.starting)} />
        <Stat label="Lifetime PnL" value={dollars(lifetimeRealized)} tone={signTone(lifetimeRealized)} />
        <Stat label="PnL today" value={dollars(today?.netUsd ?? 0)} tone={signTone(today?.netUsd ?? 0)} />
      </section>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="pUSD" value={`$${funds.pUsd.toFixed(2)}`} />
        <Stat label="POL (gas)" value={funds.pol.toFixed(2)} />
        <Stat label="Open exposure" value={`$${openExposure.toFixed(2)}`} />
      </section>

      {stats && (
        <section className="grid grid-cols-3 gap-3 text-xs text-zinc-500">
          <div>signals today: <span className="text-zinc-300">{stats.signals_today}</span></div>
          <div>arb hits today: <span className="text-zinc-300">{stats.arb_hits_today}</span></div>
          <div>orders today: <span className="text-zinc-300">{stats.orders_today}</span></div>
        </section>
      )}

      <section className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm uppercase tracking-wider text-zinc-400 mb-3">Cumulative pUSD PnL (30d)</h2>
        <PnlChart data={pnl} />
      </section>

      <section className="bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden">
        <h2 className="text-sm uppercase tracking-wider text-zinc-400 px-4 py-3 border-b border-zinc-800">
          Open positions ({positions.length})
        </h2>
        <Table
          empty="No open positions."
          rows={positions}
          columns={[
            { h: "Market", c: (p) => truncate(p.title, 50) },
            { h: "Outcome", c: (p) => p.outcome },
            { h: "Size", c: (p) => p.size.toFixed(2), align: "right" },
            { h: "Avg", c: (p) => `$${p.avgPrice.toFixed(2)}`, align: "right" },
            { h: "Value", c: (p) => `$${p.currentValue.toFixed(2)}`, align: "right" },
            { h: "PnL", c: (p) => dollars(p.cashPnl), align: "right", tone: (p) => signTone(p.cashPnl) },
          ]}
        />
      </section>

      <section className="bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden">
        <h2 className="text-sm uppercase tracking-wider text-zinc-400 px-4 py-3 border-b border-zinc-800">
          Decision log ({decisions.length})
        </h2>
        <Table
          empty="No threshold-hits yet — book sums sitting above the configured edge."
          rows={decisions}
          columns={[
            { h: "Time", c: (d) => new Date(d.observedAt).toLocaleString() },
            { h: "Window", c: (d) => (d.windowMinutes ? `${d.windowMinutes}m` : "—") },
            { h: "Yes ask", c: (d) => `$${d.yesAsk.toFixed(3)}`, align: "right" },
            { h: "No ask", c: (d) => `$${d.noAsk.toFixed(3)}`, align: "right" },
            { h: "Sum", c: (d) => `$${d.sumAsk.toFixed(3)}`, align: "right" },
            { h: "Edge", c: (d) => `$${d.edge.toFixed(3)}`, align: "right", tone: (d) => signTone(d.edge) },
            { h: "Decision", c: (d) => d.decision.toUpperCase(), tone: (d) => (d.decision === "executed" ? "pos" : "neg") },
            { h: "Reasoning", c: (d) => d.reasoning },
            { h: "Orders", c: (d) => (d.orderCount > 0 ? `${d.orderCount} ${d.orderStatus ?? ""}`.trim() : "—") },
          ]}
        />
      </section>

      <section className="bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden">
        <h2 className="text-sm uppercase tracking-wider text-zinc-400 px-4 py-3 border-b border-zinc-800">
          Recent trades ({trades.length})
        </h2>
        <Table
          empty="No trades yet."
          rows={trades}
          columns={[
            { h: "Time", c: (t) => new Date(t.timestamp * 1000).toLocaleString() },
            { h: "Market", c: (t) => truncate(t.title, 50) },
            { h: "Side", c: (t) => t.side, tone: (t) => (t.side === "BUY" ? "pos" : "neg") },
            { h: "Outcome", c: (t) => t.outcome },
            { h: "Size", c: (t) => t.size.toFixed(2), align: "right" },
            { h: "Price", c: (t) => `$${t.price.toFixed(2)}`, align: "right" },
          ]}
        />
      </section>

      <footer className="text-xs text-zinc-600 pt-4 border-t border-zinc-800">
        Auto-refreshes every 30s. Data from Polymarket data-api + Polygon RPC + local Postgres.
      </footer>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  const color = tone === "pos" ? "text-green-400" : tone === "neg" ? "text-red-400" : "text-zinc-100";
  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
      <div className="text-xs text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-semibold tabular-nums mt-1 ${color}`}>{value}</div>
    </div>
  );
}

interface Col<T> {
  h: string;
  c: (row: T) => string;
  align?: "left" | "right";
  tone?: (row: T) => "pos" | "neg" | undefined;
}
function Table<T>({ rows, columns, empty }: { rows: T[]; columns: Col<T>[]; empty: string }) {
  if (rows.length === 0) {
    return <div className="px-4 py-8 text-zinc-500 text-sm text-center">{empty}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wider text-zinc-500">
          <tr className="border-b border-zinc-800">
            {columns.map((c) => (
              <th key={c.h} className={`px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"}`}>
                {c.h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-zinc-900 last:border-0 hover:bg-zinc-900/40">
              {columns.map((c) => {
                const tone = c.tone?.(row);
                const color = tone === "pos" ? "text-green-400" : tone === "neg" ? "text-red-400" : "";
                return (
                  <td
                    key={c.h}
                    className={`px-3 py-2 tabular-nums ${c.align === "right" ? "text-right" : ""} ${color}`}
                  >
                    {c.c(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function dollars(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}
function signTone(n: number): "pos" | "neg" | undefined {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return undefined;
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
