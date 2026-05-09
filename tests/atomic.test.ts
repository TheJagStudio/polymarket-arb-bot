import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub config/logger BEFORE importing the module under test (vitest hoists vi.mock).
vi.mock("../src/config.js", () => ({
  getConfig: () => ({
    PRIVATE_KEY: "0x" + "1".repeat(64),
    SIGNATURE_TYPE: 0,
    CLOB_HOST: "https://clob.polymarket.com",
    CHAIN_ID: 137,
    DRY_RUN: false,
    STRATEGY_MODE: "atomic",
    ATOMIC_LEG_A_TIMEOUT_MS: 1_000,
    ATOMIC_POLL_MS: 50,
  }),
  resolveFunder: () => "0x" + "a".repeat(40),
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockClient = {
  createAndPostOrder: vi.fn(),
  createAndPostMarketOrder: vi.fn(),
  getOrder: vi.fn(),
  cancelOrder: vi.fn(),
};

vi.mock("../src/clob/client.js", () => ({
  getClobClient: async () => ({ client: mockClient, address: "0x" + "0".repeat(40) }),
}));

import { executeAtomic } from "../src/exec/atomic.js";

describe("executeAtomic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns abandoned when leg A is rejected on placement", async () => {
    mockClient.createAndPostOrder.mockResolvedValue({ success: false, errorMsg: "no liquidity" });

    const result = await executeAtomic({
      yesTokenId: "yes",
      noTokenId: "no",
      askYes: 0.4,
      askNo: 0.5,
      shares: 5,
    });

    expect(result.abandoned).toBe(true);
    expect(result.bothFilled).toBe(false);
    expect(result.orphan).toBeUndefined();
    expect(mockClient.createAndPostMarketOrder).not.toHaveBeenCalled();
  });

  it("returns abandoned when leg A throws", async () => {
    mockClient.createAndPostOrder.mockRejectedValue(new Error("network"));

    const result = await executeAtomic({
      yesTokenId: "yes",
      noTokenId: "no",
      askYes: 0.4,
      askNo: 0.5,
      shares: 5,
    });

    expect(result.abandoned).toBe(true);
    expect(result.legA.status).toBe("threw");
  });

  it("times out leg A and cancels when poll never sees a fill", async () => {
    mockClient.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xA",
      status: "live",
    });
    mockClient.getOrder.mockResolvedValue({ status: "live", size_matched: "0" });
    mockClient.cancelOrder.mockResolvedValue({ canceled: ["0xA"] });

    const result = await executeAtomic({
      yesTokenId: "yes",
      noTokenId: "no",
      askYes: 0.4,
      askNo: 0.5,
      shares: 5,
    });

    expect(result.abandoned).toBe(true);
    expect(result.bothFilled).toBe(false);
    expect(mockClient.cancelOrder).toHaveBeenCalledWith({ orderID: "0xA" });
    expect(mockClient.createAndPostMarketOrder).not.toHaveBeenCalled();
  });

  it("fires leg B FOK after leg A fills via polling, both succeed → bothFilled", async () => {
    mockClient.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xA",
      status: "live",
    });
    // First poll = unfilled, second poll = filled.
    mockClient.getOrder
      .mockResolvedValueOnce({ status: "live", size_matched: "0" })
      .mockResolvedValueOnce({ status: "matched", size_matched: "5" });
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: true,
      orderID: "0xB",
      status: "matched",
      takingAmount: "5000000",
      makingAmount: "2500000",
    });

    const result = await executeAtomic({
      yesTokenId: "yes",
      noTokenId: "no",
      askYes: 0.4, // cheaper → leg A
      askNo: 0.5,
      shares: 5,
    });

    expect(result.bothFilled).toBe(true);
    expect(result.abandoned).toBe(false);
    expect(result.orphan).toBeUndefined();
    expect(result.legA.filled).toBe(true);
    expect(result.legA.filledShares).toBe(5);
    expect(result.legB?.filled).toBe(true);
    // Leg B sized to mirror leg A's fill: shares × askNo = 5 × 0.5 = 2.5
    expect(mockClient.createAndPostMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2.5, side: "BUY" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns orphan when leg A fills but leg B is rejected", async () => {
    mockClient.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xA",
      status: "live",
    });
    mockClient.getOrder.mockResolvedValue({ status: "matched", size_matched: "5" });
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: false,
      errorMsg: "not enough liquidity",
    });

    const result = await executeAtomic({
      yesTokenId: "yes",
      noTokenId: "no",
      askYes: 0.4,
      askNo: 0.5,
      shares: 5,
    });

    expect(result.bothFilled).toBe(false);
    expect(result.abandoned).toBe(false);
    expect(result.orphan).toEqual({
      leg: "YES", // cheaper (0.4) was chosen as A
      tokenId: "yes",
      shares: 5,
    });
    expect(result.legB?.filled).toBe(false);
  });

  it("orphans on leg A side (NO) when NO is the cheaper leg", async () => {
    mockClient.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xA",
      status: "live",
    });
    mockClient.getOrder.mockResolvedValue({ status: "matched", size_matched: "5" });
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: false,
      errorMsg: "rejected",
    });

    const result = await executeAtomic({
      yesTokenId: "yes",
      noTokenId: "no",
      askYes: 0.6,
      askNo: 0.3, // cheaper → A
      shares: 5,
    });

    expect(result.orphan?.leg).toBe("NO");
    expect(result.orphan?.tokenId).toBe("no");
  });

  it("returns orphan when leg B throws", async () => {
    mockClient.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xA",
      status: "live",
    });
    mockClient.getOrder.mockResolvedValue({ status: "matched", size_matched: "5" });
    mockClient.createAndPostMarketOrder.mockRejectedValue(new Error("network"));

    const result = await executeAtomic({
      yesTokenId: "yes",
      noTokenId: "no",
      askYes: 0.4,
      askNo: 0.5,
      shares: 5,
    });

    expect(result.orphan).toBeDefined();
    expect(result.orphan?.shares).toBe(5);
    expect(result.legB?.status).toBe("threw");
  });

  it("recognises immediate fill on placement (no polling needed)", async () => {
    mockClient.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xA",
      status: "matched",
      takingAmount: "5000000",
      makingAmount: "2000000",
    });
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: true,
      orderID: "0xB",
      status: "matched",
      takingAmount: "5000000",
      makingAmount: "2500000",
    });

    const result = await executeAtomic({
      yesTokenId: "yes",
      noTokenId: "no",
      askYes: 0.4,
      askNo: 0.5,
      shares: 5,
    });

    expect(result.bothFilled).toBe(true);
    expect(mockClient.getOrder).not.toHaveBeenCalled();
  });

  it("sizes leg B amount to mirror leg A's actual fill (not the requested shares)", async () => {
    // Leg A overfills (book gave us 6 shares for the 5-share request)
    mockClient.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: "0xA",
      status: "live",
    });
    mockClient.getOrder.mockResolvedValue({ status: "matched", size_matched: "6" });
    mockClient.createAndPostMarketOrder.mockResolvedValue({
      success: true,
      orderID: "0xB",
      status: "matched",
      takingAmount: "6000000",
      makingAmount: "3000000",
    });

    await executeAtomic({
      yesTokenId: "yes",
      noTokenId: "no",
      askYes: 0.4,
      askNo: 0.5,
      shares: 5,
    });

    // Leg B amount = aFilledShares × legB.price = 6 × 0.5 = 3.0
    expect(mockClient.createAndPostMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 3.0 }),
      expect.anything(),
      expect.anything(),
    );
  });
});
