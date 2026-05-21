# polymarket-arb-bot

Within-market arbitrage bot for Polymarket binary markets (BTC 5m / 15m windows).

**Strategy:** for each watched market, monitor `bestAsk(YES) + bestAsk(NO)`. If the sum drops at or below `ARB_THRESHOLD` (default 0.97), buy both sides in equal share size. At settlement, exactly one outcome pays $1 — locking in `1 - sum` profit per share.

## Stack

- TypeScript / Node 20+
- `@polymarket/clob-client` — official Polymarket CLOB SDK
- Postgres (Supabase, provisioned via Vercel marketplace)
- `ws` for live order-book subscriptions
- `pino` logging, `zod`-validated env

## Local development

1. `npm install`
2. `cp .env.example .env` and fill in your `PRIVATE_KEY` (and `FUNDER_ADDRESS` if you use email-login)
3. `vercel link` then connect Supabase via the Vercel dashboard, then `vercel env pull .env`
4. Apply migrations: `psql "$POSTGRES_URL_NON_POOLING" -f migrations/0001_init.sql`
5. `npm run dev`

## Deploy to a VPS

Production deployments should run on a Linux VPS with systemd — laptops sleep, lids close, ISPs blip. **Never run two bot instances against the same Postgres** — they share `arb.daily_counters`, `arb.signals`, and `arb.orders` and will race.

### 1. Provision a host

- Any provider works (Hetzner, Vultr, DigitalOcean, …). Polymarket's CLOB is Cloudflare-fronted; the origin isn't in EU, so "deploy closer for latency" isn't the win it sounds like. Measure before optimizing — the real value of a VPS here is 24/7 uptime.
- **OS:** Ubuntu 22.04 or 24.04 LTS. Avoid CentOS 7 / RHEL 7 — glibc 2.17 is too old for Node 20's prebuilt binaries.
- **Specs:** 1 vCPU, 1 GB RAM, 15 GB disk is plenty.

### 2. SSH key auth

Generate a dedicated keypair on your dev machine:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/polymarket_arb_vps_ed25519 -C polymarket-arb-bot
```

Install the **public** key on the VPS. If your terminal mangles long pastes (it sometimes injects newlines at visual wrap points), pipe the key file through `ssh` instead of pasting:

```sh
cat ~/.ssh/polymarket_arb_vps_ed25519.pub | \
  ssh root@VPS_IP 'cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'
```

Verify passwordless login, then disable password auth in `/etc/ssh/sshd_config`:

```sh
ssh -i ~/.ssh/polymarket_arb_vps_ed25519 root@VPS_IP 'echo OK'
```

### 3. Install runtime

On the VPS:

```sh
apt-get update
apt-get install -y curl ca-certificates gnupg git build-essential postgresql-client jq
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version  # expect v20.x
```

### 4. Clone, build, configure

```sh
cd /root
git clone https://github.com/sanketagarwal/polymarket-arb-bot.git
cd polymarket-arb-bot
npm ci
npm run build
```

Transfer `.env` from your dev machine — never paste secrets via chat or commit them:

```sh
# from your dev machine
scp -i ~/.ssh/polymarket_arb_vps_ed25519 .env root@VPS_IP:/root/polymarket-arb-bot/.env
ssh -i ~/.ssh/polymarket_arb_vps_ed25519 root@VPS_IP 'chmod 600 /root/polymarket-arb-bot/.env'
```

Run the preflight check:

```sh
npx tsx src/scripts/check.ts
```

You should see `✓ CLOB auth OK`, `✓ pUSD funded`, `✓ POL gas funded`, `count: 0` for open orders.

> **`SIGNATURE_TYPE=2` users (email-login proxy wallets):** the preflight will warn `Allowance < balance` and report `readyForLive: false`. **Ignore both.** Polymarket holds proxy-wallet cash internally; there is no on-chain ERC20 allowance to set. The `set-allowance.ts` script will silently no-op for these wallets. The bot's main execution path doesn't read the allowance value, and live trading works fine.

### 5. systemd service

A unit template ships at [`deploy/polymarket-arb-bot.service`](deploy/polymarket-arb-bot.service). Install and start it:

```sh
cp deploy/polymarket-arb-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now polymarket-arb-bot
systemctl status polymarket-arb-bot
```

Logs go to journald:

```sh
journalctl -u polymarket-arb-bot -f
```

### 6. Going live

`.env.example` ships with `DRY_RUN=true`. **Watch dry-run signals for at least an hour** to confirm the bot connects, receives book updates, and makes decisions matching what you expect. Then flip:

```sh
sed -i 's/^DRY_RUN=true/DRY_RUN=false/' /root/polymarket-arb-bot/.env
systemctl restart polymarket-arb-bot
journalctl -u polymarket-arb-bot -n 50 | grep -E "dryRun|threshold|sharesPerLeg"
# expect: dryRun: false
```

Kill switches, in escalating order:

| Need | Command |
|---|---|
| Revert to dry-run | edit `.env`, `DRY_RUN=true`, then `systemctl restart polymarket-arb-bot` |
| Stop the bot now | `systemctl stop polymarket-arb-bot` |
| Disable on boot | `systemctl disable polymarket-arb-bot` |

The bot also self-stops for the rest of the UTC day if realized losses exceed `MAX_DAILY_LOSS_USD`.

## Safety

- `DRY_RUN=true` is the default — no orders are submitted until you flip it.
- Hard cap on daily trade count (`MAX_DAILY_TRADES`) and open exposure (`MAX_OPEN_EXPOSURE_USD`).
- Daily-loss kill switch (`MAX_DAILY_LOSS_USD`) stops the bot if cumulative losses hit the threshold for the UTC day.
- **Never run two bot instances against the same Postgres** — they share counter tables and will race.
- This is an experimental tool. Use at your own risk; start with tiny `SHARES_PER_LEG`.
