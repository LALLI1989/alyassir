import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  MODULE_PERMISSIONS,
  SUPERVISOR_PERMISSIONS,
  compareVersions,
  createThreadSchema,
  createUserSchema,
  setPermissionsSchema,
} from "./index";

describe("permission catalog", () => {
  it("has 10 modules x 3 levels, 2 extras and 8 supervisor powers", () => {
    expect(MODULE_PERMISSIONS).toHaveLength(30);
    expect(SUPERVISOR_PERMISSIONS).toHaveLength(8);
    expect(ALL_PERMISSIONS).toHaveLength(40);
    expect(new Set(ALL_PERMISSIONS).size).toBe(40);
  });

  it("rejects unknown permission codes", () => {
    expect(setPermissionsSchema.safeParse({ version: 1, permissions: ["clients.view", "root"] }).success).toBe(false);
    const ok = setPermissionsSchema.parse({ version: 1, permissions: ["clients.view", "clients.view"] });
    expect(ok.permissions).toEqual(["clients.view"]);
  });
});

describe("user schema", () => {
  it("accepts a 6-character password and refuses 5", () => {
    const base = { username: "ahmed", displayName: "Ahmed" };
    expect(createUserSchema.safeParse({ ...base, password: "123456" }).success).toBe(true);
    const short = createUserSchema.safeParse({ ...base, password: "12345" });
    expect(short.success).toBe(false);
    expect(short.error?.issues[0]?.message).toBe("password_too_short");
  });

  it("refuses usernames with spaces or Arabic letters", () => {
    for (const username of ["a b", "أحمد", "ab"]) {
      expect(createUserSchema.safeParse({ username, displayName: "x", password: "123456" }).success).toBe(false);
    }
  });
});

describe("message schema", () => {
  const id1 = "11111111-1111-4111-8111-111111111111";
  it("needs at least one To recipient and refuses the same person in To and CC", () => {
    expect(createThreadSchema.safeParse({ subject: "s", body: "b", to: [] }).success).toBe(false);
    expect(createThreadSchema.safeParse({ subject: "s", body: "b", to: [id1], cc: [id1] }).success).toBe(false);
    expect(createThreadSchema.safeParse({ subject: "s", body: "b", to: [id1] }).success).toBe(true);
  });
});

describe("compareVersions", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
  });
});
