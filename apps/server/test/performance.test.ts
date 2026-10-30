/**
 * Phase 8B (owner decision 29/10/2026): speed with a lot of data, on a real PostgreSQL.
 * 5 000 clients, 6 000 policies, 20 000 payments and 50 000 money movements are written straight
 * into the database, then the main screens must answer in less than 2 seconds each and a backup
 * must take less than one minute.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDay } from "@alyassir/domain";
import type { BackupsDto } from "@alyassir/shared";
import { UsbService } from "../src/backups/usb.service";
import { setupCatalog } from "./fixtures";
import { MANAGER, ownerQuery, startApp, type TestApp } from "./harness";

let t: TestApp;
let manager: string;
let somePolicy: string;
const SCREEN_MS = 2_000;
const BACKUP_MS = 60_000;
const withBackups = Boolean(process.env.ALYASSIR_TEST_PG_BIN);

async function seed(): Promise<void> {
  const s = await setupCatalog(t, manager);
  const m = (await ownerQuery(t.db, "SELECT id FROM users WHERE role = 'manager'")).rows[0]?.id as string;
  const sql = `
    INSERT INTO clients (kind, full_name, id_type, id_number, id_normalized, phone)
      SELECT 'individual', 'Client ' || n, 'cin', 'PF' || n, 'PF' || n, '0661' || lpad(n::text, 6, '0') FROM generate_series(1, 5000) n;
    INSERT INTO vehicles (client_id, plate_type, plate, plate_normalized, fiscal_power, fuel, brand)
      SELECT c.id, 'ww', 'WW' || lpad(substr(c.id_number, 3), 6, '0'), 'WW' || lpad(substr(c.id_number, 3), 6, '0'), 6, 'petrol', 'Dacia'
      FROM clients c WHERE c.id_number LIKE 'PF%';
    CREATE TEMP TABLE perf_p AS
      SELECT g.n, gen_random_uuid() AS policy_id, gen_random_uuid() AS period_id, gen_random_uuid() AS cert_id,
             c.id AS client_id, v.id AS vehicle_id, date '2026-05-01' + (g.n % 180) AS start_date
      FROM generate_series(1, 6000) AS g(n)
      JOIN clients c ON c.id_number = 'PF' || (1 + (g.n - 1) % 5000)
      JOIN vehicles v ON v.client_id = c.id;
    INSERT INTO policies (id, insurer_id, policy_number, number_normalized, client_id, insurance_type_id, origin, created_by)
      SELECT policy_id, $1, 'PERF-' || n, 'PERF' || n, client_id, $2, 'new_issue', $4 FROM perf_p;
    INSERT INTO policy_periods (id, policy_id, seq, operation, start_date, end_date, coverage_duration_id, months, total_amount_cents, validity_status, collection_status, created_by)
      SELECT period_id, policy_id, 1, 'new_issue', start_date, start_date + 364, $3, 12, 200000, 'active', 'outstanding', $4 FROM perf_p;
    INSERT INTO certificates (id, insurer_id, number, number_normalized, policy_id, period_id, vehicle_id, issued_on, reason, created_by)
      SELECT cert_id, $1, 'CPERF-' || n, 'CPERF' || n, policy_id, period_id, vehicle_id, start_date, 'new_issue', $4 FROM perf_p;
    INSERT INTO period_vehicles (period_id, vehicle_id, certificate_id, from_date)
      SELECT period_id, vehicle_id, cert_id, start_date FROM perf_p;
    CREATE TEMP TABLE perf_pay AS
      SELECT g.k AS n, gen_random_uuid() AS id, p.policy_id, p.period_id, p.client_id, p.start_date + (g.k % 30) AS day
      FROM generate_series(1, 20000) AS g(k) JOIN perf_p p ON p.n = 1 + (g.k - 1) % 6000;
    INSERT INTO payments (id, policy_id, period_id, client_id, method, amount_cents, status, received_on, received_by)
      SELECT id, policy_id, period_id, client_id, 'cash', 5000, 'collected', day, $4 FROM perf_pay;
    INSERT INTO financial_transactions (group_id, account_code, amount_cents, kind, payment_id, business_date, user_id)
      SELECT gen_random_uuid(), 'drawer', 5000, 'payment_cash', id, day, $4 FROM perf_pay;
    INSERT INTO financial_transactions (group_id, account_code, amount_cents, kind, business_date, user_id, note)
      SELECT gen_random_uuid(), 'drawer', 100, 'count_adjustment', date '2026-05-01' + (n % 180), $4, 'perf' FROM generate_series(1, 30000) n;
    UPDATE accounts SET balance_cents = (SELECT sum(amount_cents) FROM financial_transactions WHERE account_code = 'drawer') WHERE code = 'drawer';
    ANALYZE;`;
  // pg runs several statements only without parameters: put the four values in literally (UUIDs).
  const values = [s.rma, s.autoType, s.months12, m];
  for (const v of values) expect(v).toMatch(/^[0-9a-f-]{36}$/);
  await ownerQuery(t.db, sql.replace(/\$(\d)/g, (_x, i: string) => `'${values[Number(i) - 1]}'`));
  somePolicy = (await ownerQuery(t.db, "SELECT id FROM policies WHERE policy_number = 'PERF-5999'")).rows[0]?.id as string;
}

/** Time of one call, which must succeed. */
async function timed(method: string, url: string, body?: unknown): Promise<number> {
  const start = performance.now();
  const res = await t.call(method, url, { token: manager, ...(body !== undefined ? { body } : {}) });
  const ms = performance.now() - start;
  expect(res.status, `${method} ${url}: ${JSON.stringify(res.body).slice(0, 300)}`).toBeLessThan(300);
  console.log(`  ${method} ${url}: ${Math.round(ms)} ms`);
  return ms;
}

beforeAll(async () => {
  t = await startApp({ backup: withBackups });
  manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
  if (withBackups) {
    // This month's USB copy is done (it would block the application), and a real backup folder.
    const day = businessDay(new Date());
    await ownerQuery(
      t.db,
      `INSERT INTO usb_backup_gates (month, due_on, remind_from, block_from, done_at, done_by)
       VALUES ($1, $2, now() - interval '2 days', now() - interval '1 day', now(), (SELECT id FROM users WHERE role = 'manager'))
       ON CONFLICT (month) DO UPDATE SET done_at = now(), done_by = EXCLUDED.done_by`,
      [day.slice(0, 7), day],
    );
    await t.app.get(UsbService).refresh();
    const folder = mkdtempSync(join(tmpdir(), "alyassir-perf-drive-"));
    expect((await t.call("PUT", "/api/backups/folder", { token: manager, body: { path: folder } })).status).toBe(200);
  }
  await seed();
}, 300_000);
afterAll(async () => t.close());

describe("speed with a year of data", () => {
  it("the data is there", async () => {
    const n = await ownerQuery(
      t.db,
      `SELECT (SELECT count(*) FROM clients)::int AS clients, (SELECT count(*) FROM policies)::int AS policies,
              (SELECT count(*) FROM payments)::int AS payments, (SELECT count(*) FROM financial_transactions)::int AS moves`,
    );
    expect(n.rows[0]).toEqual({ clients: 5000, policies: 6000, payments: 20000, moves: 50000 });
  });

  it.each([
    ["GET", "/api/clients?q=PF4321"],
    ["GET", "/api/clients?q=Client"],
    ["GET", "/api/policies?q=PERF-5999"],
    ["GET", "/api/policies?endingWithinDays=30"],
    ["GET", "/api/vehicles?q=WW004321"],
    ["GET", "/api/dashboard?period=month"],
    ["GET", "/api/dashboard?period=year"],
    ["GET", "/api/reminders"],
    ["GET", "/api/historical/checklist"],
  ])("%s %s answers in less than 2 seconds", async (method, url) => {
    await timed(method, url); // first call warms the caches
    expect(await timed(method, url)).toBeLessThan(SCREEN_MS);
  });

  it("the policy page and its money answer in less than 2 seconds", async () => {
    for (const url of [`/api/policies/${somePolicy}`, `/api/policies/${somePolicy}/finance`]) {
      await timed("GET", url);
      expect(await timed("GET", url)).toBeLessThan(SCREEN_MS);
    }
  });

  it.each(["payments", "policies", "movements", "dues"])("the %s report of the year answers in less than 2 seconds", async (code) => {
    const body = { language: "ar", from: "2026-01-01", to: "2026-12-31" };
    await timed("POST", `/api/reports/${code}`, body);
    expect(await timed("POST", `/api/reports/${code}`, body)).toBeLessThan(SCREEN_MS);
  });

  it.runIf(withBackups)("a backup of all this takes less than one minute", async () => {
    const ms = await timed("POST", "/api/backups", {});
    expect(ms).toBeLessThan(BACKUP_MS);
    const list = (await t.call("GET", "/api/backups", { token: manager })).body as BackupsDto;
    expect(list.files.some((f) => f.kind === "manual" && f.checked)).toBe(true);
  }, 120_000);
});
