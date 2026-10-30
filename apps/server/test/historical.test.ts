/**
 * Phase 7 on a real PostgreSQL: the first-start question, historical entry "as if live since
 * 01/05/2026" (money on its day, rules by the operation date, oldest first), the checklist, the
 * button that starts live work, and the late policy of the manager afterwards (owner decisions 29/10/2026).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, businessDay } from "@alyassir/domain";
import { HEADER_AS_OF, HEADER_LATE_REASON, type HistoricalChecklistDto, type ListItemDto } from "@alyassir/shared";
import { MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";
import { cert, createClient, createVehicle, next, receiveDrawer, setupCatalog, type Setup } from "./fixtures";

let t: TestApp;
let manager: string;
let s: Setup;
let clerk: string;
const at = (day: string) => ({ [HEADER_AS_OF]: day });
const today = () => businessDay(new Date());

async function employee(name: string, permissions: string[]): Promise<string> {
  const id = await createEmployee(t, manager, name);
  const user = (await t.call("GET", `/api/users/${id}`, { token: manager })).body;
  await t.call("PUT", `/api/users/${id}/permissions`, { token: manager, body: { version: user.version, permissions } });
  return (await t.login(name, "secret1")).accessToken;
}

const policyBody = (client: string, vehicle: string, over: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  clientId: client,
  insuranceTypeId: s.autoType,
  policyNumber: `HIST-${next()}`,
  coverageDurationId: s.months1,
  totalAmountCents: 200_000,
  isFleet: false,
  vehicles: [{ vehicleId: vehicle, certificateNumber: cert() }],
  ...over,
});
async function insured(day: string, over: Record<string, unknown> = {}, headers: Record<string, string> = at(day), token = manager) {
  const client = await createClient(t, manager);
  const vehicle = await createVehicle(t, manager, client);
  const res = await t.call("POST", "/api/policies", { token, headers, body: policyBody(client, vehicle, over) });
  return { client, vehicle, res, policy: res.body };
}
const checklist = async (): Promise<HistoricalChecklistDto> => (await t.call("GET", "/api/historical/checklist", { token: manager })).body;

beforeAll(async () => {
  t = await startApp({ historical: true });
  manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
  s = await setupCatalog(t, manager);
  clerk = await employee("clerk", ["clients.view", "clients.create", "policies.view", "policies.create", "payments.view", "payments.create"]);
});
afterAll(async () => t.close());

describe("first start (owner decision 28/10/2026)", () => {
  it("asks the question; employees only look and still use the messages", async () => {
    expect((await t.call("GET", "/api/historical", { token: clerk })).body).toMatchObject({ mode: "pending", firstDay: "2026-05-01" });
    expect((await t.call("POST", "/api/clients", { token: clerk, body: { kind: "individual", fullName: "Ali BENALI", idType: "cin", idNumber: "AB11111", phone: "0661000000" } })).body.code).toBe("HISTORICAL_MODE_ACTIVE");
    const users = (await t.call("GET", "/api/users", { token: manager })).body as { id: string; username: string }[];
    const to = users.find((u) => u.username === MANAGER.username)?.id;
    expect((await t.call("POST", "/api/messages/threads", { token: clerk, body: { subject: "Question", body: "Bonjour", to: [to] } })).status).toBe(201);
    const yes = await t.call("POST", "/api/historical/answer", { token: manager, body: { hasOldPolicies: true } });
    expect(yes.body.mode).toBe("open");
    expect((await t.call("POST", "/api/historical/answer", { token: manager, body: { hasOldPolicies: false } })).body.code).toBe("HISTORICAL_NOT_OPEN");
  });
});

describe("historical entry, as if live since 01/05/2026", () => {
  it("refuses a date before 01/05/2026 or in the future", async () => {
    expect((await insured("2026-04-30")).res.body.code).toBe("HISTORICAL_DATE_INVALID");
    expect((await insured(addDays(today(), 1))).res.body.code).toBe("HISTORICAL_DATE_INVALID");
  });

  it("opening balances on 01/05/2026", async () => {
    const res = await t.call("PUT", "/api/historical/opening", { token: manager, body: { drawerCents: 0, safeCents: 0, bankCents: 50_000 } });
    expect(res.body.opening).toEqual({ drawerCents: 0, safeCents: 0, bankCents: 50_000 });
    const rows = await ownerQuery(t.db, "SELECT account_code, to_char(business_date, 'YYYY-MM-DD') AS d, amount_cents FROM financial_transactions WHERE kind = 'opening_balance'");
    expect(rows.rows).toEqual([{ account_code: "bank", d: "2026-05-01", amount_cents: "50000" }]);
  });

  it("a policy of 01/05 for 2 000 MAD, 1 000 paid in cash: the drawer gets 1 000 that day, 1 000 stays owed", async () => {
    const { res, policy } = await insured("2026-05-01", { finance: { payments: [{ method: "cash", amountCents: 100_000 }] } });
    expect(res.status).toBe(201);
    expect(policy.periods[0]).toMatchObject({ startDate: "2026-05-01", endDate: "2026-05-31" });
    const money = await ownerQuery(t.db, `SELECT to_char(business_date, 'YYYY-MM-DD') AS d, amount_cents, is_historical, session_id FROM financial_transactions WHERE account_code = 'drawer'`);
    expect(money.rows).toEqual([{ d: "2026-05-01", amount_cents: "100000", is_historical: true, session_id: null }]);
    const pay = await ownerQuery(t.db, `SELECT to_char(received_on, 'YYYY-MM-DD') AS d, is_historical FROM payments`);
    expect(pay.rows).toEqual([{ d: "2026-05-01", is_historical: true }]);
    const receipt = await ownerQuery(t.db, `SELECT to_char(issued_at AT TIME ZONE 'Africa/Casablanca', 'YYYY-MM-DD') AS d, number FROM receipts`);
    expect(receipt.rows[0]?.d).toBe("2026-05-01");
    const fin = (await t.call("GET", `/api/policies/${policy.id}/finance`, { token: manager })).body;
    expect(fin.totals.remainingCents).toBe(100_000);
    const audit = await ownerQuery(t.db, "SELECT after->>'operationDate' AS d, is_historical FROM audit_log WHERE action = 'policy.create'");
    expect(audit.rows[0]).toEqual({ d: "2026-05-01", is_historical: true });
  });

  it("renewal by the operation date: E+1 is a renewal, E+2 needs a policy change", async () => {
    const a = await insured("2026-05-01");
    const renew = (id: string, vehicle: string, day: string) =>
      t.call("POST", `/api/policies/${id}/renew`, { token: manager, headers: at(day), body: { idempotencyKey: randomUUID(), coverageDurationId: s.months1, totalAmountCents: 200_000, certificates: [{ vehicleId: vehicle, certificateNumber: cert() }] } });
    const ok = await renew(a.policy.id, a.vehicle, "2026-06-01");
    expect(ok.status).toBe(200);
    expect(ok.body.periods.at(-1)).toMatchObject({ startDate: "2026-06-01" });
    const b = await insured("2026-05-01");
    expect((await renew(b.policy.id, b.vehicle, "2026-06-02")).body.code).toBe("RENEWAL_TOO_LATE");
  });

  it("inside one policy, oldest first", async () => {
    const { policy } = await insured("2026-05-03");
    const pay = (day: string) => t.call("POST", `/api/policies/${policy.id}/payments`, { token: manager, headers: at(day), body: { idempotencyKey: randomUUID(), method: "cash", amountCents: 10_000 } });
    expect((await pay("2026-05-10")).status).toBe(200);
    expect((await pay("2026-05-05")).body.code).toBe("OUT_OF_ORDER");
    expect((await pay("2026-05-10")).status).toBe(200);
  });

  it("no drawer session in historical entry", async () => {
    expect((await receiveDrawer(t, manager)).body.code).toBe("DRAWER_NOT_IN_HISTORICAL");
  });

  it("old instalments typed by hand (manual), and wrong ones refused", async () => {
    const custom = [
      { dueDate: "2026-05-04", baseCents: 120_000, feeCents: 1_700 },
      { dueDate: "2026-06-04", baseCents: 80_000, feeCents: 0 },
    ];
    const bad = await insured("2026-05-04", { coverageDurationId: s.months12, finance: { instalments: { count: 2, custom: [custom[0], { ...custom[1], baseCents: 1 }] }, payments: [] } });
    expect(bad.res.body.code).toBe("INSTALMENTS_CUSTOM_INVALID");
    const good = await insured("2026-05-04", { coverageDurationId: s.months12, finance: { instalments: { count: 2, custom }, payments: [] } });
    expect(good.res.status).toBe(201);
    const rows = await ownerQuery(t.db, "SELECT amount_cents, manual FROM installments WHERE policy_id = $1 ORDER BY seq", [good.policy.id]);
    expect(rows.rows).toEqual([{ amount_cents: "121700", manual: true }, { amount_cents: "80000", manual: true }]);
    // Not turned into debts while the old entries go on.
    expect((await ownerQuery(t.db, "SELECT count(*)::int AS n FROM debts WHERE source = 'installment'")).rows[0]?.n).toBe(0);
  });

  it("a day ending below zero is shown and blocks the end until corrected", async () => {
    const cats = (await t.call("GET", "/api/expenses/categories", { token: manager })).body as ListItemDto[];
    const e = await t.call("POST", "/api/expenses", { token: manager, headers: at("2026-05-11"), body: { idempotencyKey: randomUUID(), categoryId: cats[0]?.id, amountCents: 300_000, note: "Loyer" } });
    expect(e.status).toBe(201);
    if (e.body.status === "pending") {
      expect((await t.call("POST", `/api/expenses/${e.body.id}/approve`, { token: manager, headers: at("2026-05-11"), body: { version: e.body.version, account: "drawer" } })).status).toBe(200);
    }
    const list = await checklist();
    expect(list.negativeDays[0]).toMatchObject({ account: "drawer", day: "2026-05-11" });
    expect(list.canFinish).toBe(false);
    expect(list.overdueInstalments.count).toBeGreaterThanOrEqual(2);
    expect((await t.call("POST", "/api/historical/finish", { token: manager, body: { password: MANAGER.password, phrase: "تمت كل الادخالات القديمة" } })).body.code).toBe("HISTORICAL_NEGATIVE_DAYS");
    // The real opening balance of the drawer was 3 000 MAD.
    await t.call("PUT", "/api/historical/opening", { token: manager, body: { drawerCents: 300_000, safeCents: 0, bankCents: 50_000 } });
    expect((await checklist()).canFinish).toBe(true);
  });

  it("a correction when the real balance differs", async () => {
    const before = (await checklist()).balances.find((b) => b.account === "bank")?.cents ?? 0;
    const res = await t.call("POST", "/api/historical/corrections", { token: manager, body: { account: "bank", actualCents: before + 12_345, reason: "Relevé bancaire" } });
    expect(res.status).toBe(200);
    expect(res.body.balances.find((b: { account: string }) => b.account === "bank").cents).toBe(before + 12_345);
  });
});

describe("all old entries are done: live work starts", () => {
  it("needs the password and the sentence; then late instalments become debts and one summary message", async () => {
    expect((await t.call("POST", "/api/historical/finish", { token: clerk, body: { password: "secret1", phrase: "x" } })).status).toBe(403);
    expect((await t.call("POST", "/api/historical/finish", { token: manager, body: { password: MANAGER.password, phrase: "terminé" } })).body.code).toBe("FINISH_PHRASE_WRONG");
    expect((await t.call("POST", "/api/historical/finish", { token: manager, body: { password: "wrong", phrase: "تمت كل الادخالات القديمة" } })).body.code).toBe("WRONG_PASSWORD");
    const res = await t.call("POST", "/api/historical/finish", { token: manager, body: { password: MANAGER.password, phrase: "تمت كل الادخالات القديمة" } });
    expect(res.status).toBe(200);
    expect(res.body.debtsCreated).toBeGreaterThanOrEqual(2);
    expect((await t.call("GET", "/api/historical", { token: manager })).body.mode).toBe("locked");
    const msgs = await ownerQuery(t.db, "SELECT th.subject FROM message_threads th WHERE th.subject LIKE 'system:%' ORDER BY th.created_at");
    expect(msgs.rows.map((r) => r.subject)).toEqual(["system:historical_finished"]);
    // Employees work normally now.
    expect((await t.call("POST", "/api/clients", { token: clerk, body: { kind: "individual", fullName: "Ali BENALI", idType: "cin", idNumber: "AB11111", phone: "0661000000" } })).status).toBe(201);
    // No more back-dated operation except the manager's late policy.
    expect((await t.call("PUT", "/api/historical/opening", { token: manager, body: { drawerCents: 0, safeCents: 0, bankCents: 0 } })).body.code).toBe("HISTORICAL_NOT_OPEN");
  });

  it("after going live: a late policy for the manager only, with a reason, and its money in today's drawer", async () => {
    const cash = { finance: { payments: [{ method: "cash", amountCents: 50_000 }] } };
    expect((await insured("2026-06-10", cash)).res.body.code).toBe("LATE_REASON_REQUIRED");
    const late = { ...at("2026-06-10"), [HEADER_LATE_REASON]: encodeURIComponent("Oubliée dans le classeur") };
    expect((await insured("2026-06-10", cash, late, clerk)).res.body.code).toBe("LATE_ENTRY_NOT_ALLOWED");
    expect((await insured("2026-06-10", cash, late)).res.body.code).toBe("DRAWER_NOT_RECEIVED");
    expect((await receiveDrawer(t, manager)).status).toBe(200);
    const ok = await insured("2026-06-10", cash, late);
    expect(ok.res.status).toBe(201);
    expect(ok.policy.periods[0].startDate).toBe("2026-06-10");
    const money = await ownerQuery(t.db, "SELECT to_char(business_date, 'YYYY-MM-DD') AS d, is_historical FROM financial_transactions WHERE amount_cents = 50000 AND kind = 'payment_cash'");
    expect(money.rows).toEqual([{ d: today(), is_historical: false }]);
    const op = await ownerQuery(t.db, "SELECT late_entry_reason FROM policy_operations WHERE policy_id = $1", [ok.policy.id]);
    expect(op.rows[0]?.late_entry_reason).toBe("Oubliée dans le classeur");
    // Other old-dated operations are refused.
    expect((await t.call("POST", `/api/policies/${ok.policy.id}/payments`, { token: manager, headers: late, body: { idempotencyKey: randomUUID(), method: "cash", amountCents: 1_000 } })).body.code).toBe("LATE_ENTRY_NOT_ALLOWED");
  });

  it("Phase 8B: a renewal made on paper in time, entered late by the manager (E+1), money in today's drawer", async () => {
    const lateAt = (day: string) => ({ ...at(day), [HEADER_LATE_REASON]: encodeURIComponent("Renouvelée sur papier") });
    const { policy, vehicle } = await insured("2026-06-15", {}, lateAt("2026-06-15"));
    expect(policy.periods[0]).toMatchObject({ startDate: "2026-06-15", endDate: "2026-07-14" });
    const body = () => ({
      idempotencyKey: randomUUID(),
      coverageDurationId: s.months1,
      totalAmountCents: 200_000,
      certificates: [{ vehicleId: vehicle, certificateNumber: cert() }],
      finance: { payments: [{ method: "cash", amountCents: 30_000 }] },
    });
    const renew = (headers: Record<string, string>, token = manager) => t.call("POST", `/api/policies/${policy.id}/renew`, { token, headers, body: body() });
    // Today it is far past E+1: only a policy change; on the real day (E+1) it was a renewal.
    expect((await renew({})).body.code).toBe("RENEWAL_TOO_LATE");
    expect((await renew(at("2026-07-15"))).body.code).toBe("LATE_REASON_REQUIRED");
    expect((await renew(lateAt("2026-07-15"), clerk)).body.code).toBe("LATE_ENTRY_NOT_ALLOWED");
    expect((await renew(lateAt("2026-07-16"))).body.code).toBe("RENEWAL_TOO_LATE");
    const ok = await renew(lateAt("2026-07-15"));
    expect(ok.status).toBe(200);
    expect(ok.body.periods.at(-1)).toMatchObject({ startDate: "2026-07-15" });
    const money = await ownerQuery(t.db, "SELECT to_char(business_date, 'YYYY-MM-DD') AS d FROM financial_transactions WHERE amount_cents = 30000 AND kind = 'payment_cash'");
    expect(money.rows).toEqual([{ d: today() }]);
  });
});
