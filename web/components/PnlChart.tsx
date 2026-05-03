"use client";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { DailyPnl } from "@/lib/data";

export default function PnlChart({ data }: { data: DailyPnl[] }) {
  if (data.length === 0) {
    return (
      <div className="text-zinc-500 text-sm py-12 text-center">
        No on-chain pUSD activity in the last 30 days yet — once trades resolve, daily PnL will plot here.
      </div>
    );
  }
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" />
          <XAxis dataKey="date" stroke="#999" tick={{ fontSize: 11 }} />
          <YAxis
            stroke="#999"
            tick={{ fontSize: 11 }}
            domain={["dataMin - 0.05", "dataMax + 0.05"]}
            tickFormatter={(v) => (Math.abs(v) < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(2)}`)}
          />
          <Tooltip
            contentStyle={{ background: "#111", border: "1px solid #333", color: "#eee" }}
            formatter={(v: number) => [`$${v.toFixed(2)}`, "Cumulative"]}
          />
          <Line type="monotone" dataKey="cumulative" stroke="#22c55e" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
