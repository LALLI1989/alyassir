/**
 * Phase 8A on a real PostgreSQL (owner decisions 29/10/2026): the manager's printed recovery code,
 * the server-computer tool, the Google Drive watch and the weekly "I checked".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { atLocal } from "@alyassir/domain";
import type { BackupsDto, DriveStateDto, RemindersDto } from "@alyassir/shared";
import { DriveService } from "../src/backups/drive.service";
import { resetManagerInDb } from "../src/setup/reset-manager";
import { MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";

let t: TestApp;
let manager: string;
let printed: string;
const CODE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;

beforeAll(async () => {
  t = await startApp();
  manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
  printed = t.db.recoveryCode as string;
});
afterAll(async () => t.close());

const recover = (username: string, code: string, newPassword: string) => t.call("POST", "/api/auth/recover", { body: { username, code, newPassword } });

describe("manager recovery code", () => {
  it("is made at installation (16 characters, only its hash is stored)", async () => {
    expect(printed).toMatch(CODE);
    const row = (await ownerQuery(t.db, "SELECT recovery_code_hash FROM users WHERE role = 'manager'")).rows[0];
    expect(String(row?.recovery_code_hash)).toMatch(/^\$argon2id\$/);
    expect((await t.call("GET", "/api/me/recovery-code", { token: manager })).body).toMatchObject({ exists: true });
  });

  it("refuses a wrong code, an employee's name, a code with bad characters", async () => {
    await createEmployee(t, manager, "karima");
    expect((await recover(MANAGER.username, "AAAA-AAAA-AAAA-AAAA", "new-pass-1")).body.code).toBe("RECOVERY_INVALID");
    expect((await recover("karima", printed, "new-pass-1")).body.code).toBe("RECOVERY_INVALID");
    expect((await recover(MANAGER.username, "0000-1111-OOOO-IIII", "new-pass-1")).body.code).toBe("RECOVERY_INVALID");
    expect((await recover(MANAGER.username, printed, "123")).body.code).toBe("VALIDATION");
  });

  it("sets a new password, ends the manager's sessions, gives a new code; the old code stops working", async () => {
    const res = await recover(MANAGER.username, printed.toLowerCase().replace(/-/g, " "), "new-pass-1");
    expect(res.status).toBe(200);
    expect(res.body.recoveryCode).toMatch(CODE);
    expect(res.body.recoveryCode).not.toBe(printed);
    expect((await t.call("GET", "/api/me", { token: manager })).status).toBe(401);
    expect((await t.call("POST", "/api/auth/login", { body: { username: MANAGER.username, password: MANAGER.password } })).status).toBe(401);
    manager = (await t.login(MANAGER.username, "new-pass-1")).accessToken;
    expect((await recover(MANAGER.username, printed, "new-pass-2")).body.code).toBe("RECOVERY_INVALID");
    printed = res.body.recoveryCode;
    const audit = await ownerQuery(t.db, "SELECT after FROM audit_log WHERE action = 'auth.recovered'");
    expect(audit.rows.map((r) => r.after)).toEqual([{ way: "code" }]);
    const msgs = await ownerQuery(t.db, "SELECT subject FROM message_threads WHERE subject = 'system:manager_recovered'");
    expect(msgs.rows).toHaveLength(1);
  });

  it("five wrong codes lock it for a while, even with the right code", async () => {
    await ownerQuery(t.db, "UPDATE users SET recovery_failed = 0 WHERE role = 'manager'");
    for (let i = 0; i < 4; i++) expect((await recover(MANAGER.username, "AAAA-AAAA-AAAA-AAAA", "new-pass-3")).body.code).toBe("RECOVERY_INVALID");
    expect((await recover(MANAGER.username, "AAAA-AAAA-AAAA-AAAA", "new-pass-3")).body.code).toBe("RECOVERY_LOCKED");
    expect((await recover(MANAGER.username, printed, "new-pass-3")).body.code).toBe("RECOVERY_LOCKED");
    await ownerQuery(t.db, "UPDATE users SET recovery_locked_until = now() - interval '1 minute' WHERE role = 'manager'");
  });

  it("My account: a new code needs the password; only the manager", async () => {
    expect((await t.call("POST", "/api/me/recovery-code", { token: manager, body: { password: "wrong" } })).body.code).toBe("WRONG_PASSWORD");
    const made = await t.call("POST", "/api/me/recovery-code", { token: manager, body: { password: "new-pass-1" } });
    expect(made.body.recoveryCode).toMatch(CODE);
    expect((await recover(MANAGER.username, printed, "new-pass-3")).body.code).toBe("RECOVERY_INVALID");
    printed = made.body.recoveryCode;
    const emp = (await t.login("karima", "secret1")).accessToken;
    expect((await t.call("GET", "/api/me/recovery-code", { token: emp })).status).toBe(403);
    expect((await t.call("POST", "/api/me/recovery-code", { token: emp, body: { password: "secret1" } })).status).toBe(403);
  });

  it("the server-computer tool: new password, sessions ended, new code, written in the log", async () => {
    const done = await resetManagerInDb(t.db.ownerUrl, MANAGER.password, "Administrateur");
    expect(done).toMatchObject({ username: MANAGER.username });
    expect(done.recoveryCode).toMatch(CODE);
    expect((await t.call("GET", "/api/me", { token: manager })).status).toBe(401);
    manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
    expect((await recover(MANAGER.username, printed, "x-pass-77")).body.code).toBe("RECOVERY_INVALID");
    const audit = await ownerQuery(t.db, "SELECT after, device FROM audit_log WHERE action = 'auth.recovered' ORDER BY id");
    expect(audit.rows.at(-1)).toEqual({ after: { way: "server_tool", windowsUser: "Administrateur" }, device: "server-tool" });
    const msgs = await ownerQuery(t.db, "SELECT count(*)::int AS n FROM message_threads WHERE subject = 'system:manager_recovered'");
    expect(msgs.rows[0]?.n).toBe(2);
  });
});

describe("Google Drive watch and the weekly check", () => {
  const monday10 = atLocal("2026-11-02", "10:00");
  const monday11 = atLocal("2026-11-02", "11:00");

  it("Drive not running: one message a day, a warning on the screens", async () => {
    const drive = t.app.get(DriveService);
    drive.setProbe(async () => false);
    await drive.check(monday10);
    await drive.check(monday10);
    await drive.check(monday11);
    const msgs = await ownerQuery(t.db, "SELECT count(*)::int AS n FROM message_threads WHERE subject = 'system:drive_not_running'");
    expect(msgs.rows[0]?.n).toBe(1);
    const list = (await t.call("GET", "/api/backups", { token: manager })).body as BackupsDto;
    expect(list.drive).toMatchObject({ running: false });
    const status = (await t.call("GET", "/api/dashboard?period=month", { token: manager })).body;
    expect(status.backup.drive.running).toBe(false);
    drive.setProbe(async () => true);
    await drive.check(atLocal("2026-11-02", "12:00"));
    expect(((await t.call("GET", "/api/backups", { token: manager })).body as BackupsDto).drive.running).toBe(true);
    // Outside working hours: nothing is checked.
    drive.setProbe(async () => false);
    await drive.check(atLocal("2026-11-02", "22:00"));
    expect(((await t.call("GET", "/api/backups", { token: manager })).body as BackupsDto).drive.running).toBe(true);
  });

  it("weekly reminder for the manager until he presses I checked", async () => {
    await ownerQuery(t.db, "UPDATE drive_watch SET confirmed_week = NULL");
    const r = (await t.call("GET", "/api/reminders", { token: manager })).body as RemindersDto;
    expect(r.groups[0]?.kind).toBe("drive_check");
    const emp = (await t.login("karima", "secret1")).accessToken;
    expect((await t.call("POST", "/api/backups/drive-checked", { token: emp })).status).toBe(403);
    const after = (await t.call("POST", "/api/backups/drive-checked", { token: manager })).body as DriveStateDto;
    expect(after.confirmDue).toBe(false);
    expect(after.confirmedAt).not.toBeNull();
    const r2 = (await t.call("GET", "/api/reminders", { token: manager })).body as RemindersDto;
    expect(r2.groups.find((g) => g.kind === "drive_check")).toBeUndefined();
    const audit = await ownerQuery(t.db, "SELECT count(*)::int AS n FROM audit_log WHERE action = 'backup.drive_checked'");
    expect(audit.rows[0]?.n).toBe(1);
  });
});
