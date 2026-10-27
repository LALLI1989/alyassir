/** Helpers that build clients, vehicles and policies through the real API (Phase 2 tests). */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { InsuranceCatalogDto, PolicyDto } from "@alyassir/shared";
import { ownerQuery, type TestApp } from "./harness";

let counter = 0;
export const next = () => ++counter;

export async function catalog(t: TestApp, token: string): Promise<InsuranceCatalogDto> {
  return (await t.call("GET", "/api/insurance/catalog", { token })).body as InsuranceCatalogDto;
}

export interface Setup {
  rma: string;
  other: string;
  autoType: string;
  fleetType: string;
  homeType: string;
  months12: string;
  months1: string;
}

/** RMA (seeded) + a second insurer, three types and the default durations. */
export async function setupCatalog(t: TestApp, managerToken: string): Promise<Setup> {
  let c = await catalog(t, managerToken);
  const rma = c.insurers.find((i) => i.name === "RMA")?.id as string;
  c = (await t.call("POST", "/api/insurance/insurers", { token: managerToken, body: { name: "Wafa Assurance" } })).body;
  const other = c.insurers.find((i) => i.name === "Wafa Assurance")?.id as string;
  for (const body of [
    { insurerId: rma, nameAr: "تأمين السيارات", nameFr: "Assurance automobile", requiresVehicle: true, supportsFleet: false },
    { insurerId: rma, nameAr: "تأمين الأسطول", nameFr: "Assurance flotte", requiresVehicle: true, supportsFleet: true },
    { insurerId: rma, nameAr: "تأمين المسكن", nameFr: "Assurance habitation", requiresVehicle: false, supportsFleet: false },
    { insurerId: other, nameAr: "تأمين السيارات", nameFr: "Assurance automobile", requiresVehicle: true, supportsFleet: false },
  ]) {
    const res = await t.call("POST", "/api/insurance/types", { token: managerToken, body });
    if (res.status !== 201) throw new Error(`type: ${res.status} ${JSON.stringify(res.body)}`);
    c = res.body;
  }
  const typeOf = (insurer: string, fr: string) => c.types.find((x) => x.insurerId === insurer && x.nameFr === fr)?.id as string;
  return {
    rma,
    other,
    autoType: typeOf(rma, "Assurance automobile"),
    fleetType: typeOf(rma, "Assurance flotte"),
    homeType: typeOf(rma, "Assurance habitation"),
    months12: c.durations.find((d) => d.months === 12)?.id as string,
    months1: c.durations.find((d) => d.months === 1)?.id as string,
  };
}

export async function createClient(t: TestApp, token: string, over: Record<string, unknown> = {}): Promise<string> {
  const n = next();
  const res = await t.call("POST", "/api/clients", {
    token,
    body: { kind: "individual", fullName: `محمد العلوي ${n}`, idType: "cin", idNumber: `AB${100000 + n}`, phone: "0612345678", ...over },
  });
  if (res.status !== 201) throw new Error(`client: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

export async function createVehicle(t: TestApp, token: string, clientId: string, over: Record<string, unknown> = {}): Promise<string> {
  const n = next();
  const res = await t.call("POST", "/api/vehicles", {
    token,
    body: { clientId, plateType: "ww", plate: `WW${500000 + n}`, fiscalPower: 6, fuel: "diesel", brand: "Dacia", ...over },
  });
  if (res.status !== 201) throw new Error(`vehicle: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

export function cert(): string {
  return `ATT-${next()}-${randomUUID().slice(0, 4)}`;
}

export async function createPolicy(
  t: TestApp,
  token: string,
  s: Setup,
  clientId: string,
  vehicleIds: string[],
  over: Record<string, unknown> = {},
): Promise<{ status: number; body: PolicyDto & { code?: string } }> {
  return t.call("POST", "/api/policies", {
    token,
    body: {
      idempotencyKey: randomUUID(),
      clientId,
      insuranceTypeId: vehicleIds.length > 1 ? s.fleetType : s.autoType,
      policyNumber: `POL-${next()}`,
      coverageDurationId: s.months12,
      totalAmountCents: 250_000,
      isFleet: vehicleIds.length > 1,
      vehicles: vehicleIds.map((vehicleId) => ({ vehicleId, certificateNumber: cert() })),
      ...over,
    },
  });
}

export async function mustCreatePolicy(t: TestApp, token: string, s: Setup, clientId: string, vehicleIds: string[], over: Record<string, unknown> = {}): Promise<PolicyDto> {
  const res = await createPolicy(t, token, s, clientId, vehicleIds, over);
  if (res.status !== 201) throw new Error(`policy: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Moves the latest period of a policy in time (as if it had been created earlier). */
export async function setPeriod(t: TestApp, policyId: string, startDate: string, endDate: string, createdHoursAgo = 0): Promise<void> {
  await ownerQuery(
    t.db,
    `UPDATE policy_periods SET start_date = $2, end_date = $3, created_at = now() - make_interval(hours => $4)
     WHERE id = (SELECT id FROM policy_periods WHERE policy_id = $1 ORDER BY seq DESC LIMIT 1)`,
    [policyId, startDate, endDate, createdHoursAgo],
  );
  await ownerQuery(t.db, "UPDATE period_vehicles SET from_date = $2 WHERE period_id = (SELECT id FROM policy_periods WHERE policy_id = $1 ORDER BY seq DESC LIMIT 1)", [policyId, startDate]);
}

export async function getPolicy(t: TestApp, token: string, id: string): Promise<PolicyDto> {
  return (await t.call("GET", `/api/policies/${id}`, { token })).body as PolicyDto;
}

/** Runs SQL as the application role (the rights the running server has). */
export async function appQuery(t: TestApp, text: string): Promise<void> {
  const c = new Client({ connectionString: t.db.appUrl });
  await c.connect();
  try {
    await c.query(text);
  } finally {
    await c.end();
  }
}
