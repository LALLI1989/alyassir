import { describe, expect, it } from "vitest";
import { closingDifference, dayStatus, expenseCancelGivesBack, expenseNext, transferProblem } from "./index";

describe("closing (SPEC 17.3)", () => {
  it("expected 3500, counted 3300: −200 and a reason is needed", () => {
    expect(closingDifference(350_000, 330_000)).toEqual({ differenceCents: -20_000, reasonRequired: true });
  });
  it("no gap, no reason", () => {
    expect(closingDifference(350_000, 350_000)).toEqual({ differenceCents: 0, reasonRequired: false });
  });
  it("more cash than expected is a gap too", () => {
    expect(closingDifference(100_000, 100_050).differenceCents).toBe(50);
  });
  it("refuses negative or non-integer amounts", () => {
    expect(() => closingDifference(100, -1)).toThrow();
    expect(() => closingDifference(100.5, 1)).toThrow();
  });
});

describe("day status (owner decision 28/10/2026)", () => {
  const base = { lastClosedAt: null, lastMovementAt: null, lastApprovedAt: null, lastReopenedAt: null };
  it("no closing yet: open", () => {
    expect(dayStatus({ ...base, lastMovementAt: 10 })).toBe("open");
  });
  it("closed after the last movement: closed", () => {
    expect(dayStatus({ ...base, lastMovementAt: 10, lastClosedAt: 20 })).toBe("closed");
  });
  it("a movement after the last closing: needs review", () => {
    expect(dayStatus({ ...base, lastClosedAt: 20, lastMovementAt: 30 })).toBe("needs_review");
  });
  it("approved by the manager after that movement: closed", () => {
    expect(dayStatus({ ...base, lastClosedAt: 20, lastMovementAt: 30, lastApprovedAt: 40 })).toBe("closed");
  });
  it("a new movement after the approval: needs review again", () => {
    expect(dayStatus({ ...base, lastClosedAt: 20, lastMovementAt: 50, lastApprovedAt: 40 })).toBe("needs_review");
  });
  it("reopened after the last closing: open; a new closing closes it", () => {
    expect(dayStatus({ ...base, lastClosedAt: 20, lastReopenedAt: 25 })).toBe("open");
    expect(dayStatus({ ...base, lastClosedAt: 30, lastReopenedAt: 25 })).toBe("closed");
  });
});

describe("transfers (SPEC 17.1)", () => {
  it("between two accounts, a positive amount", () => {
    expect(transferProblem("drawer", "safe", 500_000)).toBeNull();
    expect(transferProblem("bank", "safe", 1)).toBeNull();
    expect(transferProblem("safe", "safe", 1)).toBe("SAME_ACCOUNT");
    expect(transferProblem("drawer", "bank", 0)).toBe("AMOUNT");
    expect(transferProblem("drawer", "bank", 1.5)).toBe("AMOUNT");
  });
});

describe("expenses (SPEC 17.2)", () => {
  it("pending: approve, reject, edit, cancel", () => {
    expect(expenseNext("pending", "approve")).toBe("approved");
    expect(expenseNext("pending", "reject")).toBe("rejected");
    expect(expenseNext("pending", "edit")).toBe("pending");
    expect(expenseNext("pending", "cancel")).toBe("cancelled");
  });
  it("approved: only cancel, which gives the money back", () => {
    expect(expenseNext("approved", "approve")).toBeNull();
    expect(expenseNext("approved", "edit")).toBeNull();
    expect(expenseNext("approved", "cancel")).toBe("cancelled");
    expect(expenseCancelGivesBack("approved")).toBe(true);
    expect(expenseCancelGivesBack("pending")).toBe(false);
  });
  it("rejected and cancelled stay as they are", () => {
    for (const a of ["approve", "reject", "edit", "cancel"] as const) {
      expect(expenseNext("rejected", a)).toBeNull();
      expect(expenseNext("cancelled", a)).toBeNull();
    }
  });
});
