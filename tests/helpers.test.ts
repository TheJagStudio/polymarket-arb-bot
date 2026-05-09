import { describe, it, expect } from "vitest";
import {
  computeUsdcAmount,
  decideOrphanAction,
  decideOutcome,
  isFilledStatus,
  parseFilledShares,
  sharesAtFillPrice,
  type RawOrderResponse,
} from "../src/exec/helpers.js";

// ── Detector logic ──────────────────────────────────────────────────────────

describe("decideOutcome (detector + pre-trade gates)", () => {
  // Test fixtures: settlement is 10 minutes out, asks are well within bounds.
  const FUTURE = new Date(Date.now() + 10 * 60_000).toISOString();
  const baseInput = {
    threshold: 0.97,
    endDateIso: FUTURE,
    isInflight: false,
    recentMatchedCount: 0,
    risk: { allowed: true } as { allowed: boolean; reason?: string } | null,
  };

  it("fires when sum is below threshold", () => {
    const out = decideOutcome({ ...baseInput, askYes: 0.45, askNo: 0.5 });
    expect(out).toEqual({ kind: "fire" });
  });

  it("fires when sum is exactly at threshold", () => {
    // 0.47 + 0.50 = 0.97 — equal to threshold (0.97). Should fire (<= not <).
    const out = decideOutcome({ ...baseInput, askYes: 0.47, askNo: 0.5 });
    expect(out).toEqual({ kind: "fire" });
  });

  it("returns no-signal when sum is above threshold", () => {
    const out = decideOutcome({ ...baseInput, askYes: 0.5, askNo: 0.5 });
    expect(out).toEqual({ kind: "no-signal" });
  });

  it("returns no-signal when YES ask is null", () => {
    const out = decideOutcome({ ...baseInput, askYes: null, askNo: 0.5 });
    expect(out).toEqual({ kind: "no-signal" });
  });

  it("returns no-signal when NO ask is null", () => {
    const out = decideOutcome({ ...baseInput, askYes: 0.5, askNo: null });
    expect(out).toEqual({ kind: "no-signal" });
  });

  it("returns no-signal when both asks are null", () => {
    const out = decideOutcome({ ...baseInput, askYes: null, askNo: null });
    expect(out).toEqual({ kind: "no-signal" });
  });

  it("skips with 'inflight' when already firing", () => {
    const out = decideOutcome({
      ...baseInput,
      askYes: 0.4,
      askNo: 0.5,
      isInflight: true,
    });
    expect(out).toEqual({ kind: "skip", reason: "inflight" });
  });
});

describe("decideOutcome — time-to-settlement filter", () => {
  const baseInput = {
    threshold: 0.97,
    isInflight: false,
    recentMatchedCount: 0,
    risk: { allowed: true } as { allowed: boolean; reason?: string } | null,
    askYes: 0.4 as number | null,
    askNo: 0.5 as number | null,
  };

  it("blocks when <60s remain to settlement", () => {
    const now = 1_700_000_000_000;
    const endDateIso = new Date(now + 30_000).toISOString(); // 30s away
    const out = decideOutcome({ ...baseInput, endDateIso, now });
    expect(out.kind).toBe("skip");
    if (out.kind === "skip") {
      expect(out.reason).toMatch(/too-close-to-settlement/);
      expect(out.reason).toMatch(/30s left/);
    }
  });

  it("blocks at exactly 59s remaining", () => {
    const now = 1_700_000_000_000;
    const endDateIso = new Date(now + 59_000).toISOString();
    const out = decideOutcome({ ...baseInput, endDateIso, now });
    expect(out.kind).toBe("skip");
  });

  it("fires at exactly 60s remaining (boundary not blocked)", () => {
    const now = 1_700_000_000_000;
    const endDateIso = new Date(now + 60_000).toISOString();
    const out = decideOutcome({ ...baseInput, endDateIso, now });
    expect(out).toEqual({ kind: "fire" });
  });

  it("blocks when end is in the past (negative ms)", () => {
    const now = 1_700_000_000_000;
    const endDateIso = new Date(now - 5_000).toISOString();
    const out = decideOutcome({ ...baseInput, endDateIso, now });
    expect(out.kind).toBe("skip");
    if (out.kind === "skip") expect(out.reason).toMatch(/too-close-to-settlement/);
  });
});

describe("decideOutcome — extreme-price filter", () => {
  const FUTURE = new Date(Date.now() + 10 * 60_000).toISOString();
  const base = {
    threshold: 0.97,
    endDateIso: FUTURE,
    isInflight: false,
    recentMatchedCount: 0,
    risk: { allowed: true } as { allowed: boolean; reason?: string } | null,
  };

  it("blocks when YES ask is below 0.05", () => {
    const out = decideOutcome({ ...base, askYes: 0.04, askNo: 0.9 });
    expect(out.kind).toBe("skip");
    if (out.kind === "skip") expect(out.reason).toMatch(/extreme-prices/);
  });

  it("blocks when NO ask is below 0.05", () => {
    const out = decideOutcome({ ...base, askYes: 0.9, askNo: 0.04 });
    expect(out.kind).toBe("skip");
    if (out.kind === "skip") expect(out.reason).toMatch(/extreme-prices/);
  });

  it("blocks when YES ask is above 0.95", () => {
    const out = decideOutcome({ ...base, askYes: 0.96, askNo: 0.005 });
    expect(out.kind).toBe("skip");
    if (out.kind === "skip") expect(out.reason).toMatch(/extreme-prices/);
  });

  it("blocks when NO ask is above 0.95", () => {
    const out = decideOutcome({ ...base, askYes: 0.005, askNo: 0.96 });
    expect(out.kind).toBe("skip");
    if (out.kind === "skip") expect(out.reason).toMatch(/extreme-prices/);
  });

  it("fires at boundary 0.05 (not blocked)", () => {
    const out = decideOutcome({ ...base, askYes: 0.05, askNo: 0.9 });
    expect(out).toEqual({ kind: "fire" });
  });

  it("fires at boundary 0.95 (not blocked)", () => {
    // Use a relaxed threshold so the sum constraint doesn't shadow the
    // price-boundary check we're trying to exercise.
    const out = decideOutcome({
      ...base,
      threshold: 1.0,
      askYes: 0.05,
      askNo: 0.95,
    });
    expect(out).toEqual({ kind: "fire" });
  });
});

describe("decideOutcome — position-dedup filter", () => {
  const FUTURE = new Date(Date.now() + 10 * 60_000).toISOString();
  const base = {
    threshold: 0.97,
    endDateIso: FUTURE,
    isInflight: false,
    risk: { allowed: true } as { allowed: boolean; reason?: string } | null,
    askYes: 0.4 as number | null,
    askNo: 0.5 as number | null,
  };

  it("blocks when there is one matched BUY in the lookback window", () => {
    const out = decideOutcome({ ...base, recentMatchedCount: 1 });
    expect(out).toEqual({ kind: "skip", reason: "already-positioned" });
  });

  it("blocks when there are multiple recent matches", () => {
    const out = decideOutcome({ ...base, recentMatchedCount: 3 });
    expect(out).toEqual({ kind: "skip", reason: "already-positioned" });
  });

  it("fires when no recent matches", () => {
    const out = decideOutcome({ ...base, recentMatchedCount: 0 });
    expect(out).toEqual({ kind: "fire" });
  });
});

describe("decideOutcome — risk gate plumbing", () => {
  const FUTURE = new Date(Date.now() + 10 * 60_000).toISOString();
  const base = {
    threshold: 0.97,
    endDateIso: FUTURE,
    isInflight: false,
    recentMatchedCount: 0,
    askYes: 0.4 as number | null,
    askNo: 0.5 as number | null,
  };

  it("propagates risk-gate denial verbatim", () => {
    const out = decideOutcome({
      ...base,
      risk: { allowed: false, reason: "daily-cap (20/20)" },
    });
    expect(out).toEqual({ kind: "skip", reason: "daily-cap (20/20)" });
  });

  it("falls back to 'risk' when reason is missing", () => {
    const out = decideOutcome({ ...base, risk: { allowed: false } });
    expect(out).toEqual({ kind: "skip", reason: "risk" });
  });
});

// ── Fill-size parsing (the bug we're fixing) ────────────────────────────────

describe("parseFilledShares", () => {
  // 10 shares at $0.50 cap = $5.00 USDC requested.
  const REQ_USDC = 5.0;
  const PRICE = 0.5;

  it("happy path: parses takingAmount in 6-decimal fixed-point for BUY", () => {
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      takingAmount: "10000000", // 10.0 shares
      makingAmount: "5000000",  // 5.0 USDC
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    expect(shares).toBe(10);
  });

  it("parses takingAmount when given as a number (not string)", () => {
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      takingAmount: 12_500_000,
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    expect(shares).toBe(12.5);
  });

  it("falls back to makingAmount/price when takingAmount=0 (the BUG case)", () => {
    // This is the exact failure mode: API returns 0 for takingAmount, but
    // makingAmount has the USDC actually spent. We back-derive shares.
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      takingAmount: "0",
      makingAmount: "4000000", // $4.00 USDC spent
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    // $4.00 spent / $0.50 price = 8 shares
    expect(shares).toBe(8);
  });

  it("falls back to makingAmount/price when takingAmount is empty string", () => {
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      takingAmount: "",
      makingAmount: "5000000",
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    expect(shares).toBe(10); // $5 / $0.50
  });

  it("falls back to requested USDC / price when both amounts are 0 but matched", () => {
    // Worst case — both fields zeroed. We assume the FOK matched (status
    // says so), so we got at least our requested shares at the cap.
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      takingAmount: "0",
      makingAmount: "0",
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    expect(shares).toBe(10); // $5 / $0.50 = 10 shares
  });

  it("falls back when the amount fields are missing entirely", () => {
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      // takingAmount, makingAmount: undefined
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    expect(shares).toBe(10);
  });

  it("returns 0 when the order status is not 'matched' or 'filled'", () => {
    const resp: RawOrderResponse = {
      success: false,
      status: "rejected",
      takingAmount: "0",
      makingAmount: "0",
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    expect(shares).toBe(0);
  });

  it("returns 0 when success is false even if status would be 'matched'", () => {
    const resp: RawOrderResponse = {
      success: false,
      status: "matched", // shouldn't happen but be defensive
      takingAmount: "0",
      makingAmount: "0",
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    expect(shares).toBe(0);
  });

  it("does NOT fall back when status is 'submitted' (delayed match)", () => {
    // Order was accepted but hasn't matched yet — we shouldn't claim
    // a fill from the request.
    const resp: RawOrderResponse = {
      success: true,
      status: "submitted",
      takingAmount: "0",
      makingAmount: "0",
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    expect(shares).toBe(0);
  });

  it("BUY: always trusts a non-zero takingAmount even when other strategies disagree", () => {
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      takingAmount: "9876543",   // 9.876543 shares (the actual fill)
      makingAmount: "100000000", // $100 USDC — bogus, but ignored
    };
    const shares = parseFilledShares(resp, "BUY", REQ_USDC, PRICE);
    expect(shares).toBe(9.876543);
  });

  it("SELL: parses makingAmount as the share count given up", () => {
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      makingAmount: "7500000", // 7.5 shares sold
      takingAmount: "3750000", // $3.75 USDC received
    };
    const shares = parseFilledShares(resp, "SELL", 7.5, 0.5);
    expect(shares).toBe(7.5);
  });

  it("SELL: cross-derives from takingAmount when makingAmount=0", () => {
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      makingAmount: "0",
      takingAmount: "3000000", // $3 USDC received at $0.5 price = 6 shares
    };
    const shares = parseFilledShares(resp, "SELL", 7, 0.5);
    expect(shares).toBe(6);
  });

  it("SELL: falls back to requestedAmount (which IS shares for SELL) when both zero", () => {
    const resp: RawOrderResponse = {
      success: true,
      status: "matched",
      makingAmount: "0",
      takingAmount: "0",
    };
    const shares = parseFilledShares(resp, "SELL", 4.2, 0.5);
    expect(shares).toBe(4.2);
  });

  it("isFilledStatus: matched/filled are filled; everything else is not", () => {
    expect(isFilledStatus("matched")).toBe(true);
    expect(isFilledStatus("filled")).toBe(true);
    expect(isFilledStatus("submitted")).toBe(false);
    expect(isFilledStatus("rejected")).toBe(false);
    expect(isFilledStatus("threw")).toBe(false);
    expect(isFilledStatus(undefined)).toBe(false);
  });
});

// ── Sizing math ─────────────────────────────────────────────────────────────

describe("sizing math", () => {
  it("computeUsdcAmount = shares × price", () => {
    expect(computeUsdcAmount(10, 0.5)).toBe(5);
    expect(computeUsdcAmount(7, 0.42)).toBeCloseTo(2.94);
    expect(computeUsdcAmount(0, 0.5)).toBe(0);
  });

  it("when fill price is below cap, you get more shares", () => {
    // Requested: 10 shares @ $0.50 cap = $5 USDC
    // Filled at $0.40 → $5 / $0.40 = 12.5 shares
    const usdcSpent = computeUsdcAmount(10, 0.5);
    const shares = sharesAtFillPrice(usdcSpent, 0.4);
    expect(shares).toBe(12.5);
  });

  it("when fill price equals cap, share count matches request", () => {
    const usdcSpent = computeUsdcAmount(10, 0.5);
    const shares = sharesAtFillPrice(usdcSpent, 0.5);
    expect(shares).toBe(10);
  });

  it("sharesAtFillPrice returns 0 for non-positive price (avoids div-by-zero)", () => {
    expect(sharesAtFillPrice(5, 0)).toBe(0);
    expect(sharesAtFillPrice(5, -1)).toBe(0);
  });
});

// ── Orphan logic ────────────────────────────────────────────────────────────

describe("decideOrphanAction", () => {
  const yesTokenId = "token_yes_123";
  const noTokenId = "token_no_456";

  it("YES filled, NO rejected → flatten YES", () => {
    const action = decideOrphanAction(
      { filled: true, filledShares: 10.5, leg: "YES", tokenId: yesTokenId },
      { filled: false, filledShares: 0, leg: "NO", tokenId: noTokenId },
    );
    expect(action).toEqual({
      kind: "flatten",
      leg: "YES",
      tokenId: yesTokenId,
      shares: 10.5,
    });
  });

  it("NO filled, YES rejected → flatten NO", () => {
    const action = decideOrphanAction(
      { filled: false, filledShares: 0, leg: "YES", tokenId: yesTokenId },
      { filled: true, filledShares: 8.25, leg: "NO", tokenId: noTokenId },
    );
    expect(action).toEqual({
      kind: "flatten",
      leg: "NO",
      tokenId: noTokenId,
      shares: 8.25,
    });
  });

  it("both filled → complete (no flatten, bump counter)", () => {
    const action = decideOrphanAction(
      { filled: true, filledShares: 10, leg: "YES", tokenId: yesTokenId },
      { filled: true, filledShares: 10, leg: "NO", tokenId: noTokenId },
    );
    expect(action).toEqual({ kind: "complete" });
  });

  it("both rejected → none (no flatten, no counter bump)", () => {
    const action = decideOrphanAction(
      { filled: false, filledShares: 0, leg: "YES", tokenId: yesTokenId },
      { filled: false, filledShares: 0, leg: "NO", tokenId: noTokenId },
    );
    expect(action).toEqual({ kind: "none" });
  });
});
