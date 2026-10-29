import { describe, expect, it } from "vitest";
import { customInstalmentsProblem, isInOrder, isOperationDayAllowed, negativeDays } from "./index";

describe("historical entry (owner decisions 29/10/2026)", () => {
  it("dates from 01/05/2026 to today only", () => {
    expect(isOperationDayAllowed("2026-04-30", "2026-10-29")).toBe(false);
    expect(isOperationDayAllowed("2026-05-01", "2026-10-29")).toBe(true);
    expect(isOperationDayAllowed("2026-10-30", "2026-10-29")).toBe(false);
  });

  it("inside a policy, oldest first", () => {
    expect(isInOrder("2026-06-10", null)).toBe(true);
    expect(isInOrder("2026-06-10", "2026-06-10")).toBe(true);
    expect(isInOrder("2026-06-09", "2026-06-10")).toBe(false);
  });

  it("finds the days ending below zero (opening 0, +1 000 on 01/05, -1 500 on 03/05, +600 on 05/05)", () => {
    const moves = [
      { account: "drawer" as const, day: "2026-05-01", cents: 100_000 },
      { account: "drawer" as const, day: "2026-05-03", cents: -150_000 },
      { account: "drawer" as const, day: "2026-05-05", cents: 60_000 },
      { account: "bank" as const, day: "2026-05-03", cents: 150_000 },
    ];
    expect(negativeDays(moves)).toEqual([{ account: "drawer", day: "2026-05-03", cents: -50_000 }]);
    expect(negativeDays(moves.filter((m) => m.cents > 0))).toEqual([]);
  });

  it("old instalments typed by hand: in order and adding up to the premium", () => {
    const rows = [
      { dueDate: "2026-05-01", baseCents: 100_000, feeCents: 1_700 },
      { dueDate: "2026-06-01", baseCents: 100_000, feeCents: 0 },
    ];
    expect(customInstalmentsProblem(200_000, "2026-05-01", 2, rows)).toBeNull();
    expect(customInstalmentsProblem(200_001, "2026-05-01", 2, rows)).toBe("INSTALMENTS_CUSTOM_INVALID");
    expect(customInstalmentsProblem(200_000, "2026-05-01", 3, rows)).toBe("INSTALMENTS_CUSTOM_INVALID");
    expect(customInstalmentsProblem(200_000, "2026-05-02", 2, rows)).toBe("INSTALMENTS_CUSTOM_INVALID");
    expect(customInstalmentsProblem(200_000, "2026-05-01", 2, [rows[0]!, { ...rows[1]!, dueDate: "2026-05-01" }])).toBe("INSTALMENTS_CUSTOM_INVALID");
  });
});
