import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be declared before importing the module under test) ─────────

// Stub config to skip dotenv/private-key parsing.
const cfgFixture = {
  PRIVATE_KEY: "0x" + "11".repeat(32),
  WALLET_ADDRESS: "0x" + "22".repeat(20),
  SIGNATURE_TYPE: 0,
  FUNDER_ADDRESS: undefined,
  CLOB_HOST: "https://example.com",
  GAMMA_HOST: "https://example.com",
  DATA_API_HOST: "https://example.com",
  MARKET_WS_URL: "wss://example.com",
  USER_WS_URL: "wss://example.com",
  CHAIN_ID: 137,
  POSTGRES_URL: "postgres://x",
  POSTGRES_URL_NON_POOLING: "postgres://x",
  ARB_THRESHOLD: 0.97,
  SHARES_PER_LEG: 10,
  MAX_DAILY_TRADES: 20,
  MAX_OPEN_EXPOSURE_USD: 200,
  MAX_DAILY_LOSS_USD: 20,
  WINDOW_MINUTES: [5, 15],
  DRY_RUN: true,
  LOG_LEVEL: "info" as const,
};

vi.mock("../src/config.js", () => ({
  getConfig: () => cfgFixture,
  resolveFunder: (_cfg: unknown, addr: string) => addr,
}));

// Programmable rows-by-SQL-fragment lookup.
const { queryRows } = vi.hoisted(() => ({
  queryRows: [] as Array<{ match: RegExp; rows: unknown[] }>,
}));

vi.mock("../src/db/client.js", () => ({
  query: vi.fn(async (sql: string) => {
    for (const { match, rows } of queryRows) {
      if (match.test(sql)) return { rows };
    }
    return { rows: [] };
  }),
}));

// Logger stub — silence pino so tests don't spew.
vi.mock("../src/logger.js", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  },
}));

// Mock the viem chain module so creating the public client doesn't try
// to open an HTTP transport. We only need rpc().readContract() to be
// stubbed, which we do via a separate mock surface.
const { readContractMock } = vi.hoisted(() => ({ readContractMock: vi.fn() }));
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: () => ({ readContract: readContractMock }),
    http: () => undefined,
  };
});

// privateKeyToAccount used by gate.ts to derive funder address.
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({ address: "0x" + "33".repeat(20) }),
}));

// ── Module under test ──────────────────────────────────────────────────────

import { canTrade } from "../src/risk/gate.js";

beforeEach(() => {
  queryRows.length = 0;
  readContractMock.mockReset();
  // Default: balance is healthy (well above any drawdown trigger).
  readContractMock.mockResolvedValue(1_000_000_000n); // 1000 pUSD (6 decimals)
});

// Helpers to seed the query mock.
function seedTradesToday(n: number) {
  queryRows.push({
    match: /from arb\.daily_counters/,
    rows: [{ trades_executed: n }],
  });
}
function seedOpenExposure(usd: number) {
  queryRows.push({
    match: /from arb\.orders[\s\S]*side = 'BUY'/,
    rows: [{ open: usd.toString() }],
  });
}
function seedOpeningSnapshot(opening: number | null) {
  queryRows.push({
    match: /from arb\.daily_balance_snapshot/,
    rows: opening == null ? [] : [{ opening_pusd: opening.toString() }],
  });
  // Insert-on-conflict no-op; harmless.
  queryRows.push({ match: /insert into arb\.daily_balance_snapshot/, rows: [] });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("canTrade — daily-trade-cap", () => {
  it("blocks when trades_executed has reached MAX_DAILY_TRADES", async () => {
    seedTradesToday(20);
    seedOpenExposure(0);
    seedOpeningSnapshot(1000);

    const r = await canTrade(5);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/daily-cap \(20\/20\)/);
  });

  it("blocks when trades_executed exceeds MAX_DAILY_TRADES (defensive)", async () => {
    seedTradesToday(25);
    seedOpenExposure(0);
    seedOpeningSnapshot(1000);

    const r = await canTrade(5);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/daily-cap \(25\/20\)/);
  });

  it("allows at one below cap", async () => {
    seedTradesToday(19);
    seedOpenExposure(0);
    seedOpeningSnapshot(1000);

    const r = await canTrade(5);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

describe("canTrade — exposure-cap", () => {
  it("blocks when openExposure + new > MAX_OPEN_EXPOSURE_USD", async () => {
    seedTradesToday(0);
    seedOpenExposure(195);
    seedOpeningSnapshot(1000);

    // 195 + 6 = 201 > 200
    const r = await canTrade(6);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/exposure-cap/);
    expect(r.reason).toMatch(/195\.00 \+ 6\.00 > 200/);
  });

  it("allows when openExposure + new equals the cap", async () => {
    seedTradesToday(0);
    seedOpenExposure(195);
    seedOpeningSnapshot(1000);

    const r = await canTrade(5); // 195 + 5 = 200 (not >)
    expect(r.allowed).toBe(true);
  });

  it("allows when no current open exposure", async () => {
    seedTradesToday(0);
    seedOpenExposure(0);
    seedOpeningSnapshot(1000);

    const r = await canTrade(50);
    expect(r.allowed).toBe(true);
  });
});

describe("canTrade — daily-loss kill switch", () => {
  it("blocks when drawdown exceeds MAX_DAILY_LOSS_USD", async () => {
    seedTradesToday(0);
    seedOpenExposure(0);
    seedOpeningSnapshot(1000); // opened at $1000

    // current balance = $975 → drawdown = $25 > $20 cap
    readContractMock.mockResolvedValue(975_000_000n);

    const r = await canTrade(5);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("dl");
  });

  it("allows when drawdown is exactly at the cap (not >)", async () => {
    seedTradesToday(0);
    seedOpenExposure(0);
    seedOpeningSnapshot(1000);
    readContractMock.mockResolvedValue(980_000_000n); // drawdown = $20 (not >$20)

    const r = await canTrade(5);
    expect(r.allowed).toBe(true);
  });

  it("allows when no opening snapshot can be obtained (fail-open)", async () => {
    seedTradesToday(0);
    seedOpenExposure(0);
    seedOpeningSnapshot(null);
    // Snapshot fetch will fail (RPC throws).
    readContractMock.mockRejectedValueOnce(new Error("rpc down"));
    // Subsequent fetch (current balance check) wouldn't happen because
    // opening returned null.

    const r = await canTrade(5);
    expect(r.allowed).toBe(true);
  });

  it("fails open on transient RPC blip when fetching current balance", async () => {
    seedTradesToday(0);
    seedOpenExposure(0);
    seedOpeningSnapshot(1000); // opening already cached in DB
    // Current-balance fetch throws.
    readContractMock.mockRejectedValueOnce(new Error("rpc blip"));

    const r = await canTrade(5);
    expect(r.allowed).toBe(true);
  });
});

describe("canTrade — precedence", () => {
  it("daily-cap is checked before exposure-cap", async () => {
    seedTradesToday(20);          // would block
    seedOpenExposure(195);        // would also block
    seedOpeningSnapshot(1000);

    const r = await canTrade(50);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/daily-cap/);
  });

  it("exposure-cap is checked before drawdown kill switch", async () => {
    seedTradesToday(0);
    seedOpenExposure(195);        // would block
    seedOpeningSnapshot(1000);
    readContractMock.mockResolvedValue(900_000_000n); // would also block via drawdown

    const r = await canTrade(50);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/exposure-cap/);
  });
});
