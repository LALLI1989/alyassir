/**
 * Phase 4 on a real PostgreSQL: shared drawer session, receiving and closing, day status, expenses,
 * transfers, payments to insurers, bank withdrawals, reverse movements, who sees the safe and bank.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDay } from "@alyassir/domain";
import type { AccountDto, DayDto, DrawerStateDto, ExpenseDto, ListItemDto, MovementDto } from "@alyassir/shared";
import { MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";
import { appQuery, createClient, createVehicle, mustCreatePolicy, receiveDrawer, setupCatalog, type Setup } from "./fixtures";

let t: TestApp;
let manager: string;
let s: Setup;

beforeAll(async () => {
  t = await startApp();
  manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
  s = await setupCatalog(t, manager);
});
afterAll(async () => t.close());

async function employee(name: string, permissions: string[], supervisor = false): Promise<string> {
  const id = await createEmployee(t, manager, name);
  let user = (await t.call("GET", `/api/users/${id}`, { token: manager })).body;
  if (supervisor) user = (await t.call("PATCH", `/api/users/${id}`, { token: manager, body: { version: user.version, isSupervisor: true } })).body;
  await t.call("PUT", `/api/users/${id}/permissions`, { token: manager, body: { version: user.version, permissions } });
  return (await t.login(name, "secret1")).accessToken;
}

const state = async (token = manager): Promise<DrawerStateDto> => (await t.call("GET", "/api/drawer", { token })).body;
const balances = async (): Promise<Record<string, number>> =>
  Object.fromEntries(((await t.call("GET", "/api/accounts", { token: manager })).body as AccountDto[]).map((a) => [a.code, a.balanceCents]));
const close = async (token: string, countedCents: number, reason = "") => {
  const st = await state(token);
  return t.call("POST", "/api/drawer/close", { token, body: { sessionVersion: st.session?.version ?? 1, countedCents, reason } });
};
const cashPolicy = async (token: string, amountCents: number) => {
  const client = await createClient(t, manager);
  const vehicle = await createVehicle(t, manager, client);
  return mustCreatePolicy(t, token, s, client, [vehicle], { totalAmountCents: amountCents, finance: { payments: [{ method: "cash", amountCents }] } });
};
const pay = (policyId: string, amountCents: number, token = manager) =>
  t.call("POST", `/api/policies/${policyId}/payments`, { token, body: { idempotencyKey: randomUUID(), method: "cash", amountCents } });
const categories = async (): Promise<ListItemDto[]> => (await t.call("GET", "/api/expenses/categories", { token: manager })).body;
const addExpense = (token: string, amountCents: number, key = randomUUID()) =>
  categories().then((c) => t.call("POST", "/api/expenses", { token, body: { idempotencyKey: key, categoryId: c.find((x) => x.code === "cleaning")?.id, amountCents, note: "Produits" } }));
const transfer = (from: string, to: string, amountCents: number, token = manager, key = randomUUID()) =>
  t.call("POST", "/api/accounts/transfers", { token, body: { idempotencyKey: key, from, to, amountCents, reference: "" } });
async function systemMessages(event: string): Promise<{ body: string }[]> {
  const res = await ownerQuery(t.db, "SELECT m.body FROM messages m JOIN message_threads th ON th.id = m.thread_id WHERE th.subject = $1 ORDER BY m.created_at", [`system:${event}`]);
  return res.rows as { body: string }[];
}

describe("receiving the drawer (SPEC 17.3, owner decisions 28/10/2026)", () => {
  it("no cash before receiving it; cheques are still possible", async () => {
    const client = await createClient(t, manager);
    const vehicle = await createVehicle(t, manager, client);
    const policy = await mustCreatePolicy(t, manager, s, client, [vehicle], { totalAmountCents: 100_000 });
    expect((await pay(policy.id, 10_000)).body.code).toBe("DRAWER_NOT_RECEIVED");
    const cheque = await t.call("POST", `/api/policies/${policy.id}/payments`, {
      token: manager,
      body: { idempotencyKey: randomUUID(), method: "cheque", amountCents: 10_000, cheque: { number: "1", bank: "CIH", drawerName: "Said", dueDate: businessDay(new Date()) } },
    });
    expect(cheque.status).toBe(200);
    expect((await state()).session).toBeNull();
  });

  it("the first person opens the session; the next one joins it; a gap needs a reason", async () => {
    const a = await employee("cashier1", ["clients.view", "vehicles.view", "policies.view", "policies.create", "payments.view", "payments.create"]);
    const b = await employee("cashier2", ["payments.view", "payments.create", "closing.view", "closing.create"]);
    expect((await receiveDrawer(t, a)).status).toBe(200);
    let st = await state(a);
    expect(st.holder).toBe(true);
    expect(st.session?.members.map((m) => m.name)).toEqual(["CASHIER1"]);
    // B was shown an old balance: shown again.
    const stale = await t.call("POST", "/api/drawer/receive", { token: b, body: { shownCents: st.balanceCents + 1, countedCents: 0, reason: "" } });
    expect(stale.body.code).toBe("SESSION_CHANGED");
    // B finds 5 MAD less and says nothing: refused.
    expect((await receiveDrawer(t, b, st.balanceCents - 500)).body.code).toBe("DIFFERENCE_REASON_REQUIRED");
    expect((await receiveDrawer(t, b, st.balanceCents - 500, "Pièce manquante")).status).toBe(200);
    st = await state(b);
    expect(st.session?.members.map((m) => m.name)).toEqual(["CASHIER1", "CASHIER2"]);
    expect(st.session?.members[1]).toMatchObject({ differenceCents: -500, reason: "Pièce manquante" });
    expect(JSON.parse((await systemMessages("drawer_receive_difference")).at(-1)?.body ?? "{}").params).toMatchObject({ employee: "CASHIER2", differenceCents: -500 });
    // Receiving twice is harmless.
    expect((await receiveDrawer(t, b)).status).toBe(200);
    expect((await state(b)).session?.members).toHaveLength(2);
    // Both can take cash now; each movement keeps the name of who did it.
    const p = await cashPolicy(a, 300_000);
    expect(p.policyNumber).toBeTruthy();
    expect((await state()).session?.byUser).toEqual([expect.objectContaining({ name: "CASHIER1", inCents: 300_000 })]);
  });

  it("someone who never handles cash may not receive the drawer", async () => {
    const viewer = await employee("viewer", ["clients.view"]);
    expect((await t.call("GET", "/api/drawer", { token: viewer })).status).toBe(403);
    expect((await t.call("POST", "/api/drawer/receive", { token: viewer, body: { shownCents: 0, countedCents: 0, reason: "" } })).status).toBe(403);
  });
});

describe("closing = handover (SPEC 17.3)", () => {
  it("expected 3 500, counted 3 300: refused without a reason, then closed for everyone", async () => {
    const b = (await t.login("cashier2", "secret1")).accessToken;
    const st = await state(b);
    expect(st.balanceCents).toBe(300_000);
    // Bring the drawer to 3 500 MAD.
    const client = await createClient(t, manager);
    const vehicle = await createVehicle(t, manager, client);
    const policy = await mustCreatePolicy(t, manager, s, client, [vehicle], { totalAmountCents: 50_000 });
    await receiveDrawer(t, manager);
    expect((await pay(policy.id, 50_000)).status).toBe(200);
    expect((await state(b)).balanceCents).toBe(350_000);
    expect((await close(b, 330_000)).body.code).toBe("DIFFERENCE_REASON_REQUIRED");
    const closed = await close(b, 330_000, "Dépense de nettoyage en attente");
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ expectedCents: 350_000, countedCents: 330_000, differenceCents: -20_000, closedOnBehalf: false });
    expect(closed.body.members).toHaveLength(3);
    expect(closed.body.members.slice(0, 2).map((m: { name: string }) => m.name)).toEqual(["CASHIER1", "CASHIER2"]);
    // The closing is a snapshot: the balance stays what the program computed.
    expect((await state(b)).balanceCents).toBe(350_000);
    expect((await state(b)).session).toBeNull();
    // Everyone has to receive the drawer again.
    const unpaid = await mustCreatePolicy(t, manager, s, await createClient(t, manager), [], { insuranceTypeId: s.homeType, totalAmountCents: 10_000 });
    expect((await pay(unpaid.id, 1_000)).body.code).toBe("DRAWER_NOT_RECEIVED");
    expect(JSON.parse((await systemMessages("drawer_close_difference")).at(-1)?.body ?? "{}").params).toMatchObject({ differenceCents: -20_000 });
  });

  it("on behalf: only the manager or a supervisor with that power, always with a reason", async () => {
    const a = (await t.login("cashier1", "secret1")).accessToken;
    await receiveDrawer(t, a);
    const sup = await employee("chief", ["closing.view", "closing.create", "sup.close_session_on_behalf"], true);
    const other = await employee("other", ["closing.view", "closing.create"]);
    const balance = (await state(a)).balanceCents;
    expect((await close(other, balance, "Absent")).status).toBe(403);
    expect((await close(sup, balance)).body.code).toBe("REASON_REQUIRED");
    const res = await close(sup, balance, "Cashier1 est parti malade");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ closedOnBehalf: true, differenceCents: 0 });
    expect(JSON.parse((await systemMessages("drawer_closed_on_behalf")).at(-1)?.body ?? "{}").params).toMatchObject({ employee: "CHIEF" });
  });

  it("day status: closed, then needs review after a later movement, approved, reopened", async () => {
    const today = businessDay(new Date());
    const day = async (): Promise<DayDto | undefined> => ((await t.call("GET", "/api/drawer/days", { token: manager })).body as DayDto[]).find((d) => d.date === today);
    expect((await day())?.status).toBe("closed");
    expect((await day())?.closings).toBe(2);
    await receiveDrawer(t, manager);
    const p = await cashPolicy(manager, 10_000);
    expect(p.id).toBeTruthy();
    expect((await day())?.status).toBe("needs_review");
    const employeeToken = (await t.login("cashier2", "secret1")).accessToken;
    expect((await t.call("POST", "/api/drawer/days/review", { token: employeeToken, body: { date: today, action: "approve" } })).status).toBe(403);
    expect((await t.call("POST", "/api/drawer/days/review", { token: manager, body: { date: today, action: "approve" } })).status).toBe(200);
    expect((await day())?.status).toBe("closed");
    expect((await t.call("POST", "/api/drawer/days/review", { token: manager, body: { date: today, action: "reopen" } })).status).toBe(400);
    expect((await t.call("POST", "/api/drawer/days/review", { token: manager, body: { date: today, action: "reopen", reason: "Erreur de comptage" } })).status).toBe(200);
    expect((await day())?.status).toBe("open");
    expect((await close(manager, (await state()).balanceCents)).status).toBe(200);
    expect((await day())?.status).toBe("closed");
    const list = await t.call("GET", "/api/drawer/closings", { token: manager });
    expect(list.body.total).toBe(3);
  });

  it("two people closing at the same moment: one closing", async () => {
    await receiveDrawer(t, manager);
    const b = (await t.login("cashier2", "secret1")).accessToken;
    await receiveDrawer(t, b);
    const balance = (await state()).balanceCents;
    const [r1, r2] = await Promise.all([close(manager, balance), close(b, balance)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(["SESSION_NOT_OPEN", "SESSION_CHANGED"]).toContain((r1.status === 409 ? r1 : r2).body.code);
    expect((await state()).session).toBeNull();
  });
});

describe("expenses (SPEC 17.2)", () => {
  let cashier = "";
  beforeAll(async () => {
    cashier = await employee("spender", ["expenses.view", "expenses.create"]);
  });

  it("added by an employee who received the drawer; no effect until approved; the manager is told", async () => {
    expect((await addExpense(cashier, 20_000)).body.code).toBe("DRAWER_NOT_RECEIVED");
    await receiveDrawer(t, cashier);
    const before = (await balances()).drawer ?? 0;
    const key = randomUUID();
    const res = await addExpense(cashier, 20_000, key);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "pending", amountCents: 20_000, createdByName: "SPENDER" });
    // Same click twice: one expense.
    expect((await addExpense(cashier, 20_000, key)).body.id).toBe(res.body.id);
    expect((await balances()).drawer).toBe(before);
    expect((await state(cashier)).pendingExpensesCents).toBe(20_000);
    expect(JSON.parse((await systemMessages("expense_pending")).at(-1)?.body ?? "{}").params).toMatchObject({ employee: "SPENDER", amountCents: 20_000, category: "cleaning" });
    // The employee may not approve, edit or cancel.
    expect((await t.call("POST", `/api/expenses/${res.body.id}/approve`, { token: cashier, body: { version: 1 } })).status).toBe(403);
    expect((await t.call("PATCH", `/api/expenses/${res.body.id}`, { token: cashier, body: { version: 1, categoryId: res.body.category.id, amountCents: 1 } })).status).toBe(403);
  });

  it("approved: the drawer goes down; rejected: no effect; cancelled: the money comes back", async () => {
    const list = (await t.call("GET", "/api/expenses?status=pending", { token: manager })).body.items as ExpenseDto[];
    const e = list[0] as ExpenseDto;
    const before = (await balances()).drawer ?? 0;
    // The manager first corrects the amount (pending only).
    const edited = await t.call("PATCH", `/api/expenses/${e.id}`, { token: manager, body: { version: e.version, categoryId: e.category.id, amountCents: 15_000, note: "Produits" } });
    expect(edited.body.amountCents).toBe(15_000);
    const ok = await t.call("POST", `/api/expenses/${e.id}/approve`, { token: manager, body: { version: edited.body.version } });
    expect(ok.body).toMatchObject({ status: "approved", account: "drawer" });
    expect((await balances()).drawer).toBe(before - 15_000);
    expect((await t.call("PATCH", `/api/expenses/${e.id}`, { token: manager, body: { version: ok.body.version, categoryId: e.category.id, amountCents: 1 } })).body.code).toBe("EXPENSE_NOT_PENDING");

    const second = (await addExpense(cashier, 9_000)).body as ExpenseDto;
    expect((await t.call("POST", `/api/expenses/${second.id}/reject`, { token: manager, body: { version: second.version } })).status).toBe(400);
    const rejected = await t.call("POST", `/api/expenses/${second.id}/reject`, { token: manager, body: { version: second.version, reason: "Pas de facture" } });
    expect(rejected.body).toMatchObject({ status: "rejected", rejectReason: "Pas de facture" });
    expect((await balances()).drawer).toBe(before - 15_000);

    const cancelled = await t.call("POST", `/api/expenses/${e.id}/cancel`, { token: manager, body: { version: ok.body.version, reason: "Doublon" } });
    expect(cancelled.body.status).toBe("cancelled");
    expect((await balances()).drawer).toBe(before);
  });

  it("a supervisor with 'approve expenses' may approve; the manager adds categories in Latin letters", async () => {
    const sup = await employee("approver", ["expenses.view", "sup.approve_expenses"], true);
    const e = (await addExpense(cashier, 1_000)).body as ExpenseDto;
    expect((await t.call("POST", `/api/expenses/${e.id}/approve`, { token: sup, body: { version: e.version } })).body.status).toBe("approved");
    expect((await t.call("POST", "/api/expenses/categories", { token: manager, body: { name: "صيانة" } })).body.fields?.name).toBe("latin_only");
    const added = await t.call("POST", "/api/expenses/categories", { token: manager, body: { name: "Maintenance" } });
    expect((added.body as ListItemDto[]).some((c) => c.name === "Maintenance")).toBe(true);
    expect((await t.call("POST", "/api/expenses/categories", { token: manager, body: { name: "maintenance" } })).body.code).toBe("NAME_TAKEN");
  });
});

describe("accounts: transfers, insurers, withdrawals (SPEC 17.1, 17.4)", () => {
  it("5 000 from the drawer to the safe, in one operation; more than the balance is refused", async () => {
    await receiveDrawer(t, manager);
    // Put exactly 5 000 MAD more in the drawer, then move it.
    await cashPolicy(manager, 500_000);
    const before = await balances();
    const key = randomUUID();
    const res = await transfer("drawer", "safe", 500_000, manager, key);
    expect(res.status).toBe(200);
    expect((await transfer("drawer", "safe", 500_000, manager, key)).status).toBe(200);
    const after = await balances();
    expect(after.drawer).toBe((before.drawer ?? 0) - 500_000);
    expect(after.safe).toBe((before.safe ?? 0) + 500_000);
    expect((await transfer("safe", "bank", (after.safe ?? 0) + 1)).body.code).toBe("INSUFFICIENT_BALANCE");
    expect((await transfer("safe", "safe", 1)).status).toBe(400);
    expect((await transfer("safe", "bank", 500_000)).status).toBe(200);
    const moves = (await t.call("GET", "/api/accounts/movements?account=safe", { token: manager })).body.items as MovementDto[];
    expect(moves.slice(0, 2).map((m) => m.kind)).toEqual(["transfer_out", "transfer_in"]);
    const group = await ownerQuery(t.db, "SELECT count(DISTINCT group_id) AS g, count(*) AS n FROM financial_transactions WHERE transfer_id IS NOT NULL");
    expect(Number(group.rows[0]?.n)).toBe(2 * Number(group.rows[0]?.g));
  });

  it("a payment to an insurer and a withdrawal; each reversed once, the original stays", async () => {
    const start = (await balances()).bank ?? 0;
    const pay1 = await t.call("POST", "/api/accounts/insurer-payments", { token: manager, body: { idempotencyKey: randomUUID(), insurerId: s.rma, amountCents: 200_000, reference: "VIR-001", note: "Octobre" } });
    expect(pay1.status).toBe(200);
    expect((await balances()).bank).toBe(start - 200_000);
    const reasons = (await t.call("GET", "/api/accounts/withdrawal-reasons", { token: manager })).body as ListItemDto[];
    expect(reasons.map((r) => r.code)).toEqual(["profits", "personal", "advance", "cash_expense", "other"]);
    const profits = reasons[0]?.id;
    expect((await t.call("POST", "/api/accounts/withdrawals", { token: manager, body: { idempotencyKey: randomUUID(), reasonId: profits, amountCents: 100_000 } })).status).toBe(400);
    expect((await t.call("POST", "/api/accounts/withdrawals", { token: manager, body: { idempotencyKey: randomUUID(), reasonId: profits, amountCents: 100_000, explanation: "Bénéfices" } })).status).toBe(200);
    expect((await balances()).bank).toBe(start - 300_000);
    expect((await t.call("POST", "/api/accounts/withdrawals", { token: manager, body: { idempotencyKey: randomUUID(), reasonId: profits, amountCents: 10_000_000, explanation: "Trop" } })).body.code).toBe("INSUFFICIENT_BALANCE");

    const moves = (await t.call("GET", "/api/accounts/movements?account=bank", { token: manager })).body.items as MovementDto[];
    const insurerMove = moves.find((m) => m.ref.type === "insurer_payment");
    expect(insurerMove?.ref).toMatchObject({ insurer: "RMA", reference: "VIR-001", reversed: false });
    const id = (insurerMove?.ref as { id: string }).id;
    expect((await t.call("POST", "/api/accounts/reverse", { token: manager, body: { idempotencyKey: randomUUID(), kind: "insurer_payment", id } })).status).toBe(400);
    expect((await t.call("POST", "/api/accounts/reverse", { token: manager, body: { idempotencyKey: randomUUID(), kind: "insurer_payment", id, reason: "Mauvais montant" } })).status).toBe(200);
    expect((await balances()).bank).toBe(start - 100_000);
    expect((await t.call("POST", "/api/accounts/reverse", { token: manager, body: { idempotencyKey: randomUUID(), kind: "insurer_payment", id, reason: "Encore" } })).body.code).toBe("ALREADY_REVERSED");
    const after = (await t.call("GET", "/api/accounts/movements?account=bank", { token: manager })).body.items as MovementDto[];
    expect(after.find((m) => m.ref.type === "insurer_payment" && !m.ref.isReversal)?.ref).toMatchObject({ reversed: true });
  });

  it("the bank may go below zero only when the manager allows it; never the drawer or the safe", async () => {
    const bank = (await balances()).bank ?? 0;
    const reasons = (await t.call("GET", "/api/accounts/withdrawal-reasons", { token: manager })).body as ListItemDto[];
    const body = () => ({ idempotencyKey: randomUUID(), reasonId: reasons[4]?.id, amountCents: bank + 10_000, explanation: "Test" });
    expect((await t.call("POST", "/api/accounts/withdrawals", { token: manager, body: body() })).body.code).toBe("INSUFFICIENT_BALANCE");
    expect((await t.call("PUT", "/api/accounts/bank-negative", { token: manager, body: { allow: true } })).status).toBe(200);
    expect((await t.call("POST", "/api/accounts/withdrawals", { token: manager, body: body() })).status).toBe(200);
    expect((await balances()).bank).toBe(-10_000);
    // Cannot forbid it again while below zero.
    expect((await t.call("PUT", "/api/accounts/bank-negative", { token: manager, body: { allow: false } })).body.code).toBe("INSUFFICIENT_BALANCE");
    await expect(ownerQuery(t.db, "UPDATE accounts SET allow_negative = true WHERE code = 'safe'")).rejects.toThrow(/accounts_negative_bank_only/);
  });

  it("employees never learn the safe and bank exist; a supervisor with the power sees them", async () => {
    const emp = await employee("plain", ["payments.view", "drawer_balance.view"]);
    for (const path of ["/api/accounts", "/api/accounts/movements?account=bank", "/api/accounts/movements?account=safe", "/api/accounts/withdrawal-reasons"]) {
      expect((await t.call("GET", path, { token: emp })).status).toBe(404);
    }
    expect((await t.call("GET", "/api/accounts/movements?account=drawer", { token: emp })).status).toBe(200);
    expect((await transfer("drawer", "safe", 1, emp)).status).toBe(403);
    const sup = await employee("treasurer", ["sup.transfers"], true);
    expect((await t.call("GET", "/api/accounts", { token: sup })).status).toBe(200);
    // Its power only: no payments to insurers, and only from the bank for a supervisor.
    expect((await t.call("POST", "/api/accounts/insurer-payments", { token: sup, body: { idempotencyKey: randomUUID(), insurerId: s.rma, amountCents: 1 } })).status).toBe(403);
    const payer = await employee("payer", ["sup.insurer_payments_withdrawals"], true);
    expect((await t.call("POST", "/api/accounts/insurer-payments", { token: payer, body: { idempotencyKey: randomUUID(), insurerId: s.rma, amountCents: 1, account: "safe" } })).status).toBe(403);
  });

  it("movements, transfers and reversals cannot be changed or deleted", async () => {
    await expect(ownerQuery(t.db, "UPDATE transfers SET amount_cents = 1")).rejects.toThrow(/append-only/);
    await expect(ownerQuery(t.db, "DELETE FROM bank_withdrawals")).rejects.toThrow(/append-only/);
    await expect(ownerQuery(t.db, "UPDATE drawer_session_members SET counted_cents = 0")).rejects.toThrow(/append-only/);
    await expect(appQuery(t, "DELETE FROM expenses")).rejects.toThrow(/permission denied/);
    await expect(appQuery(t, "UPDATE transfers SET reference = 'x'")).rejects.toThrow(/permission denied/);
  });
});
