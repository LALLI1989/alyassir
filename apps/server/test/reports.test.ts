/**
 * Phase 6A on a real PostgreSQL: dashboard numbers and cards by permission, the 16 reports
 * (columns, totals, permissions, safe and bank), Excel files with translated headers.
 */
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPORT_CODES, type DashboardDto, type ExcelFileDto, type ListItemDto, type ReportDto, type ReportsIndexDto } from "@alyassir/shared";
import { MANAGER, createEmployee, startApp, type TestApp } from "./harness";
import { createClient, createVehicle, mustCreatePolicy, receiveDrawer, setupCatalog, type Setup } from "./fixtures";
import ar from "../../../packages/i18n/src/ar.json";
import fr from "../../../packages/i18n/src/fr.json";

let t: TestApp;
let manager: string;
let s: Setup;

async function employee(name: string, permissions: string[], supervisor = false): Promise<string> {
  const id = await createEmployee(t, manager, name);
  let user = (await t.call("GET", `/api/users/${id}`, { token: manager })).body;
  if (supervisor) user = (await t.call("PATCH", `/api/users/${id}`, { token: manager, body: { version: user.version, isSupervisor: true } })).body;
  const res = await t.call("PUT", `/api/users/${id}/permissions`, { token: manager, body: { version: user.version, permissions } });
  if (res.status !== 200) throw new Error(`permissions: ${res.status} ${JSON.stringify(res.body)}`);
  return (await t.login(name, "secret1")).accessToken;
}

const cashPolicy = async (amountCents: number, paidCents = amountCents) => {
  const client = await createClient(t, manager);
  const vehicle = await createVehicle(t, manager, client);
  return mustCreatePolicy(t, manager, s, client, [vehicle], {
    totalAmountCents: amountCents,
    ...(paidCents > 0 ? { finance: { payments: [{ method: "cash", amountCents: paidCents }] } } : {}),
  });
};
const dashboard = async (token = manager, period = "month"): Promise<DashboardDto> => (await t.call("GET", `/api/dashboard?period=${period}`, { token })).body;
const report = (code: string, body: Record<string, unknown> = {}, token = manager) => t.call("POST", `/api/reports/${code}`, { token, body: { language: "ar", ...body } });

beforeAll(async () => {
  t = await startApp();
  manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
  s = await setupCatalog(t, manager);
  expect((await receiveDrawer(t, manager)).status).toBe(200);
  // Three cash payments: 1 000 + 500 + 250 MAD; one policy of 2 000 MAD not paid at all (a debt).
  await cashPolicy(100_000);
  await cashPolicy(50_000);
  await cashPolicy(25_000);
  await cashPolicy(200_000, 0);
  // One expense of 300 MAD, approved from the drawer.
  const cats = (await t.call("GET", "/api/expenses/categories", { token: manager })).body as ListItemDto[];
  const e = await t.call("POST", "/api/expenses", { token: manager, body: { idempotencyKey: randomUUID(), categoryId: cats[0]?.id, amountCents: 30_000, note: "Papier" } });
  expect(e.status).toBe(201);
  if (e.body.status === "pending") expect((await t.call("POST", `/api/expenses/${e.body.id}/approve`, { token: manager, body: { version: e.body.version } })).status).toBe(200);
});
afterAll(async () => t.close());

describe("dashboard (SPEC 19)", () => {
  it("adds up the payments, the debts, the expenses and the balances on the server", async () => {
    const d = await dashboard();
    expect(d.money).toMatchObject({ paymentsCents: 175_000, paymentsCount: 3, remainingCents: 200_000, expensesCents: 30_000, inCollectionCents: 0 });
    expect(d.balances).toEqual({ drawer: 145_000, safe: 0, bank: 0 });
    expect(d.clients).toBe(4);
    expect(d.policies).toMatchObject({ active: 4, expired: 0 });
    expect(d.charts.paymentsByDay?.reduce((n, x) => n + x.cents, 0)).toBe(175_000);
    expect(d.charts.policiesByMonth).toHaveLength(12);
    expect(d.charts.policiesByMonth?.at(-1)?.newIssues).toBe(4);
    expect(d.activity?.some((a) => a.actions > 0)).toBe(true);
  });

  it("shows each card only to who may see it", async () => {
    const plain = await employee("viewer", ["clients.view"]);
    const d = await dashboard(plain);
    expect(d.clients).toBe(4);
    expect(d.policies).toBeNull();
    expect(d.money).toBeNull();
    expect(d.balances).toBeNull();
    expect(d.openClaims).toBeNull();
    expect(d.activity).toBeNull();
    expect(d.charts).toEqual({ paymentsByDay: null, policiesByMonth: null });

    const cashier = await employee("cashview", ["drawer_balance.view", "finance_dashboard.view"]);
    const c = await dashboard(cashier);
    expect(c.balances).toEqual({ drawer: 145_000, safe: null, bank: null });
    expect(c.money?.paymentsCents).toBe(175_000);
    expect(c.clients).toBeNull();
  });

  it("refuses an unknown period", async () => {
    expect((await t.call("GET", "/api/dashboard?period=week", { token: manager })).status).toBe(400);
  });
});

describe("reports (SPEC 19)", () => {
  it("the manager sees the 16 reports; each one answers with its columns and totals", async () => {
    const index = (await t.call("GET", "/api/reports", { token: manager })).body as ReportsIndexDto;
    expect(index.reports.map((r) => r.code)).toEqual([...REPORT_CODES]);
    expect(index.canExport).toBe(true);
    for (const code of REPORT_CODES) {
      const res = await report(code);
      expect(res.status, code).toBe(200);
      const r = res.body as ReportDto;
      expect(r.title, code).toBe((ar.reports.titles as Record<string, string>)[code]);
      expect(r.columns.length, code).toBeGreaterThan(2);
      for (const c of r.columns) expect(c.label, `${code}.${c.key}`).toBe((ar.reports.columns as Record<string, string>)[c.key]);
    }
  });

  it("payments: rows, words in the chosen language and the total", async () => {
    const r = (await report("payments")).body as ReportDto;
    expect(r.rows).toHaveLength(3);
    expect(r.totals.amount).toBe(175_000);
    expect(r.rows[0]?.method).toBe(ar.finance.methods.cash);
    const f = (await report("payments", { language: "fr", method: "cash" })).body as ReportDto;
    expect(f.rows[0]?.method).toBe(fr.finance.methods.cash);
    expect(f.columns.find((c) => c.key === "amount")?.label).toBe(fr.reports.columns.amount);
    expect(f.subtitle).toContain(fr.finance.methods.cash);
    expect(((await report("payments", { method: "cheque" })).body as ReportDto).rows).toHaveLength(0);
  });

  it("dues, accounts, movements and expenses add up", async () => {
    const dues = (await report("dues", { status: "open" })).body as ReportDto;
    expect(dues.totals.remaining).toBe(200_000);
    const accounts = (await report("accounts")).body as ReportDto;
    expect(accounts.rows.map((r) => r.account)).toEqual([ar.finance.accounts.drawer, ar.finance.accounts.safe, ar.finance.accounts.bank]);
    expect(accounts.rows[0]).toMatchObject({ moneyIn: 175_000, moneyOut: 30_000, closingBalance: 145_000, current: 145_000 });
    const moves = (await report("movements", { account: "drawer" })).body as ReportDto;
    expect(moves.totals).toEqual({ moneyIn: 175_000, moneyOut: 30_000 });
    expect(((await report("expenses", { status: "approved" })).body as ReportDto).totals.amount).toBe(30_000);
    expect(((await report("policies")).body as ReportDto).totals.amount).toBe(375_000);
  });

  it("the period filter, and a wrong period is refused", async () => {
    expect(((await report("payments", { from: "2020-01-01", to: "2020-12-31" })).body as ReportDto).rows).toHaveLength(0);
    expect((await report("payments", { from: "2026-10-10", to: "2026-10-01" })).body.code).toBe("VALIDATION");
    expect((await report("nothing")).status).toBe(404);
  });

  it("each report needs its module; safe and bank only for the manager and named supervisors", async () => {
    const none = await employee("noreports", ["payments.view"]);
    expect((await t.call("GET", "/api/reports", { token: none })).status).toBe(403);
    expect((await report("payments", {}, none)).status).toBe(403);

    const rep = await employee("reporter", ["reports.view", "payments.view", "expenses.view"]);
    const index = (await t.call("GET", "/api/reports", { token: rep })).body as ReportsIndexDto;
    expect(index.reports.map((r) => r.code)).toEqual(["payments", "dues", "expenses", "collections"]);
    expect(index.canExport).toBe(false);
    expect((await report("payments", {}, rep)).status).toBe(200);
    for (const code of ["clients", "accounts", "movements", "insurer_withdrawals", "audit", "user_activity", "messages"]) {
      expect((await report(code, {}, rep)).status, code).toBe(403);
    }
    expect((await t.call("POST", "/api/reports/payments/excel", { token: rep, body: { language: "ar" } })).status).toBe(403);

    // Drawer balance only: the accounts report shows the drawer and never the safe or the bank.
    const drawer = await employee("drawerrep", ["reports.view", "drawer_balance.view"]);
    const acc = (await report("accounts", {}, drawer)).body as ReportDto;
    expect(acc.rows.map((r) => r.account)).toEqual([ar.finance.accounts.drawer]);
    const asked = (await report("movements", { account: "bank" }, drawer)).body as ReportDto;
    expect(asked.rows.every((r) => r.account === ar.finance.accounts.drawer)).toBe(true);
    expect((await report("insurer_withdrawals", {}, drawer)).status).toBe(403);

    const sup = await employee("suprep", ["reports.view", "sup.transfers"], true);
    expect((await report("insurer_withdrawals", {}, sup)).status).toBe(200);
    expect(((await report("accounts", {}, sup)).body as ReportDto).rows).toHaveLength(3);
    expect((await report("audit", {}, sup)).status).toBe(403);
  });

  it("the messages report shows titles and people, never the text of the messages", async () => {
    const body = "Texte confidentiel 123";
    const users = (await t.call("GET", "/api/users", { token: manager })).body as { id: string; username: string }[];
    const to = users.find((u) => u.username === "viewer")?.id;
    expect((await t.call("POST", "/api/messages/threads", { token: manager, body: { subject: "Question", body, to: [to] } })).status).toBe(201);
    const r = (await report("messages")).body as ReportDto;
    const row = r.rows.find((x) => x.subject === "Question");
    expect(row?.recipients).toContain("VIEWER");
    expect(row?.messagesCount).toBe(1);
    expect(row?.kind).toBe(ar.reports.messageKinds.message);
    expect(JSON.stringify(r)).not.toContain(body);
  });
});

describe("Excel (SPEC 19)", () => {
  it("a real .xlsx with the headers in the chosen language and the total in dirhams", async () => {
    for (const [lang, texts] of [["ar", ar], ["fr", fr]] as const) {
      const res = await t.call("POST", "/api/reports/payments/excel", { token: manager, body: { language: lang } });
      expect(res.status).toBe(200);
      const file = res.body as ExcelFileDto;
      expect(file.fileName).toMatch(/^payments-\d{4}-\d{2}-\d{2}\.xlsx$/);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.from(file.dataBase64, "base64") as unknown as ArrayBuffer);
      const sheet = book.worksheets[0];
      expect(sheet?.getCell(1, 1).value).toBe(texts.reports.titles.payments);
      const header = sheet?.getRow(4).values as unknown[];
      expect(header).toContain(texts.reports.columns.amount);
      expect(header).toContain(texts.reports.columns.client);
      const last = sheet?.getRow(sheet.rowCount).values as unknown[];
      expect(last).toContain(texts.reports.total);
      expect(last).toContain(1750);
      expect(sheet?.views[0]?.rightToLeft ?? false).toBe(lang === "ar");
    }
  });
});
