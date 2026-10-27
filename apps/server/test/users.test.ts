import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANAGER, createEmployee, startApp, type TestApp } from "./harness";

let t: TestApp;
let managerToken: string;
let managerId: string;

beforeAll(async () => {
  t = await startApp();
  const s = await t.login(MANAGER.username, MANAGER.password);
  managerToken = s.accessToken;
  managerId = s.me.id;
});
afterAll(async () => t.close());

describe("users (manager only)", () => {
  it("creates an employee, refuses a duplicate name and a short password", async () => {
    await createEmployee(t, managerToken, "ahmed");
    const dup = await t.call("POST", "/api/users", { token: managerToken, body: { username: "AHMED", displayName: "x", password: "secret1" } });
    expect(dup).toMatchObject({ status: 409, body: { code: "USERNAME_TAKEN" } });
    const short = await t.call("POST", "/api/users", { token: managerToken, body: { username: "sara", displayName: "Sara", password: "12345" } });
    expect(short.body.fields.password).toBe("password_too_short");
  });

  it("an employee cannot manage users, see the audit log or change settings", async () => {
    await createEmployee(t, managerToken, "nora");
    const s = await t.login("nora", "secret1");
    for (const [method, url] of [["GET", "/api/users"], ["POST", "/api/users"], ["GET", "/api/audit"], ["PUT", "/api/settings/agency"]] as const) {
      const res = await t.call(method, url, { token: s.accessToken, body: {} });
      expect(res.body.code, `${method} ${url}`).toBe("FORBIDDEN");
    }
    expect((await t.call("GET", "/api/users/directory", { token: s.accessToken })).status).toBe(200);
  });

  it("never disables the manager; disabling an employee cuts their session at once", async () => {
    const res = await t.call("POST", `/api/users/${managerId}/disable`, { token: managerToken });
    expect(res).toMatchObject({ status: 409, body: { code: "CANNOT_DISABLE_MANAGER" } });

    const id = await createEmployee(t, managerToken, "leaver");
    const s = await t.login("leaver", "secret1");
    expect((await t.call("POST", `/api/users/${id}/disable`, { token: managerToken })).body.isActive).toBe(false);
    expect((await t.call("GET", "/api/me", { token: s.accessToken })).status).toBe(401);
    const again = await t.call("POST", "/api/auth/login", { body: { username: "leaver", password: "secret1" } });
    expect(again.body.code).toBe("ACCOUNT_DISABLED");
    // Not deleted: still listed, and can be enabled again.
    expect((await t.call("POST", `/api/users/${id}/enable`, { token: managerToken })).body.isActive).toBe(true);
    await t.login("leaver", "secret1");
  });

  it("refuses to overwrite a colleague's change (version check)", async () => {
    const id = await createEmployee(t, managerToken, "versioned");
    const first = await t.call("PATCH", `/api/users/${id}`, { token: managerToken, body: { version: 1, displayName: "First" } });
    expect(first.body.version).toBe(2);
    const stale = await t.call("PATCH", `/api/users/${id}`, { token: managerToken, body: { version: 1, displayName: "Second" } });
    expect(stale).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
  });

  it("resets a password and signs the employee out everywhere", async () => {
    const id = await createEmployee(t, managerToken, "forgetful");
    const s = await t.login("forgetful", "secret1");
    expect((await t.call("POST", `/api/users/${id}/reset-password`, { token: managerToken, body: { newPassword: "new-pass" } })).status).toBe(204);
    expect((await t.call("GET", "/api/me", { token: s.accessToken })).status).toBe(401);
    await t.login("forgetful", "new-pass");
  });
});

describe("permissions", () => {
  it("are granted per module and take effect at once", async () => {
    const id = await createEmployee(t, managerToken, "clerk");
    const s = await t.login("clerk", "secret1");
    expect(s.me.permissions).toEqual([]);
    const set = await t.call("PUT", `/api/users/${id}/permissions`, { token: managerToken, body: { version: 1, permissions: ["clients.view", "clients.create", "export"] } });
    expect(set.body.permissions).toEqual(["clients.create", "clients.view", "export"]);
    expect([...(await t.call("GET", "/api/me", { token: s.accessToken })).body.permissions].sort()).toEqual(["clients.create", "clients.view", "export"]);
  });

  it("refuses supervisor powers for a non-supervisor, and removes them with the flag", async () => {
    const id = await createEmployee(t, managerToken, "chief");
    const refused = await t.call("PUT", `/api/users/${id}/permissions`, { token: managerToken, body: { version: 1, permissions: ["sup.transfers"] } });
    expect(refused.body.code).toBe("NOT_SUPERVISOR");

    const sup = await t.call("PATCH", `/api/users/${id}`, { token: managerToken, body: { version: 1, isSupervisor: true } });
    expect(sup.body.isSupervisor).toBe(true);
    const granted = await t.call("PUT", `/api/users/${id}/permissions`, { token: managerToken, body: { version: 2, permissions: ["sup.transfers", "policies.edit"] } });
    expect(granted.body.permissions).toEqual(["policies.edit", "sup.transfers"]);

    const s = await t.login("chief", "secret1");
    expect(s.me.canSeeSafeAndBank).toBe(true);

    const removed = await t.call("PATCH", `/api/users/${id}`, { token: managerToken, body: { version: 3, isSupervisor: false } });
    expect(removed.body.permissions).toEqual(["policies.edit"]);
    const me = await t.call("GET", "/api/me", { token: s.accessToken });
    expect(me.body.canSeeSafeAndBank).toBe(false);
  });

  it("a plain employee never sees safe and bank, even with many permissions", async () => {
    const id = await createEmployee(t, managerToken, "busy");
    await t.call("PUT", `/api/users/${id}/permissions`, { token: managerToken, body: { version: 1, permissions: ["payments.view", "payments.create", "closing.view", "drawer_balance.view", "finance_dashboard.view"] } });
    const s = await t.login("busy", "secret1");
    expect(s.me.canSeeSafeAndBank).toBe(false);
  });

  it("the manager cannot be made a supervisor", async () => {
    const res = await t.call("PATCH", `/api/users/${managerId}`, { token: managerToken, body: { version: 1, isSupervisor: true } });
    expect(res.body.code).toBe("NOT_SUPERVISOR");
  });

  it("every change is in the audit log, never with a password", async () => {
    const res = await t.call("GET", "/api/audit?entityType=user&pageSize=200", { token: managerToken });
    const actions = new Set(res.body.items.map((e: { action: string }) => e.action));
    for (const a of ["user.create", "user.update", "user.permissions", "user.disable", "user.enable", "user.reset_password", "system.install"]) {
      expect(actions.has(a), a).toBe(true);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|secret1|new-pass/);
    const item = res.body.items.find((e: { action: string }) => e.action === "user.create");
    expect(item.device).toBe("PC-TEST");
    expect(item.userName).toBe("manager");
  });
});

describe("agency settings", () => {
  it("everyone reads them, only the manager changes them, with version check", async () => {
    const s = await t.call("GET", "/api/settings/agency", { token: managerToken });
    expect(s.body).toMatchObject({ nameAr: "وكالة الاختبار", idleTimeoutMinutes: 60, hasLogo: false, version: 1 });
    const body = { version: 1, nameAr: "وكالة اليسير", nameFr: "Agence Alyassir", address: "الدار البيضاء", phone: "0522000000", licenseNumber: "L-1", idleTimeoutMinutes: 30 };
    expect((await t.call("PUT", "/api/settings/agency", { token: managerToken, body })).body.version).toBe(2);
    expect((await t.call("PUT", "/api/settings/agency", { token: managerToken, body })).body.code).toBe("VERSION_CONFLICT");
    const bad = await t.call("PUT", "/api/settings/agency", { token: managerToken, body: { ...body, version: 2, idleTimeoutMinutes: 2 } });
    expect(bad.body.fields.idleTimeoutMinutes).toBe("idle_range");
  });

  it("accepts one PNG/JPEG logo up to 500 KB and refuses anything else", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
    const version = (await t.call("GET", "/api/settings/agency", { token: managerToken })).body.version;
    const ok = await t.call("PUT", "/api/settings/agency/logo", { token: managerToken, body: { version, dataBase64: png.toString("base64") } });
    expect(ok.body.hasLogo).toBe(true);
    const got = await t.call("GET", "/api/settings/agency/logo", { token: managerToken });
    expect(got.body.type).toBe("image/png");
    const pdf = await t.call("PUT", "/api/settings/agency/logo", { token: managerToken, body: { version: version + 1, dataBase64: Buffer.from("%PDF-1.4").toString("base64") } });
    expect(pdf.body.code).toBe("LOGO_BAD_TYPE");
    const big = Buffer.concat([png, Buffer.alloc(500 * 1024)]);
    const tooBig = await t.call("PUT", "/api/settings/agency/logo", { token: managerToken, body: { version: version + 1, dataBase64: big.toString("base64") } });
    expect(tooBig.body.code).toBe("LOGO_TOO_LARGE");
  });
});
