// Demo server for the owner to explore the app in a browser (GitHub Codespaces). Never used in an
// agency. Plain HTTP on 127.0.0.1:4300; data kept between restarts; sample data added the first time.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { APP_ROLE, migrate } = require("@alyassir/db");
const { createApp } = require("../dist/app.js");
const { bootstrapData, hasManager } = require("../dist/setup/common.js");

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) throw new Error("DATABASE_URL (superuser) is required");
const PORT = Number(process.env.DEMO_PORT ?? 4300);
const DB = "alyassir_demo";
const OWNER = "alyassir_demo_owner";
const url = (user, password) => {
  const u = new URL(ADMIN);
  u.username = user;
  u.password = password;
  u.pathname = `/${DB}`;
  return u.toString();
};

const admin = new Client({ connectionString: ADMIN });
await admin.connect();
for (const [role, pw] of [[OWNER, "demo-owner"], [APP_ROLE, "demo-app"]]) {
  const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  await admin.query(`${exists.rowCount ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD '${pw}'`);
}
const create = () => admin.query(`CREATE DATABASE ${DB} OWNER ${OWNER} TEMPLATE template0 ENCODING 'UTF8'`);
const dbExists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB]);
if (!dbExists.rowCount) await create();

const ownerUrl = url(OWNER, "demo-owner");
try {
  await migrate(ownerUrl);
} catch (error) {
  // Demo only: the tables changed during development, so start again with fresh sample data.
  console.log(`demo database reset: ${error instanceof Error ? error.message : String(error)}`);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await create();
  await migrate(ownerUrl);
}
await admin.end();
const fresh = !(await hasManager(ownerUrl));
// Phase 3 samples are added once, also to a demo started before Phase 3.
const owner = new Client({ connectionString: ownerUrl });
await owner.connect();
const hasPlans = Number((await owner.query("SELECT count(*)::int AS n FROM installment_plans")).rows[0].n) > 0;
await owner.end();
if (fresh) {
  await bootstrapData(ownerUrl, { agencyName: "وكالة اليسير للتأمين", managerUsername: "gerant", managerPassword: "gerant123", language: "ar", backupDir: "/tmp" });
}

const app = await createApp({
  host: "127.0.0.1",
  port: PORT,
  databaseUrl: url(APP_ROLE, "demo-app"),
  jwtSecret: "demo-secret-demo-secret-demo-secret-0123456789",
  tls: null,
  loginRateLimitPerMinute: 200,
});
await app.listen(PORT, "127.0.0.1");
console.log(`demo server ready on http://127.0.0.1:${PORT}`);

const base = `http://127.0.0.1:${PORT}`;
let token = "";

if (fresh) await seed();
if (!hasPlans) {
  // Demo only: a sample that cannot be added must not stop the demo.
  await seedPayments().catch((error) => console.log(`payment samples skipped: ${error instanceof Error ? error.message : String(error)}`));
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-alyassir-client-version": "0.1.0", "x-alyassir-device": "DEMO", "x-alyassir-user-active": "1", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// Sample data through the real API, so it follows every rule.
async function seed() {
  token = (await call("POST", "/api/auth/login", { username: "gerant", password: "gerant123" })).accessToken;
  let c = await call("GET", "/api/insurance/catalog");
  const rma = c.insurers.find((i) => i.name === "RMA").id;
  await call("POST", "/api/insurance/types", { insurerId: rma, name: "Assurance automobile", requiresVehicle: true, supportsFleet: false });
  await call("POST", "/api/insurance/types", { insurerId: rma, name: "Assurance flotte", requiresVehicle: true, supportsFleet: true });
  c = await call("POST", "/api/insurance/types", { insurerId: rma, name: "Assurance habitation", requiresVehicle: false, supportsFleet: false });
  const auto = c.types.find((x) => x.name === "Assurance automobile").id;
  const months12 = c.durations.find((d) => d.months === 12).id;

  const employee = await call("POST", "/api/users", { username: "salma", displayName: "Salma", password: "salma123" });
  await call("PUT", `/api/users/${employee.id}/permissions`, { version: employee.version, permissions: ["clients.view", "clients.create", "vehicles.view", "vehicles.create", "policies.view", "policies.create"] });

  const people = [
    { fullName: "Said EL IDRISSI", idNumber: "AB123456", phone: "0661234567", plate: "12-A-34567", brand: "Dacia Logan" },
    { fullName: "Fatima-Zahra BENNANI", idNumber: "BK778899", phone: "0677889900", plate: "WW445566", brand: "Renault Clio" },
    { fullName: "Youssef ALAOUI", idNumber: "J12345", phone: "0522334455", plate: "7-B-1234", brand: "Peugeot 208" },
  ];
  let n = 1;
  for (const p of people) {
    const client = await call("POST", "/api/clients", { kind: "individual", fullName: p.fullName, idType: "cin", idNumber: p.idNumber, phone: p.phone });
    const plateType = p.plate.startsWith("WW") ? "ww" : "ma";
    const vehicle = await call("POST", "/api/vehicles", { clientId: client.id, plateType, plate: p.plate, fiscalPower: 6, fuel: "diesel", brand: p.brand });
    if (n < 3) {
      await call("POST", "/api/policies", {
        idempotencyKey: crypto.randomUUID(), clientId: client.id, insuranceTypeId: auto, policyNumber: `POL-2026-00${n}`,
        coverageDurationId: months12, totalAmountCents: 250000 + n * 10000, vehicles: [{ vehicleId: vehicle.id, certificateNumber: `ATT-2026-00${n}` }],
      });
    }
    await call("POST", "/api/vehicles", { clientId: client.id, plateType: "ww", plate: `WW90000${n}`, fiscalPower: 5, fuel: "petrol", brand: "Kia Picanto" });
    n++;
  }
  console.log("sample data added");
}

// Phase 3: a policy in 3 instalments, a cash payment, a cheque waiting for the manager.
async function seedPayments() {
  token = (await call("POST", "/api/auth/login", { username: "gerant", password: "gerant123" })).accessToken;
  const c = await call("GET", "/api/insurance/catalog");
  const auto = c.types.find((x) => x.name === "Assurance automobile")?.id;
  const months12 = c.durations.find((d) => d.months === 12)?.id;
  const users = await call("GET", "/api/users");
  const salma = (users.items ?? users).find((u) => u.username === "salma");
  if (salma) {
    await call("PUT", `/api/users/${salma.id}/permissions`, {
      version: salma.version,
      permissions: ["clients.view", "clients.create", "vehicles.view", "vehicles.create", "policies.view", "policies.create", "payments.view", "payments.create", "debts.view"],
    });
  }
  const youssef = (await call("GET", "/api/clients?q=Youssef")).items[0];
  if (youssef && auto && months12) {
    const file = await call("GET", `/api/clients/${youssef.id}`);
    const vehicle = file.vehicles.find((v) => !v.activePolicyId && !v.archived);
    if (vehicle) {
      await call("POST", "/api/policies", {
        idempotencyKey: crypto.randomUUID(), clientId: youssef.id, insuranceTypeId: auto, policyNumber: "POL-2026-003",
        coverageDurationId: months12, totalAmountCents: 300000, vehicles: [{ vehicleId: vehicle.id, certificateNumber: "ATT-2026-003" }],
        finance: { instalments: { count: 3, dates: [] }, payments: [{ method: "cash", amountCents: 50000 }] },
      });
    }
  }
  const policies = (await call("GET", "/api/policies?pageSize=50")).items;
  const p1 = policies.find((p) => p.policyNumber === "POL-2026-001");
  const p2 = policies.find((p) => p.policyNumber === "POL-2026-002");
  if (p1) await call("POST", `/api/policies/${p1.id}/payments`, { idempotencyKey: crypto.randomUUID(), method: "cash", amountCents: 100000 });
  if (p2) {
    const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await call("POST", `/api/policies/${p2.id}/payments`, {
      idempotencyKey: crypto.randomUUID(), method: "cheque", amountCents: 150000,
      cheque: { number: "1234567", bank: "Attijariwafa bank", drawerName: "Fatima-Zahra BENNANI", dueDate: due },
    });
  }
  console.log("payment samples added");
}
