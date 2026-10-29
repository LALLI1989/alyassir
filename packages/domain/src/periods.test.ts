import { describe, expect, it } from "vitest";
import { daysOf, last12Months, periodRange, sumCents } from "./index";

describe("dashboard and report periods", () => {
  it("today, this month, this year", () => {
    expect(periodRange("today", "2026-10-29")).toEqual({ from: "2026-10-29", to: "2026-10-29" });
    expect(periodRange("month", "2026-10-29")).toEqual({ from: "2026-10-01", to: "2026-10-29" });
    expect(periodRange("year", "2026-10-29")).toEqual({ from: "2026-01-01", to: "2026-10-29" });
  });
  it("days of a range and the last 12 months across the year", () => {
    expect(daysOf({ from: "2026-02-27", to: "2026-03-02" })).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(last12Months("2026-03-15")).toEqual(["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
  });
  it("totals in cents: 1000 + 500 + 250 = 1750", () => {
    expect(sumCents([100_000, 50_000, 25_000, null])).toBe(175_000);
    expect(() => sumCents([1.5])).toThrow();
  });
});
