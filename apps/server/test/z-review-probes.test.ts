/**
 * Review probes (02/11/2026). Each test states the behaviour the SPEC asks for. A failing test
 * shows a problem found during the code review; nothing in the application code was changed.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEADER_AS_OF } from "@alyassir/shared";
import { MANAGER, createEmployee, startApp, type TestApp } from "./harness";
import { cert, createClient, createPolicy, createVehicle, mustCreatePolicy, next, receiveDrawer, setupCatalog, type Setup } from "./fixtures";

// ---------------------------------------------------------------- historical entry (SPEC 11.3, 22)

describe("PROBE 1: policy status during the historical entry", () => {
  let h: TestApp;
  let manager: string;
  let s: Setup;

  beforeAll(async () => {
    h = await startApp({ historical: true });
    manager = (await h.login(MANAGER.username, MANAGER.password)).accessToken;
    s = await setupCatalog(h, manager);
    await h.call("POST", "/api/historical/answer", { token: manager, body: { hasOldPolicies: true } });
  });
  afterAll(async () => h.close());

  it("a policy of 01/05/2026 for one month is shown 'expired' today, whatever date the yellow bar holds", async () => {
    const at = { [HEADER_AS_OF]: "2026-05-01" };
    const client = await createClient(h, manager, {});
    const vehicle = await createVehicle(h, manager, client);
    const number = `HIST-${next()}`;
    const res = await h.call("POST", "/api/policies", {
      token: manager,
      headers: at,
      body: {
        idempotencyKey: randomUUID(),
        clientId: client,
        insuranceTypeId: s.autoType,
        policyNumber: number,
        coverageDurationId: s.months1,
        totalAmountCents: 100_000,
        vehicles: [{ vehicleId: vehicle, certificateNumber: cert() }],
        finance: { payments: [{ method: "cash", amountCents: 100_000 }] },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.periods[0].endDate).toBe("2026-05-31");
    // The desktop app sends the operation date of the yellow bar with every request, reads included.
    const list = (await h.call("GET", `/api/policies?q=${number}`, { token: manager, headers: at })).body;
    const client360 = (await h.call("GET", `/api/policies/${res.body.id}`, { token: manager, headers: at })).body;
    const report = { list: list.items[0]?.validity, policyPage: client360.periods?.at(-1)?.validity };
    expect(report).toEqual({ list: "expired", policyPage: "expired" });
  });
});

// ---------------------------------------------------------------- live work

describe("live work probes", () => {
  let t: TestApp;
  let manager: string;
  let s: Setup;

  beforeAll(async () => {
    t = await startApp();
    manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
    s = await setupCatalog(t, manager);
    expect((await receiveDrawer(t, manager)).status).toBe(200);
  });
  afterAll(async () => t.close());

  async function employee(name: string, permissions: string[], supervisor = false): Promise<string> {
    const id = await createEmployee(t, manager, name);
    let user = (await t.call("GET", `/api/users/${id}`, { token: manager })).body;
    if (supervisor) user = (await t.call("PATCH", `/api/users/${id}`, { token: manager, body: { version: user.version, isSupervisor: true } })).body;
    await t.call("PUT", `/api/users/${id}/permissions`, { token: manager, body: { version: user.version, permissions } });
    return (await t.login(name, "secret1")).accessToken;
  }
  const accounts = async (): Promise<Record<string, number>> =>
    Object.fromEntries(((await t.call("GET", "/api/accounts", { token: manager })).body as { code: string; balanceCents: number }[]).map((a) => [a.code, a.balanceCents]));
  const cashPolicy = async (amountCents: number, vehicles = 1) => {
    const client = await createClient(t, manager);
    const ids: string[] = [];
    for (let i = 0; i < vehicles; i++) ids.push(await createVehicle(t, manager, client));
    const policy = await mustCreatePolicy(t, manager, s, client, ids, { totalAmountCents: amountCents, finance: { payments: [{ method: "cash", amountCents }] } });
    return { client, vehicles: ids, policy };
  };
  const category = async (): Promise<string> =>
    ((await t.call("GET", "/api/expenses/categories", { token: manager })).body as { id: string; code: string | null }[]).find((c) => c.code === "cleaning")?.id as string;
  const addExpense = async (token: string, amountCents: number) =>
    t.call("POST", "/api/expenses", { token, body: { idempotencyKey: randomUUID(), categoryId: await category(), amountCents, note: "Produits" } });

  it("PROBE 2: an employee who may only see the drawer does not learn that the bank exists (drawer movements)", async () => {
    await cashPolicy(50_000);
    const viewer = await employee("drawerviewer", ["drawer_balance.view"]);
    const moved = await t.call("POST", "/api/accounts/transfers", { token: manager, body: { idempotencyKey: randomUUID(), from: "drawer", to: "bank", amountCents: 10_000, reference: "" } });
    expect(moved.status).toBe(200);
    const items = (await t.call("GET", "/api/accounts/movements?account=drawer", { token: viewer })).body.items as { ref: { type: string; to?: string; from?: string } }[];
    const revealed = items.filter((m) => m.ref.type === "transfer").map((m) => `${m.ref.from} -> ${m.ref.to}`);
    expect(revealed).toEqual([]);
  });

  it("PROBE 3: an employee who sees expenses does not learn that an expense was paid from the bank", async () => {
    const e = (await addExpense(manager, 1_000)).body;
    const ok = await t.call("POST", `/api/expenses/${e.id}/approve`, { token: manager, body: { version: e.version, account: "bank" } });
    expect(ok.body.status).toBe("approved");
    const viewer = await employee("expviewer", ["expenses.view"]);
    const items = (await t.call("GET", "/api/expenses", { token: viewer })).body.items as { id: string; account: string | null }[];
    expect(items.find((x) => x.id === e.id)?.account).not.toBe("bank");
  });

  it("PROBE 4: a supervisor who may approve expenses but not see the bank cannot pay an expense from the bank", async () => {
    const sup = await employee("approver", ["expenses.view", "sup.approve_expenses"], true);
    const e = (await addExpense(manager, 500)).body;
    const res = await t.call("POST", `/api/expenses/${e.id}/approve`, { token: sup, body: { version: e.version, account: "bank" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("PROBE 5: vehicle change: an employee cannot pay out more than the client paid (old price typed by hand)", async () => {
    await cashPolicy(600_000);
    const changer = await employee("changer", ["policies.view", "policies.edit", "payments.view", "payments.create"]);
    expect((await receiveDrawer(t, changer)).status).toBe(200);
    const { client, vehicles, policy } = await cashPolicy(100_000);
    const other = await createVehicle(t, manager, client);
    const drawerBefore = (await accounts()).drawer ?? 0;
    const res = await t.call("POST", `/api/policies/${policy.id}/vehicle-change`, {
      token: changer,
      // The policy cost 1 000 MAD; the "old price" typed is 4 000 MAD -> 3 983 MAD would leave the drawer.
      body: { idempotencyKey: randomUUID(), oldVehicleId: vehicles[0], newVehicleId: other, certificateNumber: cert(), oldPriceCents: 400_000, newPriceCents: 0, reason: "test" },
    });
    const paidOut = drawerBefore - ((await accounts()).drawer ?? 0);
    expect({ status: res.status >= 400 ? "refused" : "accepted", paidOutCents: paidOut }).toEqual({ status: "refused", paidOutCents: 0 });
  });

  it("PROBE 6: fleet: removing a vehicle cannot pay out more than the whole policy", async () => {
    await cashPolicy(900_000);
    const remover = await employee("remover", ["policies.view", "policies.edit", "payments.view", "payments.create"]);
    expect((await receiveDrawer(t, remover)).status).toBe(200);
    const { policy, vehicles } = await cashPolicy(250_000, 6);
    const drawerBefore = (await accounts()).drawer ?? 0;
    const res = await t.call("POST", `/api/policies/${policy.id}/fleet/remove`, {
      token: remover,
      body: { idempotencyKey: randomUUID(), vehicleId: vehicles[0], reason: "test", refundCents: 800_000 },
    });
    const paidOut = drawerBefore - ((await accounts()).drawer ?? 0);
    expect({ status: res.status >= 400 ? "refused" : "accepted", paidOutCents: paidOut }).toEqual({ status: "refused", paidOutCents: 0 });
  });

  it("PROBE 7: an instalment policy cannot be edited to a 1-month cover (instalments need 6 or 12 months)", async () => {
    const client = await createClient(t, manager);
    const vehicle = await createVehicle(t, manager, client);
    const res = await createPolicy(t, manager, s, client, [vehicle], { totalAmountCents: 400_000, finance: { instalments: { count: 2 } } });
    expect(res.status).toBe(201);
    const edit = await t.call("PATCH", `/api/policies/${res.body.id}`, { token: manager, body: { version: res.body.version, coverageDurationId: s.months1 } });
    expect(edit.status).toBeGreaterThanOrEqual(400);
  });

  it("PROBE 8: an expense waiting for approval is taken from the drawer only once (closing, then approval)", async () => {
    const cashier = await employee("cashier", ["payments.view", "payments.create", "expenses.view", "expenses.create", "closing.view", "closing.create"]);
    expect((await receiveDrawer(t, cashier)).status).toBe(200);
    const before = (await accounts()).drawer ?? 0;
    // The cashier takes 200 MAD from the drawer for cleaning: it waits for the manager.
    const e = (await addExpense(cashier, 20_000)).body;
    expect(e.status).toBe("pending");
    // Evening closing: 200 MAD less in the drawer, the pending expense is the reason (owner decision 28/10/2026).
    const st = (await t.call("GET", "/api/drawer", { token: cashier })).body;
    const closed = await t.call("POST", "/api/drawer/close", { token: cashier, body: { sessionVersion: st.session?.version ?? 1, countedCents: before - 20_000, reason: "Pending expense" } });
    expect(closed.status).toBe(200);
    // Next day the manager approves it.
    const ok = await t.call("POST", `/api/expenses/${e.id}/approve`, { token: manager, body: { version: e.version } });
    expect(ok.body.status).toBe("approved");
    // Real cash in the drawer: before - 200 MAD.
    expect((await accounts()).drawer).toBe(before - 20_000);
  });
});
