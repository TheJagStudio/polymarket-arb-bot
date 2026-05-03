-- Polymarket arb bot — initial schema.
-- Apply via: psql "$POSTGRES_URL_NON_POOLING" -f migrations/0001_init.sql

create schema if not exists arb;

-- One row per binary market we're watching.
create table if not exists arb.markets (
    condition_id        text primary key,
    slug                text not null,
    question            text,
    asset               text not null,                     -- 'BTC'
    window_minutes      smallint not null,                 -- 5 or 15
    yes_token_id        text not null,
    no_token_id         text not null,
    end_date_iso        timestamptz,
    closed              boolean not null default false,
    discovered_at       timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_markets_active
    on arb.markets (closed, end_date_iso);

-- Every time the detector evaluates a market and the threshold is hit.
create table if not exists arb.signals (
    id                  bigserial primary key,
    condition_id        text not null references arb.markets(condition_id),
    observed_at         timestamptz not null default now(),
    yes_best_ask        numeric(10, 6) not null,
    no_best_ask         numeric(10, 6) not null,
    sum_ask             numeric(10, 6) generated always as (yes_best_ask + no_best_ask) stored,
    threshold           numeric(10, 6) not null,
    edge                numeric(10, 6) generated always as (1 - (yes_best_ask + no_best_ask)) stored,
    would_execute       boolean not null,
    skipped_reason      text                                -- populated when would_execute = false
);

create index if not exists idx_signals_condition_observed
    on arb.signals (condition_id, observed_at desc);

-- Every order the bot tries to submit (dry-run rows included, marked as such).
create table if not exists arb.orders (
    id                  bigserial primary key,
    signal_id           bigint references arb.signals(id),
    condition_id        text not null,
    token_id            text not null,
    side                text not null check (side in ('BUY', 'SELL')),
    leg                 text not null check (leg in ('YES', 'NO')),
    price               numeric(10, 6) not null,
    shares              numeric(20, 6) not null,
    order_type          text not null default 'FOK',        -- FOK / GTC / GTD
    dry_run             boolean not null,
    status              text not null,                      -- 'submitted' | 'filled' | 'rejected' | 'cancelled' | 'dry_run'
    clob_order_id       text,
    error_message       text,
    submitted_at        timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_orders_condition  on arb.orders (condition_id);
create index if not exists idx_orders_clob_id    on arb.orders (clob_order_id);
create index if not exists idx_orders_submitted  on arb.orders (submitted_at desc);

-- Fills observed via user WS (for reconciliation + PnL).
create table if not exists arb.fills (
    id                  bigserial primary key,
    clob_order_id       text not null,
    token_id            text not null,
    side                text not null,
    price               numeric(10, 6) not null,
    shares              numeric(20, 6) not null,
    fee                 numeric(20, 6) not null default 0,
    tx_hash             text,
    filled_at           timestamptz not null default now(),
    raw                 jsonb
);

create index if not exists idx_fills_order  on arb.fills (clob_order_id);
create index if not exists idx_fills_time   on arb.fills (filled_at desc);

-- Materialized current position per token. Maintained by the executor.
create table if not exists arb.positions (
    token_id            text primary key,
    condition_id        text not null,
    leg                 text not null check (leg in ('YES', 'NO')),
    shares              numeric(20, 6) not null default 0,
    avg_cost            numeric(10, 6) not null default 0,
    realized_pnl        numeric(20, 6) not null default 0,
    updated_at          timestamptz not null default now()
);

-- Daily counter to enforce MAX_DAILY_TRADES.
create table if not exists arb.daily_counters (
    day                 date primary key,
    trades_attempted    int  not null default 0,
    trades_executed     int  not null default 0,
    open_exposure_usd   numeric(20, 6) not null default 0,
    updated_at          timestamptz not null default now()
);
