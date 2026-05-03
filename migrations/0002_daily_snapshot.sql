-- Snapshot of pUSD balance at the start of each day. Used by the risk gate
-- to enforce a daily-loss kill switch.
create table if not exists arb.daily_balance_snapshot (
    day              date primary key,
    opening_pusd     numeric(20, 6) not null,
    snapshotted_at   timestamptz not null default now()
);
