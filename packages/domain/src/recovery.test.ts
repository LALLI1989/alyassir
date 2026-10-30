import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_HOURS as WH, RECOVERY_ALPHABET, driveCheckDue, formatRecoveryCode, normalizeRecoveryCode, weekMonday } from "./index";

describe("manager recovery code (Phase 8A)", () => {
  it("16 characters in groups of 4, only easy-to-read letters and digits", () => {
    const code = formatRecoveryCode(Array.from({ length: 16 }, (_, i) => i * 17));
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01OI]/);
    expect(formatRecoveryCode(Array(16).fill(0))).toBe("AAAA-AAAA-AAAA-AAAA");
    expect(formatRecoveryCode(Array(16).fill(255))).toBe("9999-9999-9999-9999");
    expect(RECOVERY_ALPHABET).toHaveLength(32);
  });

  it("accepts the code as typed: lower case, spaces, dashes; refuses anything else", () => {
    expect(normalizeRecoveryCode("k7qm 3xpa-9rtw ld2f")).toBe("K7QM3XPA9RTWLD2F");
    expect(normalizeRecoveryCode("K7QM-3XPA-9RTW-LD2")).toBeNull();
    expect(normalizeRecoveryCode("K7QM-3XPA-9RTW-LD20")).toBeNull();
    expect(normalizeRecoveryCode("")).toBeNull();
  });
});

describe("weekly Google Drive check (Phase 8A)", () => {
  it("Monday of the week", () => {
    expect(weekMonday("2026-11-02")).toBe("2026-11-02"); // Monday
    expect(weekMonday("2026-11-08")).toBe("2026-11-02"); // Sunday
  });

  it("due from the first working day of the week until confirmed", () => {
    expect(driveCheckDue("2026-11-02", WH.days, null)).toBe(true);
    expect(driveCheckDue("2026-11-04", WH.days, "2026-10-26")).toBe(true);
    expect(driveCheckDue("2026-11-04", WH.days, "2026-11-02")).toBe(false);
    // Monday is not a working day: from Tuesday.
    expect(driveCheckDue("2026-11-02", [2, 3, 4, 5, 6], null)).toBe(false);
    expect(driveCheckDue("2026-11-03", [2, 3, 4, 5, 6], null)).toBe(true);
  });
});
