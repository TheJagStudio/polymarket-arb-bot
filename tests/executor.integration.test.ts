import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration-ish test for the executor's BUY-then-orphan path.
 *
 * Mocks the SDK client + DB + risk gate, then drives `evaluate()` with a
 * book update and verifies that:
 *   - When the SDK returns the broken 0-takingAmount response (the live
 *     bug), placeLeg() still derives a non-zero share count.
 *   - When one leg fills and the other rejects, the unwind SELL is called
 *     with the derived share count (NOT 0).
 *
 * This is the load-bearing safety check — without it, the orphan flattener
 * silently does nothing and we hold positions to settlement.
 */

// ── Config / DB / logger / risk-gate mocks ──────────────────────────────────

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
  DRY_RUN: false, // so we hit the real placeLeg path
  LOG_LEVEL: "info" as const,
};

vi.mock("../src/config.js", () => ({
  getConfig: () => cfgFixture,
  resolveFunder: (_cfg: unknown, addr: string) => addr,
}));

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(async (sql: string) => {
    if (/insert into arb\.signals/.test(sql)) {
      return { rows: [{ id: "signal_test_1" }] };
    }
    if (/from arb\.orders[\s\S]*status = 'matched'/.test(sql)) {
      return { rows: [{ n: "0" }] };
    }
    return { rows: [] };
  }),
}));
vi.mock("../src/db/client.js", () => ({ query: queryMock }));

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

// Always allow trades — risk-gate logic is exhaustively covered in gate.test.ts.
vi.mock("../src/risk/gate.js", () => ({
  canTrade: vi.fn(async () => ({ allowed: true })),
  bumpAttemptCounter: vi.fn(async () => {}),
  bumpDailyCounter: vi.fn(async () => {}),
}));

// Programmable SDK mock — we override per-test.
const { createAndPostMarketOrderMock } = vi.hoisted(() => ({
  createAndPostMarketOrderMock: vi.fn(),
}));
vi.mock("../src/clob/client.js", () => ({
  getClobClient: vi.fn(async () => ({
    client: { createAndPostMarketOrder: createAndPostMarketOrderMock },
    address: "0x" + "33".repeat(20),
  })),
}));

// ── Module under test ──────────────────────────────────────────────────────

import { evaluate } from "../src/exec/executor.js";
import type { BookUpdate } from "../src/clob/marketWs.js";

const FUTURE = new Date(Date.now() + 10 * 60_000).toISOString();

const baseBookUpdate: BookUpdate = {
  conditionId: "0xabc",
  yesTokenId: "tok_yes",
  noTokenId: "tok_no",
  windowMinutes: 5,
  endDateIso: FUTURE,
  yes: { bestBid: null, bestAsk: 0.45, updatedAt: 0 },
  no: { bestBid: null, bestAsk: 0.5, updatedAt: 0 },
};

beforeEach(() => {
  createAndPostMarketOrderMock.mockReset();
  queryMock.mockClear();
  // Use a fresh conditionId per test to bypass the inflight-cooldown set.
  baseBookUpdate.conditionId = `0x${Math.random().toString(16).slice(2)}`;
});

describe("evaluate — orphan flattener with the broken-SDK-response shape", () => {
  it("when YES fills (with 0 takingAmount) and NO rejects, SELL is called with derived shares", async () => {
    // Simulate the live bug: API returns success+matched but zero
    // takingAmount. makingAmount has the spent USDC.
    createAndPostMarketOrderMock.mockImplementation(async (order) => {
      if (order.tokenID === "tok_yes" && order.side === "BUY") {
        return {
          success: true,
          status: "matched",
          orderID: "order_yes_buy",
          takingAmount: "0",
          makingAmount: "4500000", // $4.50 spent
        };
      }
      if (order.tokenID === "tok_no" && order.side === "BUY") {
        return {
          success: false,
          status: "rejected",
          errorMsg: "not enough liquidity",
          orderID: "order_no_buy",
          takingAmount: "0",
          makingAmount: "0",
        };
      }
      // The SELL unwind on YES.
      if (order.tokenID === "tok_yes" && order.side === "SELL") {
        return {
          success: true,
          status: "matched",
          orderID: "order_yes_sell",
          takingAmount: "4400000", // $4.40 received
          makingAmount: "10000000", // 10 shares sold
        };
      }
      throw new Error(`unexpected order: ${JSON.stringify(order)}`);
    });

    await evaluate(baseBookUpdate);

    // 3 calls expected: BUY YES, BUY NO, SELL YES (the unwind).
    expect(createAndPostMarketOrderMock).toHaveBeenCalledTimes(3);

    const sellCall = createAndPostMarketOrderMock.mock.calls.find(
      (call) => call[0].side === "SELL",
    );
    expect(sellCall).toBeDefined();
    // The bug: previously we'd SELL amount=0 here. Fixed: amount equals
    // the derived share count from $4.50 spent / $0.45 price = 10 shares.
    expect(sellCall![0].amount).toBe(10);
    expect(sellCall![0].tokenID).toBe("tok_yes");
  });

  it("when NO fills (with 0 takingAmount) and YES rejects, SELL flattens NO with derived shares", async () => {
    createAndPostMarketOrderMock.mockImplementation(async (order) => {
      if (order.tokenID === "tok_yes" && order.side === "BUY") {
        return { success: false, status: "rejected", errorMsg: "no fill" };
      }
      if (order.tokenID === "tok_no" && order.side === "BUY") {
        return {
          success: true,
          status: "matched",
          orderID: "order_no_buy",
          takingAmount: "", // empty string — triggers fallback
          makingAmount: "5000000", // $5.00 spent
        };
      }
      if (order.tokenID === "tok_no" && order.side === "SELL") {
        return { success: true, status: "matched", orderID: "order_no_sell" };
      }
      throw new Error(`unexpected: ${JSON.stringify(order)}`);
    });

    await evaluate(baseBookUpdate);

    const sellCall = createAndPostMarketOrderMock.mock.calls.find(
      (call) => call[0].side === "SELL",
    );
    expect(sellCall).toBeDefined();
    // $5.00 / $0.50 = 10 shares.
    expect(sellCall![0].amount).toBe(10);
    expect(sellCall![0].tokenID).toBe("tok_no");
  });

  it("when both BUY legs fully reject, no SELL is attempted", async () => {
    createAndPostMarketOrderMock.mockResolvedValue({
      success: false,
      status: "rejected",
      errorMsg: "no fill",
    });

    await evaluate(baseBookUpdate);

    // Two BUY calls, no SELL.
    expect(createAndPostMarketOrderMock).toHaveBeenCalledTimes(2);
    expect(
      createAndPostMarketOrderMock.mock.calls.every((c) => c[0].side === "BUY"),
    ).toBe(true);
  });

  it("when both BUY legs fill (even with broken takingAmount), no SELL is attempted", async () => {
    createAndPostMarketOrderMock.mockImplementation(async (order) => {
      if (order.side === "BUY") {
        return {
          success: true,
          status: "matched",
          orderID: `order_${order.tokenID}`,
          takingAmount: "0", // broken
          makingAmount: order.tokenID === "tok_yes" ? "4500000" : "5000000",
        };
      }
      throw new Error("SELL should not be called when both legs filled");
    });

    await evaluate(baseBookUpdate);

    expect(createAndPostMarketOrderMock).toHaveBeenCalledTimes(2);
  });

  it("when even the fallbacks yield 0 (rejected status), no SELL is attempted", async () => {
    // YES "matches" but with totally zero amounts — yet status is something
    // we don't trust as a fill (e.g. 'submitted'). filledShares should be
    // 0, the leg is treated as not filled, and no orphan emerges.
    createAndPostMarketOrderMock.mockImplementation(async (order) => {
      if (order.tokenID === "tok_yes") {
        return {
          success: true,
          status: "submitted", // not 'matched'/'filled' — don't claim a fill
          takingAmount: "0",
          makingAmount: "0",
        };
      }
      if (order.tokenID === "tok_no") {
        return { success: false, status: "rejected" };
      }
      throw new Error(`unexpected: ${JSON.stringify(order)}`);
    });

    await evaluate(baseBookUpdate);

    expect(createAndPostMarketOrderMock).toHaveBeenCalledTimes(2);
    expect(
      createAndPostMarketOrderMock.mock.calls.every((c) => c[0].side === "BUY"),
    ).toBe(true);
  });
});
