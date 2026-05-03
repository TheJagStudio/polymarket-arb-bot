import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Polymarket Arb Bot",
  description: "BTC 5m/15m within-market arbitrage tracker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
