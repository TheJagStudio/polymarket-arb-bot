# polymarket-arb-bot

Within-market arbitrage bot for Polymarket binary markets (BTC 5m / 15m windows).

**Strategy:** for each watched market, monitor `bestAsk(YES) + bestAsk(NO)`. If the sum drops at or below `ARB_THRESHOLD` (default 0.97), buy both sides in equal share size. At settlement, exactly one outcome pays $1 — locking in `1 - sum` profit per share.

## Stack

- TypeScript / Node 20+
- `@polymarket/clob-client` — official Polymarket CLOB SDK
- Postgres (Supabase, provisioned via Vercel marketplace)
- `ws` for live order-book subscriptions
- `pino` logging, `zod`-validated env

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in your `PRIVATE_KEY` (and `FUNDER_ADDRESS` if you use email-login)
3. `vercel link` then connect Supabase via the Vercel dashboard, then `vercel env pull .env`
4. Apply migrations: `psql "$POSTGRES_URL_NON_POOLING" -f migrations/0001_init.sql`
5. `npm run dev`

## Safety

- `DRY_RUN=true` is the default — no orders are submitted until you flip it.
- Hard cap on daily trade count (`MAX_DAILY_TRADES`) and open exposure (`MAX_OPEN_EXPOSURE_USD`).
- This is an experimental tool. Use at your own risk; start with tiny `SHARES_PER_LEG`.
