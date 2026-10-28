import { describe, expect, it } from "vitest";
import {
  addMonths,
  allocateOldestFirst,
  annulmentDecision,
  areInstalmentDatesValid,
  businessDay,
  cancellationDecision,
  chargeTarget,
  collectionStatus,
  creditAgainstDues,
  debtConversionDay,
  instalmentSchedule,
  isDueForDebtConversion,
  isInstalmentAllowed,
  paymentState,
} from "./index";

const sum = (xs: { amountCents: number }[]) => xs.reduce((s, x) => s + x.amountCents, 0);

describe("instalments (SPEC 14.4): the binding examples", () => {
  it("4000 in 2: 2017 + 2000 = 4017", () => {
    const s = instalmentSchedule(400_000, 2, "2026-10-27", 1700);
    expect(s.map((x) => x.amountCents)).toEqual([201_700, 200_000]);
    expect(sum(s)).toBe(401_700);
  });
  it("4000 in 4: 1017 + 1017 + 1017 + 1000 = 4051", () => {
    const s = instalmentSchedule(400_000, 4, "2026-10-27", 1700);
    expect(s.map((x) => x.amountCents)).toEqual([101_700, 101_700, 101_700, 100_000]);
    expect(sum(s)).toBe(405_100);
  });
  it("1000 in 3: 350.33 + 350.33 + 333.34 = 1034.00 (the extra cent goes to the last)", () => {
    const s = instalmentSchedule(100_000, 3, "2026-10-27", 1700);
    expect(s.map((x) => x.baseCents)).toEqual([33_333, 33_333, 33_334]);
    expect(s.map((x) => x.amountCents)).toEqual([35_033, 35_033, 33_334]);
    expect(sum(s)).toBe(103_400);
  });
  it("never loses or invents a cent", () => {
    for (const total of [1, 99, 100_001, 123_457, 999_999]) {
      for (const n of [2, 3, 4]) {
        const s = instalmentSchedule(total, n, "2026-01-31", 1700);
        expect(s.reduce((a, x) => a + x.baseCents, 0)).toBe(total);
        expect(s.at(-1)?.feeCents).toBe(0);
      }
    }
  });
  it("monthly from the start, the first on the start day; a date may be set at creation", () => {
    expect(instalmentSchedule(300_000, 3, "2026-10-27", 1700).map((x) => x.dueDate)).toEqual(["2026-10-27", "2026-11-27", "2026-12-27"]);
    expect(instalmentSchedule(300_000, 3, "2026-01-31", 1700).map((x) => x.dueDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(instalmentSchedule(300_000, 2, "2026-10-27", 1700, [null, "2026-12-05"]).map((x) => x.dueDate)).toEqual(["2026-10-27", "2026-12-05"]);
    expect(areInstalmentDatesValid("2026-10-27", ["2026-10-27", "2026-12-05"])).toBe(true);
    expect(areInstalmentDatesValid("2026-10-27", ["2026-10-26"])).toBe(false);
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });
  it("only single-vehicle policies of 6 or 12 months", () => {
    expect(isInstalmentAllowed({ requiresVehicle: true, isFleet: false, months: 12 })).toBe(true);
    expect(isInstalmentAllowed({ requiresVehicle: true, isFleet: false, months: 6 })).toBe(true);
    expect(isInstalmentAllowed({ requiresVehicle: true, isFleet: false, months: 3 })).toBe(false);
    expect(isInstalmentAllowed({ requiresVehicle: true, isFleet: true, months: 12 })).toBe(false);
    expect(isInstalmentAllowed({ requiresVehicle: false, isFleet: false, months: 12 })).toBe(false);
  });
});

describe("paying (SPEC 14.5)", () => {
  const dues = [
    { id: "i2", date: "2026-11-27", remainingCents: 35_033 },
    { id: "i1", date: "2026-10-27", remainingCents: 35_033 },
    { id: "i3", date: "2026-12-27", remainingCents: 33_334 },
  ];
  it("oldest first; a part payment stays on the instalment and the rest carries on", () => {
    expect(allocateOldestFirst(50_000, dues)).toEqual({ allocations: [{ id: "i1", cents: 35_033 }, { id: "i2", cents: 14_967 }], leftoverCents: 0 });
    expect(allocateOldestFirst(10_000, dues).allocations).toEqual([{ id: "i1", cents: 10_000 }]);
  });
  it("reports what is above the total (the server refuses it)", () => {
    expect(allocateOldestFirst(103_401, dues).leftoverCents).toBe(1);
  });
});

describe("late instalment becomes a debt (SPEC 14.6)", () => {
  it("due 10/11: still an instalment on 11 and 12/11, a debt from 13/11", () => {
    expect(debtConversionDay("2026-11-10")).toBe("2026-11-13");
    expect(isDueForDebtConversion("2026-11-10", "2026-11-12")).toBe(false);
    expect(isDueForDebtConversion("2026-11-10", "2026-11-13")).toBe(true);
  });
  it("uses the Casablanca date around the Ramadan clock change", () => {
    // 15/02/2026 23:30 UTC: still 15/02 in Casablanca (UTC+0 during Ramadan 2026).
    expect(isDueForDebtConversion("2026-02-12", businessDay(new Date("2026-02-14T23:30:00Z")))).toBe(true);
    expect(isDueForDebtConversion("2026-02-13", businessDay(new Date("2026-02-15T23:30:00Z")))).toBe(false);
  });
});

describe("collection status (SPEC 11.3)", () => {
  it("rejected > outstanding > in collection > paid", () => {
    expect(collectionStatus({ remainingCents: 0, inCollectionCents: 0, rejectedDebtOpen: false })).toBe("paid");
    expect(collectionStatus({ remainingCents: 0, inCollectionCents: 5, rejectedDebtOpen: false })).toBe("in_collection");
    expect(collectionStatus({ remainingCents: 5, inCollectionCents: 5, rejectedDebtOpen: false })).toBe("outstanding");
    expect(collectionStatus({ remainingCents: 5, inCollectionCents: 0, rejectedDebtOpen: true })).toBe("payment_rejected");
  });
});

describe("annulment (SPEC 13.1)", () => {
  const f = { startDate: "2026-11-01", paidCents: 250_000, remainingCents: 0 };
  it("fully paid: all back during 15 days, refused after", () => {
    expect(annulmentDecision("fully_paid", { ...f, today: "2026-11-15" })).toEqual({ allowed: true, refundCents: 250_000, writeOffCents: 0 });
    expect(annulmentDecision("fully_paid", { ...f, today: "2026-11-16" })).toEqual({ allowed: false, reason: "ANNULMENT_PERIOD_OVER" });
  });
  it("instalments not fully paid: any time, nothing back, the debt falls", () => {
    expect(annulmentDecision("instalments_open", { ...f, today: "2027-05-01", paidCents: 100_000, remainingCents: 150_000 })).toEqual({ allowed: true, refundCents: 0, writeOffCents: 150_000 });
  });
  it("instalments fully paid: no annulment", () => {
    expect(annulmentDecision("instalments_paid", { ...f, today: "2026-11-02" })).toEqual({ allowed: false, reason: "ANNULMENT_USE_CANCELLATION" });
  });
  it("direct debt: what was paid comes back, the debt falls (assumption 27.1)", () => {
    expect(annulmentDecision("direct_debt", { ...f, today: "2026-11-05", paidCents: 100_000, remainingCents: 150_000 })).toEqual({ allowed: true, refundCents: 100_000, writeOffCents: 150_000 });
  });
  it("knows the payment state", () => {
    expect(paymentState({ hasPlan: false, remainingCents: 0 })).toBe("fully_paid");
    expect(paymentState({ hasPlan: false, remainingCents: 1 })).toBe("direct_debt");
    expect(paymentState({ hasPlan: true, remainingCents: 1 })).toBe("instalments_open");
    expect(paymentState({ hasPlan: true, remainingCents: 0 })).toBe("instalments_paid");
  });
});

describe("cancellation (SPEC 13.2)", () => {
  it("forbidden while instalments are open", () => {
    expect(cancellationDecision("instalments_open", { refundCents: 1, debtRemainingCents: 0, payOut: false })).toEqual({ allowed: false, reason: "CANCELLATION_INSTALMENTS_OPEN" });
  });
  it("debt 1000, refund 500 -> debt 500, no money out", () => {
    expect(cancellationDecision("direct_debt", { refundCents: 50_000, debtRemainingCents: 100_000, payOut: false })).toEqual({ allowed: true, debtReductionCents: 50_000, payoutCents: 0 });
  });
  it("refund above the debt: the rest is paid out; the manager may pay everything out", () => {
    expect(cancellationDecision("direct_debt", { refundCents: 150_000, debtRemainingCents: 100_000, payOut: false })).toEqual({ allowed: true, debtReductionCents: 100_000, payoutCents: 50_000 });
    expect(cancellationDecision("direct_debt", { refundCents: 50_000, debtRemainingCents: 100_000, payOut: true })).toEqual({ allowed: true, debtReductionCents: 0, payoutCents: 50_000 });
    expect(cancellationDecision("fully_paid", { refundCents: 80_000, debtRemainingCents: 0, payOut: false })).toEqual({ allowed: true, debtReductionCents: 0, payoutCents: 80_000 });
  });
});

describe("fees and price changes (SPEC 15, 16)", () => {
  it("unpaid fee: nearest unpaid instalment, else the debt, else a new debt", () => {
    const inst = [{ id: "i3", date: "2026-12-27", remainingCents: 1 }, { id: "i2", date: "2026-11-27", remainingCents: 5 }];
    expect(chargeTarget(inst, [{ id: "d1", date: "2026-01-01", remainingCents: 9 }])).toEqual({ kind: "instalment", id: "i2" });
    expect(chargeTarget([], [{ id: "d1", date: "2026-01-01", remainingCents: 9 }])).toEqual({ kind: "debt", id: "d1" });
    expect(chargeTarget([{ id: "i1", date: "2026-01-01", remainingCents: 0 }], [])).toEqual({ kind: "new_debt", id: null });
  });
  it("decrease owed 103 with a debt of 50: debt cleared, 53 paid out", () => {
    expect(creditAgainstDues(10_300, [{ id: "d1", date: "2026-01-01", remainingCents: 5_000 }])).toEqual({ reductions: [{ id: "d1", cents: 5_000 }], payoutCents: 5_300 });
    expect(creditAgainstDues(10_300, [])).toEqual({ reductions: [], payoutCents: 10_300 });
  });
});
