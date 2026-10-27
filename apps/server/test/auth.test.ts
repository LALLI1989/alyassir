import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_HEADERS, MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";

let t: TestApp;
let managerToken: string;

beforeAll(async () => {
  t = await startApp();
  managerToken = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
});
afterAll(async () => t.close());

describe("sign in", () => {
  it("works for the manager and returns all permissions and safe/bank visibility", async () => {
    const res = await t.login(MANAGER.username, MANAGER.password);
    expect(res.me.role).toBe("manager");
    expect(res.me.permissions).toHaveLength(40);
    expect(res.me.canSeeSafeAndBank).toBe(true);
    expect(res.accessTokenExpiresIn).toBe(15 * 60);
  });

  it("ignores letter case in the username", async () => {
    const res = await t.login("MaNaGeR", MANAGER.password);
    expect(res.me.username).toBe("manager");
  });

  it("gives the same answer for a wrong password and an unknown user", async () => {
    const wrong = await t.call("POST", "/api/auth/login", { body: { username: "manager", password: "nope-nope" } });
    const unknown = await t.call("POST", "/api/auth/login", { body: { username: "ghost", password: "nope-nope" } });
    expect(wrong).toMatchObject({ status: 401, body: { code: "INVALID_CREDENTIALS" } });
    expect(unknown).toMatchObject({ status: 401, body: { code: "INVALID_CREDENTIALS" } });
  });

  it("refuses an app too old for this server", async () => {
    await ownerQuery(t.db, "UPDATE system_info SET min_client_version = '9.0.0'");
    try {
      const res = await t.call("POST", "/api/auth/login", { body: MANAGER });
      expect(res).toMatchObject({ status: 426, body: { code: "CLIENT_TOO_OLD" } });
    } finally {
      await ownerQuery(t.db, "UPDATE system_info SET min_client_version = '0.1.0'");
    }
  });

  it("requires the app version header to sign in", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: MANAGER });
    expect(res.statusCode).toBe(426);
  });
});

describe("lock after 5 wrong passwords (15 minutes)", () => {
  it("locks, refuses even the right password, and the manager can unlock", async () => {
    const id = await createEmployee(t, managerToken, "locky", "right-pass");
    for (let i = 1; i <= 4; i++) {
      const r = await t.call("POST", "/api/auth/login", { body: { username: "locky", password: "wrong" } });
      expect(r.body.code).toBe("INVALID_CREDENTIALS");
    }
    const fifth = await t.call("POST", "/api/auth/login", { body: { username: "locky", password: "wrong" } });
    expect(fifth).toMatchObject({ status: 403, body: { code: "ACCOUNT_LOCKED" } });
    const minutes = (Date.parse(fifth.body.lockedUntil as string) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    const right = await t.call("POST", "/api/auth/login", { body: { username: "locky", password: "right-pass" } });
    expect(right.body.code).toBe("ACCOUNT_LOCKED");

    const list = await t.call("GET", "/api/users", { token: managerToken });
    expect(list.body.find((u: { id: string }) => u.id === id).lockedUntil).not.toBeNull();

    const unlock = await t.call("POST", `/api/users/${id}/unlock`, { token: managerToken });
    expect(unlock.status).toBe(200);
    await t.login("locky", "right-pass");
  });

  it("unlocks by itself after 15 minutes", async () => {
    await createEmployee(t, managerToken, "waiter", "right-pass");
    for (let i = 0; i < 5; i++) await t.call("POST", "/api/auth/login", { body: { username: "waiter", password: "wrong" } });
    await ownerQuery(t.db, "UPDATE users SET locked_until = now() - interval '1 second' WHERE username = 'waiter'");
    await t.login("waiter", "right-pass");
  });

  it("records failed sign-ins and the lock in the audit log", async () => {
    const res = await t.call("GET", "/api/audit?action=auth.locked", { token: managerToken });
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });
});

describe("tokens and sessions", () => {
  it("refresh rotates the refresh token: the old one stops working", async () => {
    const first = await t.login(MANAGER.username, MANAGER.password);
    const r1 = await t.call("POST", "/api/auth/refresh", { body: { refreshToken: first.refreshToken } });
    expect(r1.status).toBe(200);
    const again = await t.call("POST", "/api/auth/refresh", { body: { refreshToken: first.refreshToken } });
    expect(again).toMatchObject({ status: 401, body: { code: "UNAUTHENTICATED" } });
    const me = await t.call("GET", "/api/me", { token: r1.body.accessToken });
    expect(me.status).toBe(200);
  });

  it("logout ends the session at once", async () => {
    const s = await t.login(MANAGER.username, MANAGER.password);
    expect((await t.call("POST", "/api/auth/logout", { token: s.accessToken })).status).toBe(204);
    expect((await t.call("GET", "/api/me", { token: s.accessToken })).body.code).toBe("UNAUTHENTICATED");
    expect((await t.call("POST", "/api/auth/refresh", { body: { refreshToken: s.refreshToken } })).status).toBe(401);
  });

  it("ends a session after the idle time set by the manager (60 minutes by default)", async () => {
    const s = await t.login(MANAGER.username, MANAGER.password);
    await ownerQuery(t.db, "UPDATE sessions SET last_activity_at = now() - interval '61 minutes' WHERE revoked_at IS NULL AND id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)");
    const res = await t.call("GET", "/api/me", { token: s.accessToken });
    expect(res).toMatchObject({ status: 401, body: { code: "SESSION_EXPIRED" } });
    expect((await t.call("POST", "/api/auth/refresh", { body: { refreshToken: s.refreshToken } })).status).toBe(401);
  });

  it("background requests do not keep a session alive, real use does", async () => {
    const s = await t.login(MANAGER.username, MANAGER.password);
    const sid = (await ownerQuery(t.db, "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0]?.id;
    await ownerQuery(t.db, "UPDATE sessions SET last_activity_at = now() - interval '10 minutes' WHERE id = $1", [sid]);
    const background = { ...CLIENT_HEADERS, "x-alyassir-user-active": "0" };
    await t.call("GET", "/api/me", { token: s.accessToken, headers: background });
    let row = await ownerQuery(t.db, "SELECT extract(epoch FROM now() - last_activity_at) AS age FROM sessions WHERE id = $1", [sid]);
    expect(Number(row.rows[0]?.age)).toBeGreaterThan(500);
    await t.call("GET", "/api/me", { token: s.accessToken });
    row = await ownerQuery(t.db, "SELECT extract(epoch FROM now() - last_activity_at) AS age FROM sessions WHERE id = $1", [sid]);
    expect(Number(row.rows[0]?.age)).toBeLessThan(5);
  });

  it("refuses a forged token", async () => {
    const res = await t.call("GET", "/api/me", { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad" });
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });
});

describe("own password and language", () => {
  it("changes the password (current one required) and signs out other devices", async () => {
    await createEmployee(t, managerToken, "pwuser", "first-pass");
    const a = await t.login("pwuser", "first-pass");
    const b = await t.login("pwuser", "first-pass");
    const bad = await t.call("POST", "/api/me/password", { token: a.accessToken, body: { currentPassword: "nope", newPassword: "second-pass" } });
    expect(bad.body.code).toBe("WRONG_PASSWORD");
    const short = await t.call("POST", "/api/me/password", { token: a.accessToken, body: { currentPassword: "first-pass", newPassword: "12345" } });
    expect(short).toMatchObject({ status: 400, body: { code: "VALIDATION", fields: { newPassword: "password_too_short" } } });
    const ok = await t.call("POST", "/api/me/password", { token: a.accessToken, body: { currentPassword: "first-pass", newPassword: "second-pass" } });
    expect(ok.status).toBe(204);
    expect((await t.call("GET", "/api/me", { token: a.accessToken })).status).toBe(200);
    expect((await t.call("GET", "/api/me", { token: b.accessToken })).status).toBe(401);
    await t.login("pwuser", "second-pass");
  });

  it("a new employee has no language until they choose one", async () => {
    await createEmployee(t, managerToken, "langy", "secret1");
    const s = await t.login("langy", "secret1");
    expect(s.me.language).toBeNull();
    expect((await t.call("PUT", "/api/me/language", { token: s.accessToken, body: { language: "fr" } })).status).toBe(204);
    expect((await t.call("GET", "/api/me", { token: s.accessToken })).body.language).toBe("fr");
  });
});
