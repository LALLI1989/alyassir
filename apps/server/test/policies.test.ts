import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, businessDay, coverageEnd } from "@alyassir/domain";
import { MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";
import { appQuery, cert, createClient, createPolicy, createVehicle, getPolicy, mustCreatePolicy, setPeriod, setupCatalog, type Setup } from "./fixtures";

let t: TestApp;
let manager: string;
let s: Setup;
const today = () => businessDay(new Date());

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

async function insuredVehicle(): Promise<{ client: string; vehicle: string; policy: Awaited<ReturnType<typeof mustCreatePolicy>> }> {
  const client = await createClient(t, manager);
  const vehicle = await createVehicle(t, manager, client);
  const policy = await mustCreatePolicy(t, manager, s, client, [vehicle]);
  return { client, vehicle, policy };
}

describe("new policy (SPEC 11)", () => {
  it("starts today and ends after the duration, minus one day; the end may be typed", async () => {
    const { policy } = await insuredVehicle();
    expect(policy.startDate).toBe(today());
    expect(policy.endDate).toBe(coverageEnd(today(), 12));
    expect(policy).toMatchObject({ validity: "active", totalAmountCents: 250_000, insurerName: "RMA" });
    expect(policy.operations.map((o) => o.type)).toEqual(["new_issue"]);

    const preview = await t.call("POST", "/api/policies/dates-preview", { token: manager, body: { coverageDurationId: s.months1 } });
    expect(preview.body).toEqual({ startDate: today(), endDate: coverageEnd(today(), 1) });

    const c = await createClient(t, manager);
    const v = await createVehicle(t, manager, c);
    const typed = await mustCreatePolicy(t, manager, s, c, [v], { endDate: addDays(today(), 100) });
    expect(typed.endDate).toBe(addDays(today(), 100));
    const backwards = await createPolicy(t, manager, s, c, [await createVehicle(t, manager, c)], { endDate: addDays(today(), -1) });
    expect(backwards.body.code).toBe("END_BEFORE_START");
  });

  it("needs a policy number unique within the insurer (another insurer may reuse it)", async () => {
    const c = await createClient(t, manager);
    await mustCreatePolicy(t, manager, s, c, [await createVehicle(t, manager, c)], { policyNumber: "RMA-2026-0001" });
    const dup = await createPolicy(t, manager, s, c, [await createVehicle(t, manager, c)], { policyNumber: "rma 2026-0001".replace(" ", "-") });
    expect(dup.body.code).toBe("POLICY_NUMBER_TAKEN");
    const otherInsurer = await createPolicy(t, manager, s, c, [await createVehicle(t, manager, c)], { policyNumber: "RMA-2026-0001", insuranceTypeId: (await t.call("GET", "/api/insurance/catalog", { token: manager })).body.types.find((x: { insurerId: string }) => x.insurerId === s.other).id });
    expect(otherInsurer.status).toBe(201);
    const missing = await createPolicy(t, manager, s, c, [await createVehicle(t, manager, c)], { policyNumber: "" });
    expect(missing.body.fields?.policyNumber).toBe("required");
  });

  it("needs a certificate for a vehicle policy, unique within the insurer and never reused", async () => {
    const c = await createClient(t, manager);
    const noVehicle = await createPolicy(t, manager, s, c, []);
    expect(noVehicle.body.code).toBe("CERTIFICATE_REQUIRED");
    const p = await mustCreatePolicy(t, manager, s, c, [await createVehicle(t, manager, c)]);
    const used = p.vehicles[0]?.certificateNumber as string;
    const again = await createPolicy(t, manager, s, c, [await createVehicle(t, manager, c)], { vehicles: [{ vehicleId: await createVehicle(t, manager, c), certificateNumber: used.toLowerCase() }] });
    expect(again.body.code).toBe("CERTIFICATE_TAKEN");
    // A certificate row can never change, so its number can never come back.
    await expect(ownerQuery(t.db, "UPDATE certificates SET number = 'FREE'")).rejects.toThrow(/append-only/);
    await expect(ownerQuery(t.db, "DELETE FROM certificates")).rejects.toThrow(/append-only/);
  });

  it("a policy without vehicle has no certificate", async () => {
    const c = await createClient(t, manager);
    const home = await createPolicy(t, manager, s, c, [], { insuranceTypeId: s.homeType });
    expect(home.status).toBe(201);
    expect(home.body.vehicles).toEqual([]);
  });

  it("refuses a vehicle that already has an active policy, or of another client", async () => {
    const { client, vehicle, policy } = await insuredVehicle();
    const res = await createPolicy(t, manager, s, client, [vehicle]);
    expect(res.body).toMatchObject({ code: "VEHICLE_ALREADY_INSURED", message: policy.policyNumber });
    const stranger = await createClient(t, manager);
    const foreign = await createPolicy(t, manager, s, stranger, [await createVehicle(t, manager, client)]);
    expect(foreign.body.code).toBe("VEHICLE_NOT_OF_CLIENT");
  });

  it("the same click twice creates one policy; the key cannot be reused for something else", async () => {
    const c = await createClient(t, manager);
    const v = await createVehicle(t, manager, c);
    const body = { idempotencyKey: randomUUID(), clientId: c, insuranceTypeId: s.autoType, policyNumber: "IDEM-1", coverageDurationId: s.months12, totalAmountCents: 100_000, vehicles: [{ vehicleId: v, certificateNumber: cert() }] };
    const [a, b] = await Promise.all([t.call("POST", "/api/policies", { token: manager, body }), t.call("POST", "/api/policies", { token: manager, body })]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe(b.body.id);
    const count = await ownerQuery(t.db, "SELECT count(*)::int AS n FROM policies WHERE policy_number = 'IDEM-1'");
    expect(count.rows[0]?.n).toBe(1);
    const reused = await t.call("POST", "/api/policies", { token: manager, body: { ...body, totalAmountCents: 1 } });
    expect(reused.body.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("two people typing the same certificate at the same moment: only one succeeds", async () => {
    const c = await createClient(t, manager);
    const [v1, v2] = [await createVehicle(t, manager, c), await createVehicle(t, manager, c)];
    const shared = cert();
    const results = await Promise.all(
      [v1, v2].map((v) => createPolicy(t, manager, s, c, [v], { vehicles: [{ vehicleId: v, certificateNumber: shared }] })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe("CERTIFICATE_TAKEN");
  });

  it("only users with the permission see or create policies", async () => {
    const viewer = await employee("polviewer", ["policies.view"]);
    expect((await t.call("GET", "/api/policies", { token: viewer })).status).toBe(200);
    const c = await createClient(t, manager);
    expect((await createPolicy(t, viewer, s, c, [await createVehicle(t, manager, c)])).status).toBe(403);
    const none = await employee("polnone", []);
    expect((await t.call("GET", "/api/policies", { token: none })).status).toBe(403);
  });

  it("finds a policy by number, certificate, plate or client", async () => {
    const c = await createClient(t, manager, { fullName: "Zineb EL KASSIMI" });
    const v = await createVehicle(t, manager, c, { plateType: "ma", plate: "33-H-4455" });
    const p = await mustCreatePolicy(t, manager, s, c, [v], { policyNumber: "FIND-ME-77" });
    for (const q of ["find-me", p.vehicles[0]?.certificateNumber as string, "33H4455", "kassimi"]) {
      const res = await t.call("GET", `/api/policies?q=${encodeURIComponent(q)}`, { token: manager });
      expect(res.body.items.map((x: { id: string }) => x.id), q).toContain(p.id);
    }
  });
});

describe("renewal and policy change (SPEC 12): dates, not hours", () => {
  async function expiring(endOffset: number) {
    const x = await insuredVehicle();
    const end = addDays(today(), endOffset);
    await setPeriod(t, x.policy.id, addDays(end, -364), end, 24 * 400);
    return { ...x, end };
  }

  it("before E: a renewal with the same number, starting E+1 by default", async () => {
    const { policy, vehicle, end } = await expiring(5);
    const p = await getPolicy(t, manager, policy.id);
    expect(p.actions).toMatchObject({ renewalMode: "renewal", nextStartDate: addDays(end, 1), renewalLastDay: addDays(end, 1) });
    const res = await t.call("POST", `/api/policies/${policy.id}/renew`, {
      token: manager,
      body: { idempotencyKey: randomUUID(), coverageDurationId: s.months12, totalAmountCents: 260_000, certificates: [{ vehicleId: vehicle, certificateNumber: cert() }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.policyNumber).toBe(policy.policyNumber);
    expect(res.body.periods.map((x: { seq: number; startDate: string }) => [x.seq, x.startDate])).toEqual([[1, addDays(end, -364)], [2, addDays(end, 1)]]);
    expect(res.body.endDate).toBe(coverageEnd(addDays(end, 1), 12));
    expect(res.body.actions.hasFuturePeriod).toBe(true);
  });

  it("on E and on E+1 it is still a renewal; the start may be set to E by hand, not before", async () => {
    for (const offset of [0, -1]) {
      const { policy, vehicle, end } = await expiring(offset);
      const body = (startDate: string) => ({ idempotencyKey: randomUUID(), startDate, coverageDurationId: s.months12, totalAmountCents: 200_000, certificates: [{ vehicleId: vehicle, certificateNumber: cert() }] });
      expect((await t.call("POST", `/api/policies/${policy.id}/renew`, { token: manager, body: body(addDays(end, -1)) })).body.code).toBe("START_BEFORE_PREVIOUS_END");
      expect((await t.call("POST", `/api/policies/${policy.id}/renew`, { token: manager, body: body(addDays(end, 2)) })).body.code).toBe("START_TOO_LATE");
      const ok = await t.call("POST", `/api/policies/${policy.id}/renew`, { token: manager, body: body(end) });
      expect(ok.status, `E${offset}`).toBe(200);
      expect(ok.body.periods[1].startDate).toBe(end);
    }
  });

  it("from E+2 the same number is refused: a policy change with a new number, both linked", async () => {
    const { policy, vehicle, end } = await expiring(-2);
    expect((await getPolicy(t, manager, policy.id)).actions.renewalMode).toBe("policy_change");
    const renew = await t.call("POST", `/api/policies/${policy.id}/renew`, {
      token: manager,
      body: { idempotencyKey: randomUUID(), coverageDurationId: s.months12, totalAmountCents: 1, certificates: [{ vehicleId: vehicle, certificateNumber: cert() }] },
    });
    expect(renew.body.code).toBe("RENEWAL_TOO_LATE");
    const change = await t.call("POST", `/api/policies/${policy.id}/change`, {
      token: manager,
      body: { idempotencyKey: randomUUID(), insuranceTypeId: s.autoType, policyNumber: `${policy.policyNumber}-N`, coverageDurationId: s.months12, totalAmountCents: 270_000, certificates: [{ vehicleId: vehicle, certificateNumber: cert() }] },
    });
    expect(change.status).toBe(200);
    expect(change.body).toMatchObject({ startDate: today(), replaces: { id: policy.id, policyNumber: policy.policyNumber }, validity: "active" });
    const old = await getPolicy(t, manager, policy.id);
    expect(old.replacedBy?.id).toBe(change.body.id);
    expect(old.validity).toBe("expired");
    expect(end < today()).toBe(true);
    const twice = await t.call("POST", `/api/policies/${policy.id}/change`, {
      token: manager,
      body: { idempotencyKey: randomUUID(), insuranceTypeId: s.autoType, policyNumber: "OTHER", coverageDurationId: s.months12, totalAmountCents: 1, certificates: [{ vehicleId: vehicle, certificateNumber: cert() }] },
    });
    expect(twice.body.code).toBe("ALREADY_REPLACED");
  });

  it("a policy change before E+2 is refused (it is still a renewal)", async () => {
    const { policy, vehicle } = await expiring(-1);
    const res = await t.call("POST", `/api/policies/${policy.id}/change`, {
      token: manager,
      body: { idempotencyKey: randomUUID(), insuranceTypeId: s.autoType, policyNumber: "EARLY", coverageDurationId: s.months12, totalAmountCents: 1, certificates: [{ vehicleId: vehicle, certificateNumber: cert() }] },
    });
    expect(res.body.code).toBe("POLICY_CHANGE_TOO_EARLY");
  });

  it("a renewal needs a new certificate for every vehicle", async () => {
    const { policy, vehicle } = await expiring(3);
    const old = policy.vehicles[0]?.certificateNumber as string;
    const reuse = await t.call("POST", `/api/policies/${policy.id}/renew`, { token: manager, body: { idempotencyKey: randomUUID(), coverageDurationId: s.months12, totalAmountCents: 1000, certificates: [{ vehicleId: vehicle, certificateNumber: old }] } });
    expect(reuse.body.code).toBe("CERTIFICATE_TAKEN");
    const none = await t.call("POST", `/api/policies/${policy.id}/renew`, { token: manager, body: { idempotencyKey: randomUUID(), coverageDurationId: s.months12, totalAmountCents: 1000 } });
    expect(none.body.code).toBe("CERTIFICATE_REQUIRED");
  });

  it("an employee without the permission renews once with an approved edit request", async () => {
    const token = await employee("renewer", ["policies.view"]);
    const { policy, vehicle } = await expiring(2);
    const body = () => ({ idempotencyKey: randomUUID(), coverageDurationId: s.months12, totalAmountCents: 1000, certificates: [{ vehicleId: vehicle, certificateNumber: cert() }] });
    const denied = await t.call("POST", `/api/policies/${policy.id}/renew`, { token, body: body() });
    expect(denied.body).toMatchObject({ code: "FORBIDDEN", requestable: { entityType: "policy", operation: "renew" } });
    const req = await t.call("POST", "/api/edit-requests", { token, body: { entityType: "policy", entityId: policy.id, operation: "renew", note: "العميل حاضر" } });
    await t.call("POST", `/api/edit-requests/${req.body.id}/approve`, { token: manager, body: { reason: "نعم" } });
    expect((await t.call("POST", `/api/policies/${policy.id}/renew`, { token, body: body() })).status).toBe(200);
  });
});

describe("editing a policy (SPEC 11.5)", () => {
  it("free during 48 hours, then the amount is locked except for the manager or an empowered supervisor", async () => {
    const editor = await employee("editor", ["policies.view", "policies.edit"]);
    const sup = await employee("chief", ["policies.view", "sup.policy_edit_after_48h"], true);
    const { policy } = await insuredVehicle();
    const first = await t.call("PATCH", `/api/policies/${policy.id}`, { token: editor, body: { version: policy.version, totalAmountCents: 255_000 } });
    expect(first.body.totalAmountCents).toBe(255_000);

    await setPeriod(t, policy.id, policy.startDate, policy.endDate, 49);
    const p = await getPolicy(t, manager, policy.id);
    expect(p.actions.amountLocked).toBe(true);
    const locked = await t.call("PATCH", `/api/policies/${policy.id}`, { token: editor, body: { version: p.version, totalAmountCents: 1000 } });
    expect(locked.body).toMatchObject({ code: "AMOUNT_LOCKED", requestable: { operation: "edit_amount" } });
    // Other fields stay editable.
    const number = await t.call("PATCH", `/api/policies/${policy.id}`, { token: editor, body: { version: p.version, policyNumber: `${p.policyNumber}-B` } });
    expect(number.body.policyNumber).toBe(`${p.policyNumber}-B`);

    const noReason = await t.call("PATCH", `/api/policies/${policy.id}`, { token: sup, body: { version: number.body.version, totalAmountCents: 240_000 } });
    expect(noReason.body.code).toBe("REASON_REQUIRED");
    const bySup = await t.call("PATCH", `/api/policies/${policy.id}`, { token: sup, body: { version: number.body.version, totalAmountCents: 240_000, reason: "خطأ في الإدخال" } });
    expect(bySup.body.totalAmountCents).toBe(240_000);
    const audit = await ownerQuery(t.db, "SELECT reason FROM audit_log WHERE action = 'policy.update_after_48h' AND entity_id = $1", [policy.id]);
    expect(audit.rows[0]?.reason).toBe("خطأ في الإدخال");
  });

  it("never changes the client or the insurer; a stale version is refused", async () => {
    const { policy } = await insuredVehicle();
    const otherInsurerType = (await t.call("GET", "/api/insurance/catalog", { token: manager })).body.types.find((x: { insurerId: string }) => x.insurerId === s.other).id;
    const res = await t.call("PATCH", `/api/policies/${policy.id}`, { token: manager, body: { version: policy.version, insuranceTypeId: otherInsurerType } });
    expect(res.body.code).toBe("TYPE_CHANGE_NOT_ALLOWED");
    const ignored = await t.call("PATCH", `/api/policies/${policy.id}`, { token: manager, body: { version: policy.version, clientId: randomUUID(), totalAmountCents: 251_000 } });
    expect(ignored.body.clientId).toBe(policy.clientId);
    const stale = await t.call("PATCH", `/api/policies/${policy.id}`, { token: manager, body: { version: policy.version, totalAmountCents: 252_000 } });
    expect(stale.body.code).toBe("VERSION_CONFLICT");
  });
});

describe("vehicle change (SPEC 15)", () => {
  async function change(policyId: string, oldVehicleId: string, newVehicleId: string, oldPrice: number, newPrice: number, certificateNumber = cert()) {
    return t.call("POST", `/api/policies/${policyId}/vehicle-change`, {
      token: manager,
      body: { idempotencyKey: randomUUID(), oldVehicleId, newVehicleId, certificateNumber, oldPriceCents: oldPrice, newPriceCents: newPrice, reason: "باع المركبة" },
    });
  }

  it("previews 317, 17 and -103 (the client receives 103)", async () => {
    const preview = (o: number, n: number) => t.call("POST", "/api/policies/vehicle-change-preview", { token: manager, body: { oldPriceCents: o, newPriceCents: n } });
    expect((await preview(100_000, 130_000)).body).toEqual({ differenceCents: 30_000, feeCents: 1700, netCents: 31_700, direction: "increase" });
    expect((await preview(100_000, 100_000)).body.netCents).toBe(1700);
    expect((await preview(100_000, 88_000)).body).toMatchObject({ netCents: -10_300, direction: "decrease" });
  });

  it("moves the policy to B with a new certificate; A stays in the client file without policy", async () => {
    const { client, vehicle: a, policy } = await insuredVehicle();
    const b = await createVehicle(t, manager, client);
    const res = await change(policy.id, a, b, 100_000, 130_000);
    expect(res.status).toBe(200);
    expect(res.body.policyNumber).toBe(policy.policyNumber);
    expect(res.body.endDate).toBe(policy.endDate);
    expect(res.body.vehicles.map((v: { vehicleId: string }) => v.vehicleId)).toEqual([b]);
    const op = res.body.operations[0];
    expect(op).toMatchObject({ type: "vehicle_change", priceDifferenceCents: 30_000, feeCents: 1700, netCents: 31_700, settlementStatus: "pending", reason: "باع المركبة" });
    expect(op.details).toMatchObject({ oldCertificate: policy.vehicles[0]?.certificateNumber });
    const file = (await t.call("GET", `/api/clients/${client}`, { token: manager })).body;
    expect(file.vehicles.find((v: { id: string }) => v.id === a).activePolicyId).toBeNull();
    expect(file.vehicles.find((v: { id: string }) => v.id === b).activePolicyId).toBe(policy.id);
    // A is free again: it can get a new policy.
    expect((await createPolicy(t, manager, s, client, [a])).status).toBe(201);
  });

  it("refuses a vehicle with an active policy, a used certificate, an expired policy", async () => {
    const one = await insuredVehicle();
    const busy = await createVehicle(t, manager, one.client);
    await mustCreatePolicy(t, manager, s, one.client, [busy]);
    expect((await change(one.policy.id, one.vehicle, busy, 1, 1)).body.code).toBe("VEHICLE_ALREADY_INSURED");
    const free = await createVehicle(t, manager, one.client);
    expect((await change(one.policy.id, one.vehicle, free, 1, 1, one.policy.vehicles[0]?.certificateNumber)).body.code).toBe("CERTIFICATE_TAKEN");
    await setPeriod(t, one.policy.id, addDays(today(), -400), addDays(today(), -1), 24 * 400);
    expect((await change(one.policy.id, one.vehicle, free, 1, 1)).body.code).toBe("POLICY_NOT_ACTIVE");
  });
});

describe("plate change and duplicate (SPEC 16, 16.1)", () => {
  it("plate change: the vehicle keeps its policy, new plate and certificate, 17 MAD waiting", async () => {
    const { vehicle, policy } = await insuredVehicle();
    const res = await t.call("POST", `/api/policies/${policy.id}/plate-change`, {
      token: manager,
      body: { idempotencyKey: randomUUID(), vehicleId: vehicle, plateType: "ma", plate: "77-W-12", certificateNumber: cert(), reason: "ترقيم دائم" },
    });
    expect(res.status).toBe(200);
    expect(res.body.vehicles[0].plate).toBe("77-W-12");
    expect(res.body.operations[0]).toMatchObject({ type: "plate_change", feeCents: 1700, netCents: 1700, settlementStatus: "pending" });
    const v = (await t.call("GET", `/api/vehicles/${vehicle}`, { token: manager })).body;
    expect(v.plateHistory[0]).toMatchObject({ newPlate: "77-W-12" });
    expect(res.body.totalAmountCents).toBe(policy.totalAmountCents);
  });

  it("duplicate: same policy, new certificate number, can be repeated", async () => {
    const { vehicle, policy } = await insuredVehicle();
    let last = policy;
    for (let i = 0; i < 2; i++) {
      const res = await t.call("POST", `/api/policies/${policy.id}/duplicate`, { token: manager, body: { idempotencyKey: randomUUID(), vehicleId: vehicle, certificateNumber: cert(), reason: "ضياع الشهادة" } });
      expect(res.status).toBe(200);
      expect(res.body.vehicles[0].certificateNumber).not.toBe(last.vehicles[0]?.certificateNumber);
      last = res.body;
    }
    expect(last.operations.filter((o) => o.type === "duplicate")).toHaveLength(2);
    expect(last.endDate).toBe(policy.endDate);
  });
});

describe("fleet (SPEC 9.3)", () => {
  it("needs 5 vehicles, refuses to go below 5, one certificate each, one policy number", async () => {
    const c = await createClient(t, manager, { kind: "company", fullName: "Rachid", companyName: "Atlas Logistique", idType: "rc_ice", idNumber: `RC${Date.now()}` });
    const vehicles = [];
    for (let i = 0; i < 6; i++) vehicles.push(await createVehicle(t, manager, c));
    const four = await createPolicy(t, manager, s, c, vehicles.slice(0, 4));
    expect(four.body.code).toBe("FLEET_MIN_VEHICLES");
    const notFleetType = await createPolicy(t, manager, s, c, vehicles.slice(0, 5), { insuranceTypeId: s.autoType });
    expect(notFleetType.body.code).toBe("FLEET_NOT_SUPPORTED");
    const fleet = await mustCreatePolicy(t, manager, s, c, vehicles.slice(0, 5), { fleetName: "شاحنات الشركة" });
    expect(fleet.isFleet).toBe(true);
    expect(new Set(fleet.vehicles.map((v) => v.certificateNumber)).size).toBe(5);

    const remove = (vehicleId: string) => t.call("POST", `/api/policies/${fleet.id}/fleet/remove`, { token: manager, body: { idempotencyKey: randomUUID(), vehicleId, reason: "بيعت" } });
    expect((await remove(vehicles[0] as string)).body.code).toBe("FLEET_MIN_VEHICLES");
    const added = await t.call("POST", `/api/policies/${fleet.id}/fleet/add`, { token: manager, body: { idempotencyKey: randomUUID(), vehicleId: vehicles[5], certificateNumber: cert(), reason: "شاحنة جديدة" } });
    expect(added.body.vehicles).toHaveLength(6);
    expect(added.body.operations[0]).toMatchObject({ type: "fleet_add_vehicle", netCents: null, settlementStatus: "none" });
    const removed = await remove(vehicles[0] as string);
    expect(removed.body.vehicles).toHaveLength(5);
    expect(removed.body.policyNumber).toBe(fleet.policyNumber);
  });
});

describe("annulment and cancellation (SPEC 13, structure)", () => {
  it("annulment during the first 15 days only; an annulled policy cannot be renewed", async () => {
    const recent = await insuredVehicle();
    await setPeriod(t, recent.policy.id, addDays(today(), -14), coverageEnd(addDays(today(), -14), 12), 24 * 14);
    const ok = await t.call("POST", `/api/policies/${recent.policy.id}/annul`, { token: manager, body: { idempotencyKey: randomUUID(), reason: "طلب العميل" } });
    expect(ok.body.validity).toBe("annulled");
    expect(ok.body.actions.renewalMode).toBe("none");
    const renew = await t.call("POST", `/api/policies/${recent.policy.id}/renew`, { token: manager, body: { idempotencyKey: randomUUID(), coverageDurationId: s.months12, totalAmountCents: 1, certificates: [{ vehicleId: recent.vehicle, certificateNumber: cert() }] } });
    expect(renew.body.code).toBe("POLICY_CLOSED");
    // The vehicle is free again; the annulled policy stays in the records.
    expect((await createPolicy(t, manager, s, recent.client, [recent.vehicle])).status).toBe(201);
    expect((await getPolicy(t, manager, recent.policy.id)).operations[0]?.type).toBe("annulment");

    const old = await insuredVehicle();
    await setPeriod(t, old.policy.id, addDays(today(), -15), coverageEnd(addDays(today(), -15), 12), 24 * 15);
    const late = await t.call("POST", `/api/policies/${old.policy.id}/annul`, { token: manager, body: { idempotencyKey: randomUUID(), reason: "متأخر" } });
    expect(late.body.code).toBe("ANNULMENT_PERIOD_OVER");
  });

  it("cancellation is for the manager, with a refund amount recorded for Phase 3", async () => {
    const emp = await employee("canceller", ["policies.view", "policies.edit"]);
    const { client, vehicle, policy } = await insuredVehicle();
    const body = { idempotencyKey: randomUUID(), reason: "قرار الشركة", refundCents: 50_000 };
    expect((await t.call("POST", `/api/policies/${policy.id}/cancel`, { token: emp, body })).status).toBe(403);
    const tooMuch = await t.call("POST", `/api/policies/${policy.id}/cancel`, { token: manager, body: { ...body, idempotencyKey: randomUUID(), refundCents: 999_999_99 } });
    expect(tooMuch.body.code).toBe("REFUND_TOO_LARGE");
    const res = await t.call("POST", `/api/policies/${policy.id}/cancel`, { token: manager, body });
    expect(res.body.validity).toBe("cancelled");
    expect(res.body.operations[0]).toMatchObject({ type: "cancellation", netCents: -50_000, settlementStatus: "pending" });
    expect((await createPolicy(t, manager, s, client, [vehicle])).status).toBe(201);
    const opAgain = await t.call("POST", `/api/policies/${policy.id}/duplicate`, { token: manager, body: { idempotencyKey: randomUUID(), vehicleId: vehicle, certificateNumber: cert(), reason: "x" } });
    expect(opAgain.body.code).toBe("POLICY_NOT_ACTIVE");
  });

  it("operations cannot be rewritten, only their settlement status changes later", async () => {
    await expect(appQuery(t, "UPDATE policy_operations SET net_cents = 0")).rejects.toThrow(/permission denied/);
    await expect(appQuery(t, "DELETE FROM policies")).rejects.toThrow(/permission denied/);
    await expect(appQuery(t, "DELETE FROM clients")).rejects.toThrow(/permission denied/);
    await appQuery(t, "UPDATE policy_operations SET settlement_status = settlement_status");
  });
});
