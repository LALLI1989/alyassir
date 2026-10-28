import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";
import { createClient, createVehicle, mustCreatePolicy, setupCatalog, type Setup } from "./fixtures";

let t: TestApp;
let manager: string;
let s: Setup;

beforeAll(async () => {
  t = await startApp();
  manager = (await t.login(MANAGER.username, MANAGER.password)).accessToken;
  s = await setupCatalog(t, manager);
});
afterAll(async () => t.close());

async function employee(name: string, permissions: string[]): Promise<{ id: string; token: string }> {
  const id = await createEmployee(t, manager, name);
  const user = (await t.call("GET", `/api/users/${id}`, { token: manager })).body;
  await t.call("PUT", `/api/users/${id}/permissions`, { token: manager, body: { version: user.version, permissions } });
  return { id, token: (await t.login(name, "secret1")).accessToken };
}

describe("clients (SPEC 9.1)", () => {
  it("creates the three kinds of client with their identity document", async () => {
    const person = await t.call("POST", "/api/clients", { token: manager, body: { kind: "individual", fullName: "Fatima-Zahra Bennani", idType: "cin", idNumber: "j 12345", phone: "06 61 22 33 44" } });
    expect(person.status).toBe(201);
    expect(person.body).toMatchObject({ idNumber: "J 12345", phone: "0661223344", residency: null });
    const company = await t.call("POST", "/api/clients", { token: manager, body: { kind: "company", fullName: "Karim Benali", companyName: "Transports Atlas SARL", idType: "rc_ice", idNumber: "001234567000089", phone: "0522445566" } });
    expect(company.body.companyName).toBe("Transports Atlas SARL");
    const foreigner = await t.call("POST", "/api/clients", { token: manager, body: { kind: "foreign", fullName: "Jean Dupont", idType: "passport", idNumber: "19FR12345", residency: "resident", phone: "+33 6 12 34 56 78" } });
    expect(foreigner.body).toMatchObject({ residency: "resident", phone: "+33612345678" });
  });

  it("refuses the same identity twice, even written differently", async () => {
    await createClient(t, manager, { idNumber: "BK 445566" });
    const dup = await t.call("POST", "/api/clients", { token: manager, body: { kind: "individual", fullName: "Other name", idType: "cin", idNumber: "bk445566", phone: "0700000000" } });
    expect(dup).toMatchObject({ status: 409, body: { code: "CLIENT_ID_TAKEN" } });
  });

  it("explains wrong formats field by field", async () => {
    const res = await t.call("POST", "/api/clients", { token: manager, body: { kind: "individual", fullName: "", idType: "cin", idNumber: "ABC12", phone: "12345" } });
    expect(res.status).toBe(400);
    expect(res.body.fields).toMatchObject({ fullName: "required", idNumber: "id_format_cin", phone: "phone_format" });
    const wrongDoc = await t.call("POST", "/api/clients", { token: manager, body: { kind: "company", fullName: "X", idType: "cin", idNumber: "A1", phone: "0611111111" } });
    expect(wrongDoc.body.fields.idType).toBe("id_type_kind");
    const noResidency = await t.call("POST", "/api/clients", { token: manager, body: { kind: "foreign", fullName: "X", idType: "passport", idNumber: "P1234", phone: "0611111111" } });
    expect(noResidency.body.fields.residency).toBe("required");
    // Names in Latin letters only, as on identity documents (owner decision 28/10/2026).
    const arabic = await t.call("POST", "/api/clients", { token: manager, body: { kind: "company", fullName: "سعيد", companyName: "شركة الأطلس", idType: "rc_ice", idNumber: "RC1", phone: "0611111111" } });
    expect(arabic.body.fields).toMatchObject({ fullName: "latin_only", companyName: "latin_only" });
    const user = await t.call("POST", "/api/users", { token: manager, body: { username: "arabicname", displayName: "كريم", password: "secret1" } });
    expect(user.body.fields.displayName).toBe("latin_only");
    const type = await t.call("POST", "/api/insurance/types", { token: manager, body: { insurerId: s.rma, name: "تأمين السيارات", requiresVehicle: true, supportsFleet: false } });
    expect(type.body.fields.name).toBe("latin_only");
  });

  it("finds clients by part of the name, by phone and by identity", async () => {
    await createClient(t, manager, { fullName: "Youssef BENABDELLAH", idNumber: "GH778899", phone: "0677889900" });
    const byName = await t.call("GET", `/api/clients?q=${encodeURIComponent("benabd")}`, { token: manager });
    expect(byName.body.items.map((c: { fullName: string }) => c.fullName)).toContain("Youssef BENABDELLAH");
    const byPhone = await t.call("GET", "/api/clients?q=06%2077%2088%2099%2000", { token: manager });
    expect(byPhone.body.items[0].idNumber).toBe("GH778899");
    const byId = await t.call("GET", "/api/clients?q=gh778899", { token: manager });
    expect(byId.body.total).toBe(1);
    // A % typed by someone is a character, not "everything".
    expect((await t.call("GET", "/api/clients?q=%25", { token: manager })).body.total).toBe(0);
  });

  it("archives instead of deleting, but not while a policy covers the client", async () => {
    const free = await createClient(t, manager);
    const archived = await t.call("POST", `/api/clients/${free}/archive`, { token: manager, body: { version: 1, archived: true } });
    expect(archived.body.archived).toBe(true);
    expect((await t.call("GET", `/api/clients/${free}`, { token: manager })).status).toBe(200);

    const insured = await createClient(t, manager);
    const v = await createVehicle(t, manager, insured);
    await mustCreatePolicy(t, manager, s, insured, [v]);
    const refused = await t.call("POST", `/api/clients/${insured}/archive`, { token: manager, body: { version: 1, archived: true } });
    expect(refused.body.code).toBe("HAS_ACTIVE_POLICY");
  });

  it("checks permissions; an approved edit request allows one edit on that client only", async () => {
    const viewer = await employee("viewer", ["clients.view", "clients.create"]);
    const id = await createClient(t, viewer.token, { fullName: "Hassan" });
    const body = { version: 1, kind: "individual", fullName: "Hassan Amrani", idType: "cin", idNumber: "AB100999", phone: "0612345678" };
    const denied = await t.call("PATCH", `/api/clients/${id}`, { token: viewer.token, body });
    expect(denied).toMatchObject({ status: 403, body: { code: "FORBIDDEN", requestable: { entityType: "client", entityId: id, operation: "edit" } } });

    const request = await t.call("POST", "/api/edit-requests", { token: viewer.token, body: { entityType: "client", entityId: id, operation: "edit", note: "خطأ في الاسم" } });
    await t.call("POST", `/api/edit-requests/${request.body.id}/approve`, { token: manager, body: { reason: "موافق" } });
    const ok = await t.call("PATCH", `/api/clients/${id}`, { token: viewer.token, body: { ...body, idNumber: (await t.call("GET", `/api/clients/${id}`, { token: manager })).body.client.idNumber } });
    expect(ok.body.fullName).toBe("Hassan Amrani");
    expect((await t.call("GET", `/api/edit-requests/${request.body.id}`, { token: viewer.token })).body.status).toBe("used");
    const again = await t.call("PATCH", `/api/clients/${id}`, { token: viewer.token, body: { ...body, version: 2, fullName: "Again" } });
    expect(again.status).toBe(403);

    const none = await employee("nobody", []);
    expect((await t.call("GET", "/api/clients", { token: none.token })).status).toBe(403);
  });

  it("hides vehicles and policies from a user who may only see clients", async () => {
    const viewer = await employee("onlyclients", ["clients.view"]);
    const c = await createClient(t, manager);
    await createVehicle(t, manager, c);
    const file = await t.call("GET", `/api/clients/${c}`, { token: viewer.token });
    expect(file.body.vehicles).toEqual([]);
    expect(file.body.policies).toEqual([]);
  });
});

describe("vehicles (SPEC 9.2)", () => {
  it("accepts the four plate types and shows them in their usual form", async () => {
    const c = await createClient(t, manager);
    const plates: [string, string, string][] = [["ma", "12 a 34567", "12-A-34567"], ["ww", "ww 123456", "WW123456"], ["state", "m223355", "M223355"], ["foreign", "ab-123-cd", "AB-123-CD"]];
    for (const [plateType, plate, shown] of plates) {
      const res = await t.call("POST", "/api/vehicles", { token: manager, body: { clientId: c, plateType, plate, fiscalPower: 7, fuel: "petrol", brand: "Renault" } });
      expect(res.body.plate, plateType).toBe(shown);
    }
    const wrong = await t.call("POST", "/api/vehicles", { token: manager, body: { clientId: c, plateType: "ma", plate: "123-AB-4", fiscalPower: 7, fuel: "petrol", brand: "Renault" } });
    expect(wrong.body.fields.plate).toBe("plate_format_ma");
  });

  it("never allows two vehicles with the same plate, whatever the type or the dashes", async () => {
    const c = await createClient(t, manager);
    await createVehicle(t, manager, c, { plateType: "ma", plate: "45-B-1234" });
    const dup = await t.call("POST", "/api/vehicles", { token: manager, body: { clientId: c, plateType: "foreign", plate: "45B1234", fiscalPower: 5, fuel: "diesel", brand: "Fiat" } });
    expect(dup).toMatchObject({ status: 409, body: { code: "PLATE_TAKEN" } });
  });

  it("keeps the old plate when it is corrected; an insured vehicle needs the plate change operation", async () => {
    const c = await createClient(t, manager);
    const v = await createVehicle(t, manager, c, { plateType: "ww", plate: "WW777001" });
    const fixed = await t.call("PATCH", `/api/vehicles/${v}`, { token: manager, body: { version: 1, plateType: "ma", plate: "8-A-777", fiscalPower: 6, fuel: "diesel", brand: "Dacia", reason: "رقم دائم" } });
    expect(fixed.body.plate).toBe("8-A-777");
    expect(fixed.body.plateHistory[0]).toMatchObject({ plate: "WW777001", newPlate: "8-A-777", reason: "رقم دائم" });

    await mustCreatePolicy(t, manager, s, c, [v]);
    const refused = await t.call("PATCH", `/api/vehicles/${v}`, { token: manager, body: { version: 2, plateType: "ma", plate: "8-A-778", fiscalPower: 6, fuel: "diesel", brand: "Dacia" } });
    expect(refused.body.code).toBe("PLATE_CHANGE_NEEDS_OPERATION");
    const otherField = await t.call("PATCH", `/api/vehicles/${v}`, { token: manager, body: { version: 2, plateType: "ma", plate: "8-a-777", fiscalPower: 8, fuel: "diesel", brand: "Dacia" } });
    expect(otherField.body.fiscalPower).toBe(8);
  });

  it("plate history cannot be changed or deleted, even by the database owner", async () => {
    await expect(ownerQuery(t.db, "UPDATE vehicle_plate_history SET old_plate = 'X'")).rejects.toThrow(/append-only/);
    await expect(ownerQuery(t.db, "DELETE FROM vehicle_plate_history")).rejects.toThrow(/append-only/);
  });
});

describe("insurance settings (SPEC 10, manager only)", () => {
  it("starts with RMA and the durations 1, 3, 6, 12 months", async () => {
    const c = (await t.call("GET", "/api/insurance/catalog", { token: manager })).body;
    expect(c.insurers.map((i: { name: string }) => i.name)).toContain("RMA");
    expect(c.durations.map((d: { months: number }) => d.months)).toEqual([1, 3, 6, 12]);
    expect(c.certificateFeeCents).toBe(1700);
    expect(c.operationTypes.filter((o: { isSystem: boolean }) => o.isSystem)).toHaveLength(10);
  });

  it("lets only the manager add insurers, types and durations", async () => {
    const emp = await employee("settingsemp", ["policies.view", "policies.create", "policies.edit"]);
    expect((await t.call("POST", "/api/insurance/insurers", { token: emp.token, body: { name: "AXA" } })).status).toBe(403);
    expect((await t.call("POST", "/api/insurance/durations", { token: emp.token, body: { months: 2 } })).status).toBe(403);
    const added = await t.call("POST", "/api/insurance/durations", { token: manager, body: { months: 2 } });
    expect(added.body.durations.map((d: { months: number }) => d.months)).toEqual([1, 2, 3, 6, 12]);
    expect((await t.call("POST", "/api/insurance/durations", { token: manager, body: { months: 2 } })).body.code).toBe("DURATION_EXISTS");
    expect((await t.call("POST", "/api/insurance/insurers", { token: manager, body: { name: "rma" } })).body.code).toBe("INSURER_NAME_TAKEN");
    const badType = await t.call("POST", "/api/insurance/types", { token: manager, body: { insurerId: s.rma, name: "Xyz", requiresVehicle: false, supportsFleet: true } });
    expect(badType.body.fields.supportsFleet).toBe("fleet_needs_vehicle");
  });

  it("an archived type cannot be used for a new policy", async () => {
    const c = (await t.call("GET", "/api/insurance/catalog", { token: manager })).body;
    const type = c.types.find((x: { id: string }) => x.id === s.homeType);
    await t.call("POST", `/api/insurance/types/${s.homeType}/archive`, { token: manager, body: { version: type.version, archived: true } });
    const client = await createClient(t, manager);
    const res = await t.call("POST", "/api/policies", {
      token: manager,
      body: { idempotencyKey: crypto.randomUUID(), clientId: client, insuranceTypeId: s.homeType, policyNumber: "H-1", coverageDurationId: s.months12, totalAmountCents: 50_000 },
    });
    expect(res.body.code).toBe("ARCHIVED");
    await t.call("POST", `/api/insurance/types/${s.homeType}/archive`, { token: manager, body: { version: type.version + 1, archived: false } });
  });
});
