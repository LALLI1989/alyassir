import { describe, expect, it } from "vitest";
import {
  displayPlate,
  formatCents,
  isLatinName,
  isValidIdNumber,
  isValidPhone,
  isValidPlate,
  normalizeIdNumber,
  normalizePhone,
  normalizePlate,
  parseMoneyInput,
} from "@alyassir/shared";
import {
  addDays,
  amountLockAt,
  annulmentLastDay,
  businessDay,
  coverageEnd,
  daysBetween,
  defaultRenewalStart,
  feeOnlyAmounts,
  isActiveOn,
  isAmountLocked,
  isFleetSizeAllowed,
  isRenewalStartAllowed,
  isWithinAnnulmentPeriod,
  renewalMode,
  validityOn,
  vehicleChangeAmounts,
} from "./index";

describe("business day in Casablanca (SPEC 4.11)", () => {
  it("uses UTC+1 outside Ramadan: 23:30 UTC is already the next day", () => {
    expect(businessDay(new Date("2026-02-14T23:30:00Z"))).toBe("2026-02-15");
    expect(businessDay(new Date("2026-03-22T23:30:00Z"))).toBe("2026-03-23");
  });

  it("uses UTC+0 during Ramadan 2026: 23:30 UTC is still the same day", () => {
    expect(businessDay(new Date("2026-02-15T23:30:00Z"))).toBe("2026-02-15");
    expect(businessDay(new Date("2026-03-01T23:30:00Z"))).toBe("2026-03-01");
    expect(businessDay(new Date("2026-03-21T23:30:00Z"))).toBe("2026-03-21");
  });

  it("renewal near midnight follows the Casablanca date, not the UTC date", () => {
    // End E = 2026-02-13. At 23:30 UTC on 14/02 it is already 15/02 in Casablanca (= E+2).
    const today = businessDay(new Date("2026-02-14T23:30:00Z"));
    expect(renewalMode("active", "2026-02-13", today)).toBe("policy_change");
    // During Ramadan, 23:30 UTC on 01/03 is still 01/03 (= E+1 for E = 28/02).
    expect(renewalMode("active", "2026-02-28", businessDay(new Date("2026-03-01T23:30:00Z")))).toBe("renewal");
  });
});

describe("date arithmetic", () => {
  it("adds days across months and leap years", () => {
    expect(addDays("2026-10-10", 1)).toBe("2026-10-11");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2026-11-01", "2026-11-15")).toBe(14);
  });

  it("computes the default end: start + N months - 1 day", () => {
    expect(coverageEnd("2026-01-01", 12)).toBe("2026-12-31");
    expect(coverageEnd("2026-10-27", 12)).toBe("2027-10-26");
    expect(coverageEnd("2026-10-27", 1)).toBe("2026-11-26");
    expect(coverageEnd("2026-10-27", 3)).toBe("2027-01-26");
    expect(coverageEnd("2026-10-27", 6)).toBe("2027-04-26");
    expect(coverageEnd("2026-03-01", 1)).toBe("2026-03-31");
  });

  it("ends on the last day of a shorter month", () => {
    expect(coverageEnd("2026-01-31", 1)).toBe("2026-02-28");
    expect(coverageEnd("2028-01-31", 1)).toBe("2028-02-29");
    expect(coverageEnd("2026-03-31", 1)).toBe("2026-04-30");
  });
});

describe("renewal or policy change (SPEC 12)", () => {
  const E = "2026-10-10";
  it("is a renewal before E, on E and on E+1", () => {
    expect(renewalMode("active", E, "2026-09-30")).toBe("renewal");
    expect(renewalMode("active", E, "2026-10-10")).toBe("renewal");
    expect(renewalMode("active", E, "2026-10-11")).toBe("renewal");
  });
  it("is a policy change from E+2", () => {
    expect(renewalMode("active", E, "2026-10-12")).toBe("policy_change");
    expect(renewalMode("active", E, "2027-01-01")).toBe("policy_change");
  });
  it("is neither for an annulled or cancelled policy", () => {
    expect(renewalMode("annulled", E, "2026-10-01")).toBe("none");
    expect(renewalMode("cancelled", E, "2026-10-01")).toBe("none");
  });
  it("starts the next period the day after E, and refuses a start before E", () => {
    expect(defaultRenewalStart(E)).toBe("2026-10-11");
    expect(isRenewalStartAllowed(E, "2026-10-10")).toBe(true);
    expect(isRenewalStartAllowed(E, "2026-10-11")).toBe(true);
    expect(isRenewalStartAllowed(E, "2026-10-09")).toBe(false);
  });
});

describe("validity (SPEC 11.3)", () => {
  it("becomes expired the day after the end", () => {
    expect(validityOn("active", "2026-10-10", "2026-10-10")).toBe("active");
    expect(validityOn("active", "2026-10-10", "2026-10-11")).toBe("expired");
    expect(validityOn("annulled", "2027-10-10", "2026-10-11")).toBe("annulled");
  });
  it("is active in time only between start and end", () => {
    expect(isActiveOn("active", "2026-10-11", "2027-10-10", "2026-10-10")).toBe(false);
    expect(isActiveOn("active", "2026-10-11", "2027-10-10", "2026-10-11")).toBe(true);
    expect(isActiveOn("cancelled", "2026-10-11", "2027-10-10", "2026-12-01")).toBe(false);
  });
});

describe("48 hours and 15 days", () => {
  it("locks the amount exactly 48 hours after creation (hours, not dates)", () => {
    const created = new Date("2026-10-27T09:00:00Z");
    expect(amountLockAt(created).toISOString()).toBe("2026-10-29T09:00:00.000Z");
    expect(isAmountLocked(created, new Date("2026-10-29T08:59:59Z"))).toBe(false);
    expect(isAmountLocked(created, new Date("2026-10-29T09:00:00Z"))).toBe(true);
  });
  it("allows annulment during the first 15 days, start day included", () => {
    expect(annulmentLastDay("2026-11-01")).toBe("2026-11-15");
    expect(isWithinAnnulmentPeriod("2026-11-01", "2026-11-01")).toBe(true);
    expect(isWithinAnnulmentPeriod("2026-11-01", "2026-11-15")).toBe(true);
    expect(isWithinAnnulmentPeriod("2026-11-01", "2026-11-16")).toBe(false);
  });
});

describe("fleet and change amounts", () => {
  it("needs 5 vehicles for a fleet", () => {
    expect(isFleetSizeAllowed(4)).toBe(false);
    expect(isFleetSizeAllowed(5)).toBe(true);
  });
  it("vehicle change: increase 300 -> 317, same -> 17, decrease 120 -> receives 103 (SPEC 15)", () => {
    expect(vehicleChangeAmounts(100_000, 130_000, 1700)).toEqual({ differenceCents: 30_000, feeCents: 1700, netCents: 31_700, direction: "increase" });
    expect(vehicleChangeAmounts(100_000, 100_000, 1700)).toEqual({ differenceCents: 0, feeCents: 1700, netCents: 1700, direction: "same" });
    expect(vehicleChangeAmounts(100_000, 88_000, 1700)).toEqual({ differenceCents: -12_000, feeCents: 1700, netCents: -10_300, direction: "decrease" });
  });
  it("plate change and duplicate cost the fixed fee", () => {
    expect(feeOnlyAmounts(1700).netCents).toBe(1700);
  });
  it("refuses non-integer amounts", () => {
    expect(() => vehicleChangeAmounts(10.5, 0, 1700)).toThrow();
  });
});

describe("input formats (SPEC 9)", () => {
  it("accepts the four plate types and refuses wrong shapes", () => {
    expect(isValidPlate("ma", "12-A-34567")).toBe(true);
    expect(isValidPlate("ma", "12 a 34567")).toBe(true);
    expect(isValidPlate("ma", "123-A-4567")).toBe(false);
    expect(isValidPlate("ma", "12-AB-345")).toBe(false);
    expect(isValidPlate("ma", "12-ب-345")).toBe(false);
    expect(isValidPlate("ww", "WW123456")).toBe(true);
    expect(isValidPlate("ww", "W123456")).toBe(false);
    expect(isValidPlate("state", "M223355")).toBe(true);
    expect(isValidPlate("state", "MM223355")).toBe(false);
    expect(isValidPlate("foreign", "AB-123-CD")).toBe(true);
    expect(isValidPlate("foreign", "AB_123")).toBe(false);
  });
  it("normalises plates so the same plate is always found", () => {
    expect(normalizePlate("12-a-34567")).toBe("12A34567");
    expect(normalizePlate("12 A 34567")).toBe(normalizePlate("12-A-34567"));
    expect(displayPlate("ma", "12a34567")).toBe("12-A-34567");
    expect(displayPlate("ww", "ww 123456")).toBe("WW123456");
  });
  it("checks identity numbers", () => {
    expect(isValidIdNumber("cin", "ab 123456")).toBe(true);
    expect(isValidIdNumber("cin", "J12345")).toBe(true);
    expect(isValidIdNumber("cin", "ABC123")).toBe(false);
    expect(isValidIdNumber("cin", "A1234567")).toBe(false);
    expect(normalizeIdNumber(" ab 123 456 ")).toBe("AB123456");
  });
  it("names are in Latin letters, accents allowed, Arabic refused (owner decision 28/10/2026)", () => {
    expect(isLatinName("Said EL IDRISSI")).toBe(true);
    expect(isLatinName("Hélène D'Orléans-Benali")).toBe(true);
    expect(isLatinName("Transports Atlas SARL (Agadir)")).toBe(true);
    expect(isLatinName("سعيد")).toBe(false);
    expect(isLatinName("Said سعيد")).toBe(false);
    expect(isLatinName("12345")).toBe(false);
  });
  it("checks phone numbers", () => {
    expect(isValidPhone("06 12 34 56 78")).toBe(true);
    expect(normalizePhone("+212 6 12 34 56 78")).toBe("0612345678");
    expect(isValidPhone("0812345678")).toBe(false);
    expect(isValidPhone("+33 6 12 34 56 78")).toBe(true);
  });
  it("reads amounts as integer cents", () => {
    expect(parseMoneyInput("1 234,50")).toBe(123_450);
    expect(parseMoneyInput("1234.5")).toBe(123_450);
    expect(parseMoneyInput("17")).toBe(1700);
    expect(parseMoneyInput("0,07")).toBe(7);
    expect(parseMoneyInput("12,345")).toBeNull();
    expect(parseMoneyInput("-5")).toBeNull();
    expect(parseMoneyInput("abc")).toBeNull();
    expect(formatCents(123_450)).toBe("1 234,50");
    expect(formatCents(-10_300)).toBe("-103,00");
  });
});
