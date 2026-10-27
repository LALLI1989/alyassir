import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "@alyassir/shared";
import { afterFailedLogin, canSeeSafeAndBank, effectivePermissions, isIdleExpired, isLocked, sanitizeGrant } from "./index";

describe("effectivePermissions", () => {
  it("gives the manager everything", () => {
    expect(effectivePermissions({ role: "manager", isSupervisor: false, granted: [] })).toEqual(ALL_PERMISSIONS);
  });

  it("drops supervisor powers when the employee is not a supervisor", () => {
    const granted = ["clients.view", "sup.transfers", "bogus"];
    expect(effectivePermissions({ role: "employee", isSupervisor: false, granted })).toEqual(["clients.view"]);
    expect(effectivePermissions({ role: "employee", isSupervisor: true, granted })).toEqual(["clients.view", "sup.transfers"]);
  });

  it("sanitizeGrant removes supervisor powers for non-supervisors", () => {
    expect(sanitizeGrant(["policies.edit", "sup.refunds"], false)).toEqual(["policies.edit"]);
    expect(sanitizeGrant(["policies.edit", "sup.refunds"], true)).toEqual(["policies.edit", "sup.refunds"]);
  });
});

describe("canSeeSafeAndBank", () => {
  it("is true for the manager only, or a supervisor with transfers / insurer payments", () => {
    expect(canSeeSafeAndBank({ role: "manager", isSupervisor: false, granted: [] })).toBe(true);
    expect(canSeeSafeAndBank({ role: "employee", isSupervisor: false, granted: ["sup.transfers"] })).toBe(false);
    expect(canSeeSafeAndBank({ role: "employee", isSupervisor: true, granted: ["sup.refunds", "drawer_balance.view"] })).toBe(false);
    expect(canSeeSafeAndBank({ role: "employee", isSupervisor: true, granted: ["sup.transfers"] })).toBe(true);
    expect(canSeeSafeAndBank({ role: "employee", isSupervisor: true, granted: ["sup.insurer_payments_withdrawals"] })).toBe(true);
  });
});

describe("login lock", () => {
  const now = new Date("2026-10-27T10:00:00Z");
  it("locks for 15 minutes on the 5th wrong password", () => {
    let c = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < 4; i++) c = afterFailedLogin(c, now);
    expect(c).toEqual({ failedAttempts: 4, lockedUntil: null });
    c = afterFailedLogin(c, now);
    expect(c.failedAttempts).toBe(0);
    expect(c.lockedUntil?.toISOString()).toBe("2026-10-27T10:15:00.000Z");
    expect(isLocked(c, new Date("2026-10-27T10:14:59Z"))).toBe(true);
    expect(isLocked(c, new Date("2026-10-27T10:15:01Z"))).toBe(false);
  });

  it("expires a session after the idle time", () => {
    const last = new Date("2026-10-27T09:00:00Z");
    expect(isIdleExpired(last, 60, new Date("2026-10-27T10:00:00Z"))).toBe(false);
    expect(isIdleExpired(last, 60, new Date("2026-10-27T10:00:01Z"))).toBe(true);
  });
});
