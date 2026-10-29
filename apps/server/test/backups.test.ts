/**
 * Phase 6B on a real PostgreSQL with the real pg_dump / pg_restore: backups (manual, hourly,
 * daily), keeping times, the folder, the monthly USB copy (reminder, blocking, copy, skip), and a
 * real restore (with the safety copy and the refusal of a newer backup).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, atLocal, businessDay, localClock } from "@alyassir/domain";
import type { BackupFileDto, BackupsDto, UsbStateDto } from "@alyassir/shared";
import { BackupJobs } from "../src/backups/backup-jobs";
import { BackupsService } from "../src/backups/backups.service";
import { UsbService } from "../src/backups/usb.service";
import { MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";
import { createClient } from "./fixtures";

let t: TestApp;
let manager: string;
let drive: string;
let service: BackupsService;
let usb: UsbService;
const month = () => localClock(new Date()).day.slice(0, 7);

async function employee(name: string, permissions: string[], supervisor = false): Promise<string> {
  const id = await createEmployee(t, manager, name);
  let user = (await t.call("GET", `/api/users/${id}`, { token: manager })).body;
  if (supervisor) user = (await t.call("PATCH", `/api/users/${id}`, { token: manager, body: { version: user.version, isSupervisor: true } })).body;
  await t.call("PUT", `/api/users/${id}/permissions`, { token: manager, body: { version: user.version, permissions } });
  return (await t.login(name, "secret1")).accessToken;
}

const list = async (): Promise<BackupsDto> => (await t.call("GET", "/api/backups", { token: manager })).body;
const clientNames = async (token = manager): Promise<string[]> =>
  ((await t.call("GET", "/api/clients?pageSize=100", { token })).body.items as { fullName: string }[]).map((c) => c.fullName);

/** This month's USB copy marked done, so the other tests are not blocked whatever the date. */
async function usbDone(): Promise<void> {
  const now = new Date();
  await ownerQuery(
    t.db,
    `INSERT INTO usb_backup_gates (month, due_on, remind_from, block_from, done_at, done_by)
     VALUES ($1, $2, now() - interval '2 days', now() - interval '1 day', now(), (SELECT id FROM users WHERE role = 'manager'))
     ON CONFLICT (month) DO UPDATE SET done_at = now(), done_by = EXCLUDED.done_by, skipped_at = NULL, skipped_by = NULL, skip_reason = NULL`,
    [month(), businessDay(now)],
  );
  await usb.refresh();
}

beforeAll(async () => {
  t = await startApp({ backup: true });
  manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
  service = t.app.get(BackupsService);
  usb = t.app.get(UsbService);
  drive = mkdtempSync(join(tmpdir(), "alyassir-drive-"));
  mkdirSync(service.config?.usbTestDir ?? "", { recursive: true });
  await usbDone();
  expect((await t.call("PUT", "/api/backups/folder", { token: manager, body: { path: drive } })).status).toBe(200);
});
afterAll(async () => t.close());

describe("backups (SPEC 20)", () => {
  it("only the manager sees or takes backups", async () => {
    const emp = await employee("noback", ["clients.view"]);
    expect((await t.call("GET", "/api/backups", { token: emp })).status).toBe(403);
    expect((await t.call("POST", "/api/backups", { token: emp })).status).toBe(403);
    expect((await t.call("GET", "/api/backups/usb", { token: emp })).status).toBe(200);
  });

  it("a backup taken now: a real dump with its SHA-256 file", async () => {
    const res = await t.call("POST", "/api/backups", { token: manager });
    expect(res.status).toBe(200);
    const dto = res.body as BackupsDto;
    expect(dto).toMatchObject({ enabled: true, dir: drive, dirProblem: null, lastError: null });
    const f = dto.files.find((x) => x.kind === "manual") as BackupFileDto;
    expect(f.place).toBe("drive");
    expect(f.sizeBytes).toBeGreaterThan(1000);
    expect(f.checked).toBe(true);
    const file = join(drive, "manual", f.name);
    expect(readFileSync(`${file}.sha256`, "utf8")).toMatch(new RegExp(`^[0-9a-f]{64}  ${f.name}`));
    expect(dto.lastOkAt).not.toBeNull();
    const audit = await ownerQuery(t.db, "SELECT action FROM audit_log WHERE action = 'backup.manual'");
    expect(audit.rows).toHaveLength(1);
  });

  it("the folder must exist (or be creatable) and be writable", async () => {
    expect((await t.call("PUT", "/api/backups/folder", { token: manager, body: { path: "relative/folder" } })).body.code).toBe("BACKUP_DIR_UNUSABLE");
    expect((await t.call("PUT", "/api/backups/folder", { token: manager, body: { path: join(drive, "no", "such") } })).body.code).toBe("BACKUP_DIR_UNUSABLE");
    expect((await list()).dir).toBe(drive);
  });

  it("hourly during working hours, daily after them; each period once", async () => {
    const jobs = t.app.get(BackupJobs);
    // Saturday 31/10/2026 10:00: the hourly of 10:00 and the daily of Friday (caught up).
    await jobs.run(atLocal("2026-10-31", "10:00"));
    expect(readdirSync(join(drive, "hourly", "2026-10-31"))).toContain("alyassir-hourly-2026-10-31-1000.dump");
    expect(readdirSync(join(drive, "2026-10"))).toContain("alyassir-daily-2026-10-30.dump");
    await jobs.run(atLocal("2026-10-31", "10:20"));
    expect(readdirSync(join(drive, "hourly", "2026-10-31")).filter((n) => n.endsWith(".dump"))).toHaveLength(1);
    // Sunday: no hourly backup.
    await jobs.run(atLocal("2026-11-01", "11:00"));
    expect(existsSync(join(drive, "hourly", "2026-11-01"))).toBe(false);
    const runs = await ownerQuery(t.db, "SELECT kind, slot FROM backup_runs WHERE status = 'ok' AND kind IN ('hourly', 'daily') ORDER BY kind, slot");
    expect(runs.rows).toEqual([
      { kind: "daily", slot: "2026-10-30" },
      { kind: "daily", slot: "2026-10-31" },
      { kind: "hourly", slot: "2026-10-31T10" },
    ]);
  });

  it("keeping times: hourly 30 days, daily 6 months", async () => {
    const today = businessDay(new Date());
    const oldHour = addDays(today, -31);
    const recentDaily = addDays(today, -150);
    const oldDaily = addDays(today, -200);
    const put = (rel: string) => {
      mkdirSync(join(drive, rel, ".."), { recursive: true });
      writeFileSync(join(drive, rel), "old");
    };
    put(`hourly/${oldHour}/alyassir-hourly-${oldHour}-1000.dump`);
    put(`${recentDaily.slice(0, 7)}/alyassir-daily-${recentDaily}.dump`);
    put(`${oldDaily.slice(0, 7)}/alyassir-daily-${oldDaily}.dump`);
    await service.take("hourly", `${today}T-keep`, null, atLocal(today, "10:00"));
    await expect.poll(() => existsSync(join(drive, `hourly/${oldHour}/alyassir-hourly-${oldHour}-1000.dump`)), { timeout: 5000 }).toBe(false);
    expect(existsSync(join(drive, `${oldDaily.slice(0, 7)}/alyassir-daily-${oldDaily}.dump`))).toBe(false);
    expect(existsSync(join(drive, `${recentDaily.slice(0, 7)}/alyassir-daily-${recentDaily}.dump`))).toBe(true);
  });

  it("the manager's dashboard says when the last good backup was taken", async () => {
    const d = (await t.call("GET", "/api/dashboard", { token: manager })).body;
    expect(d.backup).toMatchObject({ enabled: true, dirProblem: null });
    expect(d.backup.lastOkAt).not.toBeNull();
  });
});

describe("restore (SPEC 20): safety copy first, a real restore, compatibility check", () => {
  it("a client added after the backup is gone after the restore; the safety copy brings it back", async () => {
    await createClient(t, manager, { fullName: "Karim AVANT" });
    const taken = (await t.call("POST", "/api/backups", { token: manager })).body as BackupsDto;
    const backup = taken.files.filter((f) => f.kind === "manual")[0] as BackupFileDto;
    await createClient(t, manager, { fullName: "Samir APRES" });
    expect(await clientNames()).toEqual(expect.arrayContaining(["Karim AVANT", "Samir APRES"]));

    expect((await t.call("POST", `/api/backups/${backup.id}/restore`, { token: manager, body: { password: "wrong" } })).body.code).toBe("WRONG_PASSWORD");
    const emp = await employee("restorer", ["clients.view"]);
    expect((await t.call("POST", `/api/backups/${backup.id}/restore`, { token: emp, body: { password: "secret1" } })).status).toBe(403);

    const res = await t.call("POST", `/api/backups/${backup.id}/restore`, { token: manager, body: { password: MANAGER.password } });
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(backup.name);
    manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
    const names = await clientNames();
    expect(names).toContain("Karim AVANT");
    expect(names).not.toContain("Samir APRES");
    const audit = await ownerQuery(t.db, "SELECT after FROM audit_log WHERE action = 'backup.restore'");
    expect(audit.rows[0]?.after).toMatchObject({ restored: backup.name, safetyCopy: res.body.safety });

    const after = await list();
    const safety = after.files.find((f) => f.name === res.body.safety) as BackupFileDto;
    expect(safety).toMatchObject({ kind: "safety", place: "internal", checked: true });
    expect((await t.call("POST", `/api/backups/${safety.id}/restore`, { token: manager, body: { password: MANAGER.password } })).status).toBe(200);
    manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
    expect(await clientNames()).toContain("Samir APRES");
    await usbDone();
  });

  it("refuses a backup made by a newer version, and a damaged one; nothing changes", async () => {
    await ownerQuery(t.db, "INSERT INTO schema_migrations (version, name, checksum) VALUES ('9999', 'future', 'x')");
    const taken = (await t.call("POST", "/api/backups", { token: manager })).body as BackupsDto;
    await ownerQuery(t.db, "DELETE FROM schema_migrations WHERE version = '9999'");
    const newer = taken.files.filter((f) => f.kind === "manual")[0] as BackupFileDto;
    expect((await t.call("POST", `/api/backups/${newer.id}/restore`, { token: manager, body: { password: MANAGER.password } })).body.code).toBe("BACKUP_NEWER");

    const older = taken.files.filter((f) => f.kind === "manual")[1] as BackupFileDto;
    writeFileSync(join(drive, "manual", `${older.name}.sha256`), `${"0".repeat(64)}  ${older.name}\r\n`);
    expect((await t.call("POST", `/api/backups/${older.id}/restore`, { token: manager, body: { password: MANAGER.password } })).body.code).toBe("BACKUP_CORRUPT");
    expect(await clientNames()).toContain("Samir APRES");
  });

  it("while a restore runs, every route answers RESTORING", async () => {
    (service as unknown as { restoringNow: boolean }).restoringNow = true;
    try {
      expect((await t.call("GET", "/api/clients", { token: manager })).body.code).toBe("RESTORING");
      expect((await t.call("GET", "/api/health")).status).toBe(200);
    } finally {
      (service as unknown as { restoringNow: boolean }).restoringNow = false;
    }
  });

  it("the manager deletes a backup file (written in the audit log)", async () => {
    const before = await list();
    const f = before.files.find((x) => x.kind === "manual") as BackupFileDto;
    expect((await t.call("DELETE", `/api/backups/${f.id}`, { token: manager })).status).toBe(200);
    expect((await list()).files.some((x) => x.id === f.id)).toBe(false);
    expect(existsSync(join(drive, "manual", f.name))).toBe(false);
    expect((await t.call("DELETE", "/api/backups/bm90aGluZw", { token: manager })).status).toBe(404);
  });
});

describe("monthly USB copy (owner decision 29/10/2026)", () => {
  const block = async () => {
    await ownerQuery(t.db, "UPDATE usb_backup_gates SET done_at = NULL, done_by = NULL, skipped_at = NULL, skipped_by = NULL, skip_reason = NULL, block_from = now() - interval '1 hour' WHERE month = $1", [month()]);
    await usb.refresh();
  };

  it("reminder first: the first Friday at 13:00, blocking from the next working day", async () => {
    await usb.refresh(atLocal("2027-01-01", "12:00"));
    expect((await ownerQuery(t.db, "SELECT 1 FROM usb_backup_gates WHERE month = '2027-01'")).rows).toHaveLength(0);
    expect(await usb.refresh(atLocal("2027-01-01", "13:05"))).toBe("remind");
    expect(await usb.refresh(atLocal("2027-01-02", "08:00"))).toBe("block");
    await usbDone();
  });

  it("when overdue the application stops; the copy at the server computer unblocks it", async () => {
    await block();
    expect((await t.call("GET", "/api/clients", { token: manager })).body.code).toBe("USB_BACKUP_REQUIRED");
    const state = (await t.call("GET", "/api/backups/usb", { token: manager })).body as UsbStateDto;
    expect(state).toMatchObject({ state: "block", atServer: true, canSkip: true });
    expect(state.drives.map((d) => d.drive)).toEqual(["test"]);
    // From another computer: refused (the key is in the server).
    expect((await t.call("POST", "/api/backups/usb/copy", { token: manager, body: { drive: "test" }, remoteAddress: "10.9.8.7" })).body.code).toBe("USB_NOT_AT_SERVER");

    const emp = await employee("usbcopier", ["clients.view"]);
    const done = await t.call("POST", "/api/backups/usb/copy", { token: emp, body: { drive: "test" } });
    expect(done.status).toBe(200);
    expect(done.body.state).toBe("none");
    const key = join(service.config?.usbTestDir ?? "", "Alyassir");
    const files = readdirSync(key).filter((n) => n.endsWith(".dump"));
    expect(files).toHaveLength(1);
    expect(existsSync(join(key, `${files[0]}.sha256`))).toBe(true);
    expect((await t.call("GET", "/api/clients", { token: manager })).status).toBe(200);
  });

  it("skipping needs the manager or a supervisor with the power, and a reason", async () => {
    await block();
    const emp = await employee("usbplain", ["clients.view"]);
    expect((await t.call("POST", "/api/backups/usb/skip", { token: emp, body: { reason: "Pas de clé" } })).status).toBe(403);
    const sup = await employee("usbsup", ["clients.view", "sup.skip_usb_backup"], true);
    expect((await t.call("POST", "/api/backups/usb/skip", { token: sup, body: { reason: "" } })).status).toBe(400);
    const res = await t.call("POST", "/api/backups/usb/skip", { token: sup, body: { reason: "Clé oubliée à la maison" } });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("none");
    const audit = await ownerQuery(t.db, "SELECT reason FROM audit_log WHERE action = 'backup.usb_skip'");
    expect(audit.rows[0]?.reason).toBe("Clé oubliée à la maison");
    const msg = await ownerQuery(t.db, "SELECT m.body FROM messages m JOIN message_threads th ON th.id = m.thread_id WHERE th.subject = 'system:usb_skipped'");
    expect(JSON.parse(String(msg.rows[0]?.body)).params).toMatchObject({ employee: "USBSUP", reason: "Clé oubliée à la maison" });
    expect((await t.call("GET", "/api/clients", { token: emp })).status).toBe(200);
  });
});
