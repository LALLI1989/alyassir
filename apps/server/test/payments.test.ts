import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, businessDay } from "@alyassir/domain";
import type { PolicyFinanceDto } from "@alyassir/shared";
import { JobsService } from "../src/money/jobs.service";
import { MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";
import { appQuery, cert, createClient, createVehicle, mustCreatePolicy, receiveDrawer, setPeriod, setupCatalog, type Setup } from "./fixtures";

let t: TestApp;
let manager: string;
let s: Setup;
const today = () => businessDay(new Date());

beforeAll(async () => {
  t = await startApp();
  manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
  s = await setupCatalog(t, manager);
  await receiveDrawer(t, manager);
  const c = (await t.call("GET", "/api/insurance/catalog", { token: manager })).body;
  months3 = c.durations.find((d: { months: number }) => d.months === 3).id;
});
afterAll(async () => t.close());

let months3 = "";

async function employee(name: string, permissions: string[], supervisor = false): Promise<string> {
  const id = await createEmployee(t, manager, name);
  let user = (await t.call("GET", `/api/users/${id}`, { token: manager })).body;
  if (supervisor) user = (await t.call("PATCH", `/api/users/${id}`, { token: manager, body: { version: user.version, isSupervisor: true } })).body;
  await t.call("PUT", `/api/users/${id}/permissions`, { token: manager, body: { version: user.version, permissions } });
  const token = (await t.login(name, "secret1")).accessToken;
  if (permissions.includes("payments.create")) await receiveDrawer(t, token);
  return token;
}

const cash = (amountCents: number) => ({ method: "cash", amountCents });
const cheque = (amountCents: number, dueDate = addDays(today(), 10)) => ({ method: "cheque", amountCents, cheque: { number: `CHQ${Math.floor(Math.random() * 1e6)}`, bank: "Attijariwafa bank", drawerName: "Said EL IDRISSI", dueDate } });

async function insured(finance: Record<string, unknown> = {}, total = 400_000) {
  const client = await createClient(t, manager);
  const vehicle = await createVehicle(t, manager, client);
  const policy = await mustCreatePolicy(t, manager, s, client, [vehicle], { totalAmountCents: total, finance });
  return { client, vehicle, policy };
}

const finance = async (policyId: string, token = manager): Promise<PolicyFinanceDto> => (await t.call("GET", `/api/policies/${policyId}/finance`, { token })).body;
const drawer = async (): Promise<number> => (await t.call("GET", "/api/accounts/drawer", { token: manager })).body.balanceCents;
const pay = (policyId: string, line: Record<string, unknown>, token = manager, key = randomUUID()) =>
  t.call("POST", `/api/policies/${policyId}/payments`, { token, body: { idempotencyKey: key, ...line } });
const bank = async (): Promise<number> => Number((await ownerQuery(t.db, "SELECT balance_cents FROM accounts WHERE code = 'bank'")).rows[0]?.balance_cents);
const change = (policyId: string, oldVehicleId: string, newVehicleId: string, o: number, n: number, extra: Record<string, unknown> = {}, token = manager) =>
  t.call("POST", `/api/policies/${policyId}/vehicle-change`, {
    token,
    body: { idempotencyKey: randomUUID(), oldVehicleId, newVehicleId, certificateNumber: cert(), oldPriceCents: o, newPriceCents: n, reason: "تغيير", ...extra },
  });
async function systemMessages(event: string): Promise<{ body: string }[]> {
  const res = await ownerQuery(t.db, "SELECT m.body FROM messages m JOIN message_threads th ON th.id = m.thread_id WHERE th.subject = $1 ORDER BY m.created_at", [`system:${event}`]);
  return res.rows as { body: string }[];
}

describe("instalments at issue (SPEC 14.4)", () => {
  it("4000 in 2: 2017 + 2000 = 4017, monthly from the start, the first today", async () => {
    const { policy } = await insured({ instalments: { count: 2 } });
    const f = await finance(policy.id);
    expect(f.instalments.map((i) => [i.amountCents, i.feeCents, i.dueDate])).toEqual([[201_700, 1700, today()], [200_000, 0, f.instalments[1]?.dueDate]]);
    expect(f.totals).toMatchObject({ dueCents: 401_700, paidCents: 0, remainingCents: 401_700 });
    expect(f.collectionStatus).toBe("outstanding");
    expect(f.paymentState).toBe("instalments_open");
    const preview = await t.call("POST", "/api/policies/instalments-preview", { token: manager, body: { totalAmountCents: 100_000, count: 3 } });
    expect(preview.body.instalments.map((x: { amountCents: number }) => x.amountCents)).toEqual([35_033, 35_033, 33_334]);
    expect(preview.body.totalCents).toBe(103_400);
  });

  it("refused for a fleet, a 3-month policy or a policy without vehicle", async () => {
    const c = await createClient(t, manager);
    const three = await t.call("POST", "/api/policies", {
      token: manager,
      body: { idempotencyKey: randomUUID(), clientId: c, insuranceTypeId: s.autoType, policyNumber: `P3-${randomUUID().slice(0, 6)}`, coverageDurationId: months3, totalAmountCents: 100_000, vehicles: [{ vehicleId: await createVehicle(t, manager, c), certificateNumber: cert() }], finance: { instalments: { count: 2 } } },
    });
    expect(three.body.code).toBe("INSTALMENTS_NOT_ALLOWED");
    const home = await t.call("POST", "/api/policies", {
      token: manager,
      body: { idempotencyKey: randomUUID(), clientId: c, insuranceTypeId: s.homeType, policyNumber: `H-${randomUUID().slice(0, 6)}`, coverageDurationId: s.months12, totalAmountCents: 100_000, finance: { instalments: { count: 3 } } },
    });
    expect(home.body.code).toBe("INSTALMENTS_NOT_ALLOWED");
    const vehicles = [];
    for (let i = 0; i < 5; i++) vehicles.push(await createVehicle(t, manager, c));
    const fleet = await t.call("POST", "/api/policies", {
      token: manager,
      body: { idempotencyKey: randomUUID(), clientId: c, insuranceTypeId: s.fleetType, policyNumber: `F-${randomUUID().slice(0, 6)}`, coverageDurationId: s.months12, totalAmountCents: 900_000, isFleet: true, vehicles: vehicles.map((vehicleId) => ({ vehicleId, certificateNumber: cert() })), finance: { instalments: { count: 2 } } },
    });
    expect(fleet.body.code).toBe("INSTALMENTS_NOT_ALLOWED");
  });
});

describe("payments (SPEC 14.1, 14.3, 14.5)", () => {
  it("cash at issue goes to the drawer; a receipt 2026-000001 style is issued; the policy is paid", async () => {
    const before = await drawer();
    const { policy } = await insured({ payments: [cash(250_000)] }, 250_000);
    const f = await finance(policy.id);
    expect(f.collectionStatus).toBe("paid");
    expect(f.paymentState).toBe("fully_paid");
    expect(await drawer()).toBe(before + 250_000);
    expect(f.receipts[0]?.number).toMatch(new RegExp(`^${today().slice(0, 4)}-\\d{6}$`));
    const receipt = (await t.call("GET", `/api/receipts/${f.receipts[0]?.id}`, { token: manager })).body;
    expect(receipt.snapshot).toMatchObject({ method: "cash", paidCents: 250_000, remainingCents: 0, policy: { number: policy.policyNumber, insurer: "RMA" } });
  });

  it("never more than what is due", async () => {
    const { policy } = await insured({}, 100_000);
    expect((await pay(policy.id, cash(100_001))).body.code).toBe("OVERPAYMENT");
    const atIssue = await t.call("POST", "/api/policies", {
      token: manager,
      body: { idempotencyKey: randomUUID(), clientId: policy.clientId, insuranceTypeId: s.autoType, policyNumber: `O-${randomUUID().slice(0, 6)}`, coverageDurationId: s.months12, totalAmountCents: 1000, vehicles: [{ vehicleId: await createVehicle(t, manager, policy.clientId), certificateNumber: cert() }], finance: { payments: [cash(1001)] } },
    });
    expect(atIssue.body.code).toBe("OVERPAYMENT");
  });

  it("more or less than an instalment: oldest first, the rest carries on (1000 in 3)", async () => {
    const { policy } = await insured({ instalments: { count: 3 } }, 100_000);
    const res = await pay(policy.id, cash(50_000));
    expect(res.status).toBe(200);
    expect(res.body.instalments.map((i: { paidCents: number; status: string }) => [i.paidCents, i.status])).toEqual([[35_033, "paid"], [14_967, "partial"], [0, "pending"]]);
    expect(res.body.totals.remainingCents).toBe(103_400 - 50_000);
  });

  it("cheque: in collection (not in the bank) until the manager confirms; then in the bank", async () => {
    const { policy } = await insured({}, 300_000);
    const bankBefore = await bank();
    const res = await pay(policy.id, cheque(300_000, addDays(today(), 2)));
    expect(res.body).toMatchObject({ collectionStatus: "in_collection", totals: { inCollectionCents: 300_000, remainingCents: 0 } });
    expect(await bank()).toBe(bankBefore);
    const payment = res.body.payments[0];
    expect(payment).toMatchObject({ status: "in_collection", dueSoon: true, cheque: { bank: "Attijariwafa bank" } });

    const emp = await employee("cashier", ["payments.view", "payments.create"]);
    expect((await t.call("POST", `/api/payments/${payment.id}/confirm`, { token: emp, body: { version: payment.version } })).status).toBe(403);
    const sup = await employee("chiefcash", ["payments.view", "sup.confirm_collection"], true);
    const ok = await t.call("POST", `/api/payments/${payment.id}/confirm`, { token: sup, body: { version: payment.version } });
    expect(ok.body.status).toBe("confirmed");
    expect(await bank()).toBe(bankBefore + 300_000);
    expect((await finance(policy.id)).collectionStatus).toBe("paid");
  });

  it("a cheque returned after confirmation: reversed in the bank, a debt again, receipt cancelled, the manager told", async () => {
    const { policy } = await insured({}, 200_000);
    const p = (await pay(policy.id, cheque(200_000))).body.payments[0];
    await t.call("POST", `/api/payments/${p.id}/confirm`, { token: manager, body: { version: p.version } });
    const bankAfterConfirm = await bank();
    const noReason = await t.call("POST", `/api/payments/${p.id}/reject`, { token: manager, body: { version: p.version + 1, reason: "" } });
    expect(noReason.body.fields.reason).toBe("required");
    const rejected = await t.call("POST", `/api/payments/${p.id}/reject`, { token: manager, body: { version: p.version + 1, reason: "شيك بدون رصيد" } });
    expect(rejected.body).toMatchObject({ status: "rejected", rejectReason: "شيك بدون رصيد" });
    expect(await bank()).toBe(bankAfterConfirm - 200_000);
    const f = await finance(policy.id);
    expect(f.collectionStatus).toBe("payment_rejected");
    expect(f.debts.find((d) => d.source === "rejected_payment")).toMatchObject({ amountCents: 200_000, remainingCents: 200_000 });
    expect((await t.call("GET", `/api/policies/${policy.id}`, { token: manager })).body.validity).toBe("active");
    expect(f.receipts.find((r) => r.kind === "payment")?.status).toBe("cancelled");
    const msgs = await systemMessages("payment_rejected");
    expect(JSON.parse(msgs.at(-1)?.body ?? "{}").params).toMatchObject({ policyNumber: policy.policyNumber, amountCents: 200_000, bank: "Attijariwafa bank" });
    expect((await t.call("POST", `/api/payments/${p.id}/reject`, { token: manager, body: { version: p.version + 2, reason: "x" } })).body.code).toBe("PAYMENT_ALREADY_REJECTED");
  });

  it("the same click twice is one payment; two payments at once never exceed what is due", async () => {
    const { policy } = await insured({}, 100_000);
    const key = randomUUID();
    const [a, b] = await Promise.all([pay(policy.id, cash(30_000), manager, key), pay(policy.id, cash(30_000), manager, key)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await finance(policy.id)).payments).toHaveLength(1);
    const results = await Promise.all([pay(policy.id, cash(50_000)), pay(policy.id, cash(50_000))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await finance(policy.id)).totals.remainingCents).toBe(20_000);
  });

  it("receipt numbers have no gap, even with payments at the same moment", async () => {
    const { policy } = await insured({}, 100_000);
    await Promise.all([1, 2, 3, 4, 5].map(() => pay(policy.id, cash(1_000))));
    const numbers = (await finance(policy.id)).receipts.map((r) => Number(r.number.split("-")[1])).sort((x, y) => x - y);
    expect(numbers).toHaveLength(5);
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBe((numbers[i - 1] as number) + 1);
  });

  it("a fleet is paid in full or by cheques", async () => {
    const c = await createClient(t, manager);
    const vehicles = [];
    for (let i = 0; i < 5; i++) vehicles.push(await createVehicle(t, manager, c));
    const fleet = await mustCreatePolicy(t, manager, s, c, vehicles, { totalAmountCents: 1_000_000 });
    expect((await pay(fleet.id, cash(100_000))).body.code).toBe("FLEET_PAYMENT_CHEQUES_ONLY");
    expect((await pay(fleet.id, cheque(400_000))).status).toBe(200);
    expect((await pay(fleet.id, cash(600_000))).status).toBe(200);
  });

  it("an employee needs the debt permission to leave a policy unpaid", async () => {
    const token = await employee("seller", ["clients.view", "vehicles.view", "policies.view", "policies.create", "payments.create"]);
    const c = await createClient(t, manager);
    const body = (finance: unknown) => ({ idempotencyKey: randomUUID(), clientId: c, insuranceTypeId: s.autoType, policyNumber: `E-${randomUUID().slice(0, 6)}`, coverageDurationId: s.months12, totalAmountCents: 100_000, finance });
    const unpaid = await t.call("POST", "/api/policies", { token, body: { ...body({}), vehicles: [{ vehicleId: await createVehicle(t, manager, c), certificateNumber: cert() }] } });
    expect(unpaid.status).toBe(403);
    const paid = await t.call("POST", "/api/policies", { token, body: { ...body({ payments: [cash(100_000)] }), vehicles: [{ vehicleId: await createVehicle(t, manager, c), certificateNumber: cert() }] } });
    expect(paid.status).toBe(201);
    const instal = await t.call("POST", "/api/policies", { token, body: { ...body({ instalments: { count: 2 } }), vehicles: [{ vehicleId: await createVehicle(t, manager, c), certificateNumber: cert() }] } });
    expect(instal.status).toBe(201);
  });
});

describe("late instalment becomes a debt (SPEC 14.6)", () => {
  it("due D: still an instalment on D+2, a debt from D+3, the manager told, run once per day, catches up", async () => {
    const jobs = t.app.get(JobsService);
    const { policy } = await insured({ instalments: { count: 2 } }, 400_000);
    // Dates before every other instalment of this test database, so only this policy is concerned.
    const D = "2026-01-10";
    await ownerQuery(t.db, "UPDATE installments SET due_date = $2 WHERE policy_id = $1 AND seq = 1", [policy.id, D]);
    await ownerQuery(t.db, "UPDATE installments SET due_date = '2026-02-10' WHERE policy_id = $1 AND seq = 2", [policy.id]);
    expect(await jobs.runDebtConversion("2026-01-12")).toBe(0);
    expect((await finance(policy.id)).instalments[0]?.status).toBe("pending");
    expect(await jobs.runDebtConversion("2026-01-13")).toBe(1);
    const f = await finance(policy.id);
    expect(f.instalments[0]?.status).toBe("converted_to_debt");
    expect(f.debts.find((d) => d.source === "installment")).toMatchObject({ amountCents: 201_700, remainingCents: 201_700, debtDate: D });
    expect(f.paymentState).toBe("instalments_open");
    expect(JSON.parse((await systemMessages("instalments_to_debt")).at(-1)?.body ?? "{}").params.items[0]).toMatchObject({ policyNumber: policy.policyNumber, amountCents: 201_700 });
    // Same day again: nothing. A day missed (server off): the next run converts what is late.
    expect(await jobs.runDebtConversion("2026-01-13")).toBe(0);
    expect(await jobs.runDebtConversion("2026-02-20")).toBe(1);
    expect((await finance(policy.id)).instalments[1]?.status).toBe("converted_to_debt");
    // Paying the debt later: no penalty, the fee stays inside.
    const res = await pay(policy.id, cash(201_700));
    expect(res.body.debts.find((d: { source: string; debtDate: string }) => d.source === "installment" && d.debtDate === D).status).toBe("paid");
  });
});

describe("annulment and cancellation with money (SPEC 13)", () => {
  it("fully paid, within 15 days: everything paid comes back from the drawer, with a receipt", async () => {
    const { policy } = await insured({ payments: [cash(250_000)] }, 250_000);
    expect((await finance(policy.id)).annulment).toMatchObject({ allowed: true, refundCents: 250_000 });
    const before = await drawer();
    const res = await t.call("POST", `/api/policies/${policy.id}/annul`, { token: manager, body: { idempotencyKey: randomUUID(), reason: "طلب العميل" } });
    expect(res.body.validity).toBe("annulled");
    expect(await drawer()).toBe(before - 250_000);
    const f = await finance(policy.id);
    expect(f.receipts.find((r) => r.kind === "refund")?.amountCents).toBe(250_000);
  });

  it("instalments not fully paid: any time, nothing back, the rest of the debt falls", async () => {
    const { policy } = await insured({ instalments: { count: 2 }, payments: [cash(201_700)] }, 400_000);
    await setPeriod(t, policy.id, addDays(today(), -100), addDays(today(), 264), 24 * 100);
    const before = await drawer();
    const res = await t.call("POST", `/api/policies/${policy.id}/annul`, { token: manager, body: { idempotencyKey: randomUUID(), reason: "توقف عن الأداء" } });
    expect(res.body.validity).toBe("annulled");
    expect(await drawer()).toBe(before);
    const f = await finance(policy.id);
    expect(f.instalments.map((i) => i.status)).toEqual(["paid", "written_off"]);
    expect(f.totals.remainingCents).toBe(0);
  });

  it("instalments fully paid: annulment refused (cancellation instead); a cheque in collection blocks it", async () => {
    const { policy } = await insured({ instalments: { count: 2 }, payments: [cash(401_700)] }, 400_000);
    expect((await t.call("POST", `/api/policies/${policy.id}/annul`, { token: manager, body: { idempotencyKey: randomUUID(), reason: "x" } })).body.code).toBe("ANNULMENT_USE_CANCELLATION");
    const other = await insured({}, 100_000);
    await pay(other.policy.id, cheque(100_000));
    expect((await t.call("POST", `/api/policies/${other.policy.id}/annul`, { token: manager, body: { idempotencyKey: randomUUID(), reason: "x" } })).body.code).toBe("PAYMENT_IN_COLLECTION");
  });

  it("cancellation: refused with open instalments; a direct debt takes the refund (1000 owed, 500 refund -> 500 owed, no money out)", async () => {
    const open = await insured({ instalments: { count: 2 } }, 400_000);
    expect((await t.call("POST", `/api/policies/${open.policy.id}/cancel`, { token: manager, body: { idempotencyKey: randomUUID(), reason: "x", refundCents: 1000 } })).body.code).toBe("CANCELLATION_INSTALMENTS_OPEN");
    const { policy } = await insured({}, 100_000);
    const before = await drawer();
    const res = await t.call("POST", `/api/policies/${policy.id}/cancel`, { token: manager, body: { idempotencyKey: randomUUID(), reason: "قرار الشركة", refundCents: 50_000 } });
    expect(res.body.validity).toBe("cancelled");
    expect(await drawer()).toBe(before);
    const f = await finance(policy.id);
    expect(f.debts.find((d) => d.source === "direct")?.remainingCents).toBe(50_000);
  });

  it("cancellation: the manager may pay the refund out instead, from the account he chooses", async () => {
    await insured({ payments: [cash(300_000)] }, 300_000); // cash in the drawer
    const { policy } = await insured({}, 100_000);
    const before = await drawer();
    const res = await t.call("POST", `/api/policies/${policy.id}/cancel`, { token: manager, body: { idempotencyKey: randomUUID(), reason: "صرف المبلغ", refundCents: 40_000, payOut: true } });
    expect(res.status).toBe(200);
    expect(await drawer()).toBe(before - 40_000);
    expect((await finance(policy.id)).debts.find((d) => d.source === "direct")?.remainingCents).toBe(100_000);
  });
});

describe("fees and price changes (SPEC 15, 16)", () => {

  it("increase 300 not paid now: + 317 on the nearest unpaid instalment", async () => {
    const { client, vehicle, policy } = await insured({ instalments: { count: 2 }, payments: [cash(201_700)] }, 400_000);
    const res = await change(policy.id, vehicle, await createVehicle(t, manager, client), 100_000, 130_000, { settlement: "defer" });
    expect(res.status).toBe(200);
    const f = await finance(policy.id);
    expect(f.instalments[1]?.amountCents).toBe(200_000 + 31_700);
  });

  it("same price, paid now: 17 into the drawer with an A5 receipt", async () => {
    const { client, vehicle, policy } = await insured({ payments: [cash(100_000)] }, 100_000);
    const before = await drawer();
    await change(policy.id, vehicle, await createVehicle(t, manager, client), 100_000, 100_000);
    expect(await drawer()).toBe(before + 1700);
    const f = await finance(policy.id);
    expect(f.receipts.find((r) => r.kind === "operation")?.amountCents).toBe(1700);
    expect(f.collectionStatus).toBe("paid");
  });

  it("same price, not paid, nothing else owed: a new debt of 17", async () => {
    const { client, vehicle, policy } = await insured({ payments: [cash(100_000)] }, 100_000);
    await change(policy.id, vehicle, await createVehicle(t, manager, client), 100_000, 100_000, { settlement: "defer" });
    expect((await finance(policy.id)).debts.find((d) => d.source === "certificate_fee")?.remainingCents).toBe(1700);
  });

  it("decrease 120: the client receives 103 from the drawer; with a debt, it is taken off the debt first", async () => {
    await insured({ payments: [cash(500_000)] }, 500_000); // cash in the drawer
    const paid = await insured({ payments: [cash(100_000)] }, 100_000);
    const before = await drawer();
    await change(paid.policy.id, paid.vehicle, await createVehicle(t, manager, paid.client), 100_000, 88_000);
    expect(await drawer()).toBe(before - 10_300);
    expect((await finance(paid.policy.id)).receipts.find((r) => r.kind === "refund")?.amountCents).toBe(10_300);

    const owing = await insured({ payments: [cash(95_000)] }, 100_000); // 50 MAD still owed
    const before2 = await drawer();
    await change(owing.policy.id, owing.vehicle, await createVehicle(t, manager, owing.client), 100_000, 88_000);
    expect(await drawer()).toBe(before2 - 5_300);
    expect((await finance(owing.policy.id)).totals.remainingCents).toBe(0);
  });

  it("plate change and duplicate cost 17 each", async () => {
    const { vehicle, policy } = await insured({ payments: [cash(100_000)] }, 100_000);
    const before = await drawer();
    await t.call("POST", `/api/policies/${policy.id}/plate-change`, { token: manager, body: { idempotencyKey: randomUUID(), vehicleId: vehicle, plateType: "ma", plate: "9-C-4321", certificateNumber: cert(), reason: "ترقيم دائم" } });
    await t.call("POST", `/api/policies/${policy.id}/duplicate`, { token: manager, body: { idempotencyKey: randomUUID(), vehicleId: vehicle, certificateNumber: cert(), reason: "ضياع" } });
    expect(await drawer()).toBe(before + 3400);
  });

  it("fleet: an amount typed by the employee, no fee; a removal is taken off the debt", async () => {
    const c = await createClient(t, manager);
    const vehicles = [];
    for (let i = 0; i < 6; i++) vehicles.push(await createVehicle(t, manager, c));
    const fleet = await mustCreatePolicy(t, manager, s, c, vehicles.slice(0, 5), { totalAmountCents: 1_000_000 });
    await t.call("POST", `/api/policies/${fleet.id}/fleet/add`, { token: manager, body: { idempotencyKey: randomUUID(), vehicleId: vehicles[5], certificateNumber: cert(), reason: "شاحنة", amountCents: 150_000, settlement: "defer" } });
    expect((await finance(fleet.id)).totals.remainingCents).toBe(1_150_000);
    await t.call("POST", `/api/policies/${fleet.id}/fleet/remove`, { token: manager, body: { idempotencyKey: randomUUID(), vehicleId: vehicles[0], reason: "بيعت", refundCents: 90_000 } });
    expect((await finance(fleet.id)).totals.remainingCents).toBe(1_060_000);
  });
});

describe("balances never go below zero (SPEC 17.1, 13.3)", () => {
  it("an employee short of drawer cash is stopped and the manager is asked automatically", async () => {
    // The employee has to give back more than the drawer holds.
    const token = await employee("refunder", ["clients.view", "vehicles.view", "policies.view", "policies.edit", "payments.view", "payments.create"]);
    const big = await insured({ payments: [cheque(5_000_000)] }, 5_000_000);
    const balance = await drawer();
    const { client, vehicle } = big;
    // A decrease larger than the drawer, nothing owed (the cheque counts as paid).
    const res = await change(big.policy.id, vehicle, await createVehicle(t, manager, client), 5_000_000, 5_000_000 - balance - 200_000, {}, token);
    expect(res.body.code).toBe("DRAWER_INSUFFICIENT");
    expect(await drawer()).toBe(balance);
    expect(JSON.parse((await systemMessages("refund_needs_manager")).at(-1)?.body ?? "{}").params).toMatchObject({ policyNumber: big.policy.policyNumber, employee: "REFUNDER" });
    // The employee may not pick another account.
    const other = await change(big.policy.id, vehicle, await createVehicle(t, manager, client), 5_000_000, 4_990_000, { refundAccount: "bank" }, token);
    expect(other.body.code).toBe("REFUND_ACCOUNT_FORBIDDEN");
  });

  it("the database itself refuses a negative balance and any change to the ledger", async () => {
    await expect(ownerQuery(t.db, "UPDATE accounts SET balance_cents = -1 WHERE code = 'drawer'")).rejects.toThrow(/accounts_no_negative/);
    await expect(ownerQuery(t.db, "UPDATE financial_transactions SET amount_cents = 1")).rejects.toThrow(/append-only/);
    await expect(ownerQuery(t.db, "DELETE FROM financial_transactions")).rejects.toThrow(/append-only/);
    await expect(appQuery(t, "DELETE FROM payments")).rejects.toThrow(/permission denied/);
    await expect(appQuery(t, "UPDATE receipts SET amount_cents = 0")).rejects.toThrow(/permission denied/);
  });

  it("employees never see the safe or the bank; the drawer only with its permission", async () => {
    const none = await employee("nobalance", ["payments.view"]);
    expect((await t.call("GET", "/api/accounts/drawer", { token: none })).status).toBe(403);
    const sees = await employee("drawerview", ["drawer_balance.view"]);
    expect((await t.call("GET", "/api/accounts/drawer", { token: sees })).status).toBe(200);
    for (const path of ["/api/accounts/bank", "/api/accounts/safe"]) expect((await t.call("GET", path, { token: manager })).status).toBe(404);
  });
});
