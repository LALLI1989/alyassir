/**
 * Phase 5 on a real PostgreSQL: claims (cover, 5 days to declare, statuses), contact log, WhatsApp
 * links, reminders by permission.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, businessDay } from "@alyassir/domain";
import { formatCents, type ClaimDto, type ContactDto, type RemindersDto } from "@alyassir/shared";
import { MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";
import { createClient, createVehicle, mustCreatePolicy, setPeriod, setupCatalog, type Setup } from "./fixtures";

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

async function employee(name: string, permissions: string[]): Promise<string> {
  const id = await createEmployee(t, manager, name);
  const user = (await t.call("GET", `/api/users/${id}`, { token: manager })).body;
  await t.call("PUT", `/api/users/${id}/permissions`, { token: manager, body: { version: user.version, permissions } });
  return (await t.login(name, "secret1")).accessToken;
}

async function insured(over: Record<string, unknown> = {}) {
  const client = await createClient(t, manager, { phone: "0661234567" });
  const vehicle = await createVehicle(t, manager, client, { plateType: "ma", plate: `${String(Math.floor(Math.random() * 90000) + 10000)}-A-01` });
  const policy = await mustCreatePolicy(t, manager, s, client, [vehicle], over);
  return { client, vehicle, policy };
}

const claim = (policyId: string, accidentDate: string, token = manager, extra: Record<string, unknown> = {}) =>
  t.call("POST", "/api/claims", { token, body: { policyId, accidentDate, place: "Casablanca", description: "Choc arrière", requestedCents: 500_000, ...extra } });

describe("claims: cover and 5 days to declare (owner decisions 28/10/2026)", () => {
  it("an accident on the last day of cover is accepted up to 4 days later; on the 5th day it is late", async () => {
    const { policy } = await insured();
    // The cover ended 4 days ago: an accident that day is still in time.
    await setPeriod(t, policy.id, addDays(today(), -369), addDays(today(), -4));
    const ok = await claim(policy.id, addDays(today(), -4));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: "declared", declaredOn: today(), requestedCents: 500_000, lateReason: null });

    const { policy: p2 } = await insured();
    await setPeriod(t, p2.id, addDays(today(), -370), addDays(today(), -5));
    expect((await claim(p2.id, addDays(today(), -5))).body.code).toBe("CLAIM_LATE_DECLARATION");
    // An employee cannot record it late, even with a reason; the manager can, with one.
    const emp = await employee("claimer", ["claims.view", "claims.create", "claims.edit"]);
    expect((await claim(p2.id, addDays(today(), -5), emp, { lateReason: "Client hospitalisé" })).body.code).toBe("CLAIM_LATE_DECLARATION");
    expect((await claim(p2.id, addDays(today(), -5), manager)).body.code).toBe("CLAIM_LATE_DECLARATION");
    const late = await claim(p2.id, addDays(today(), -5), manager, { lateReason: "Client hospitalisé" });
    expect(late.status).toBe(201);
    expect(late.body.lateReason).toBe("Client hospitalisé");
  });

  it("refused before the start, after the cover, in the future", async () => {
    const { policy } = await insured();
    await setPeriod(t, policy.id, addDays(today(), -10), addDays(today(), 355));
    expect((await claim(policy.id, addDays(today(), -11))).body.code).toBe("CLAIM_BEFORE_START");
    expect((await claim(policy.id, addDays(today(), 1))).body.code).toBe("CLAIM_ACCIDENT_IN_FUTURE");
    const { policy: old } = await insured();
    await setPeriod(t, old.id, addDays(today(), -400), addDays(today(), -40));
    expect((await claim(old.id, addDays(today(), -2))).body.code).toBe("CLAIM_AFTER_COVER");
  });

  it("annulled: never covered; cancelled: covered up to the cancellation day", async () => {
    const { policy } = await insured();
    await ownerQuery(t.db, "UPDATE policy_periods SET validity_status = 'annulled', status_changed_at = now() WHERE policy_id = $1", [policy.id]);
    expect((await claim(policy.id, today())).body.code).toBe("CLAIM_POLICY_ANNULLED");

    const { policy: c } = await insured();
    await setPeriod(t, c.id, addDays(today(), -100), addDays(today(), 265));
    await ownerQuery(t.db, "UPDATE policy_periods SET validity_status = 'cancelled', status_changed_at = now() - interval '2 days' WHERE policy_id = $1", [c.id]);
    expect((await claim(c.id, addDays(today(), -1))).body.code).toBe("CLAIM_AFTER_COVER");
    expect((await claim(c.id, addDays(today(), -2))).status).toBe(201);
  });

  it("the claim number is unique at the same insurer; statuses; closed comes back only by the manager", async () => {
    const { policy } = await insured();
    const first = await claim(policy.id, today(), manager, { claimNumber: "SIN-2026-01" });
    expect(first.status).toBe(201);
    expect((await claim(policy.id, today(), manager, { claimNumber: "sin-2026-01" })).body.code).toBe("CLAIM_NUMBER_TAKEN");
    const c = first.body as ClaimDto;
    const emp = (await t.login("claimer", "secret1")).accessToken;
    const body = (over: Record<string, unknown>) => ({ version: c.version, claimNumber: "SIN-2026-01", place: c.place, description: c.description, requestedCents: c.requestedCents, compensatedCents: null, notes: "", status: "expertise", ...over });
    let res = await t.call("PATCH", `/api/claims/${c.id}`, { token: emp, body: body({}) });
    expect(res.body.status).toBe("expertise");
    res = await t.call("PATCH", `/api/claims/${c.id}`, { token: emp, body: body({ version: res.body.version, status: "closed", compensatedCents: 420_000 }) });
    expect(res.body).toMatchObject({ status: "closed", compensatedCents: 420_000 });
    const v = res.body.version;
    expect((await t.call("PATCH", `/api/claims/${c.id}`, { token: emp, body: body({ version: v, status: "processing" }) })).body.code).toBe("CLAIM_REOPEN_MANAGER");
    expect((await t.call("PATCH", `/api/claims/${c.id}`, { token: manager, body: body({ version: v, status: "processing" }) })).body.code).toBe("REASON_REQUIRED");
    expect((await t.call("PATCH", `/api/claims/${c.id}`, { token: manager, body: body({ version: v, status: "processing", reason: "Recours" }) })).body.status).toBe("processing");
    // No money moved anywhere.
    expect(Number((await ownerQuery(t.db, "SELECT count(*) AS n FROM financial_transactions")).rows[0]?.n)).toBe(0);
    // Search by number and by status.
    expect((await t.call("GET", "/api/claims?q=sin-2026&status=all", { token: emp })).body.total).toBe(1);
    // No permission, no claims.
    const none = await employee("noclaims", ["clients.view"]);
    expect((await t.call("GET", "/api/claims", { token: none })).status).toBe(403);
  });
});

describe("contact log and WhatsApp (SPEC 18.3, 18.4)", () => {
  it("lines are kept with who and when; a promise needs its date; nothing can be changed", async () => {
    const { client } = await insured();
    const emp = await employee("caller", ["clients.view"]);
    expect((await t.call("POST", "/api/contacts", { token: emp, body: { clientId: client, kind: "promise" } })).body.fields?.promiseDate).toBe("required");
    await t.call("POST", "/api/contacts", { token: emp, body: { clientId: client, kind: "no_answer" } });
    const res = await t.call("POST", "/api/contacts", { token: emp, body: { clientId: client, kind: "promise", promiseDate: today(), note: "Passera vendredi" } });
    expect((res.body as ContactDto[]).map((c) => c.kind)).toEqual(["promise", "no_answer"]);
    expect(res.body[0]).toMatchObject({ createdByName: "CALLER", promiseDate: today(), note: "Passera vendredi" });
    await expect(ownerQuery(t.db, "UPDATE contact_logs SET note = 'x'")).rejects.toThrow(/append-only/);
  });

  it("a wa.me link with the message filled by the server, written in the contact log", async () => {
    const { client, policy } = await insured({ totalAmountCents: 250_000 });
    const res = await t.call("POST", "/api/contacts/whatsapp", { token: manager, body: { clientId: client, policyId: policy.id, template: "payment", language: "fr" } });
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe("212661234567");
    expect(res.body.url).toMatch(/^https:\/\/wa\.me\/212661234567\?text=/);
    expect(res.body.text).toContain(policy.policyNumber);
    expect(res.body.text).toContain(`${formatCents(250_000)} MAD`);
    const ar = await t.call("POST", "/api/contacts/whatsapp", { token: manager, body: { clientId: client, policyId: policy.id, template: "renewal", language: "ar" } });
    expect(ar.body.text).toContain(policy.vehicles[0]?.plate);
    expect(ar.body.text).toContain(`${policy.endDate.slice(8, 10)}/${policy.endDate.slice(5, 7)}/${policy.endDate.slice(0, 4)}`);
    const log = (await t.call("GET", `/api/contacts/client/${client}`, { token: manager })).body as ContactDto[];
    expect(log.map((l) => [l.kind, l.templateCode, l.language])).toEqual([["whatsapp", "renewal", "ar"], ["whatsapp", "payment", "fr"]]);
  });

  it("the manager edits the templates; nobody else", async () => {
    const list = (await t.call("GET", "/api/contacts/templates", { token: manager })).body;
    const renewal = list.find((x: { code: string }) => x.code === "renewal");
    const emp = (await t.login("caller", "secret1")).accessToken;
    expect((await t.call("PUT", "/api/contacts/templates/renewal", { token: emp, body: { version: renewal.version, bodyAr: "x", bodyFr: "y" } })).status).toBe(403);
    const res = await t.call("PUT", "/api/contacts/templates/renewal", { token: manager, body: { version: renewal.version, bodyAr: "مرحبا {client}", bodyFr: "Bonjour {client}" } });
    expect(res.body.find((x: { code: string }) => x.code === "renewal").bodyFr).toBe("Bonjour {client}");
  });
});

describe("reminders (SPEC 18.2), by permission", () => {
  it("policies ending soon, instalments due, promises due, stale claims; each to whom may see it", async () => {
    const soon = await insured();
    await setPeriod(t, soon.policy.id, addDays(today(), -355), addDays(today(), 10));
    const inst = await insured({ totalAmountCents: 400_000, finance: { instalments: { count: 2 } } });
    const { policy: claimed } = await insured();
    const cl = (await claim(claimed.id, today())).body as ClaimDto;
    await ownerQuery(t.db, "UPDATE claims SET updated_at = now() - interval '8 days' WHERE id = $1", [cl.id]);

    const r = (await t.call("GET", "/api/reminders", { token: manager })).body as RemindersDto;
    const group = (k: string) => r.groups.find((g) => g.kind === k);
    expect(r.settings).toEqual({ policyDays: 30, instalmentDays: 3, chequeDays: 3, claimDays: 7 });
    expect(group("policy_ending")?.items.some((i) => i.policyId === soon.policy.id && i.template === "renewal" && i.phone === "0661234567")).toBe(true);
    expect(group("instalment_due")?.items.some((i) => i.policyId === inst.policy.id && i.amountCents === 201_700)).toBe(true);
    expect(group("promise_due")?.count).toBeGreaterThanOrEqual(1);
    expect(group("claim_stale")?.items.some((i) => i.policyId === claimed.id)).toBe(true);
    expect(r.total).toBe(r.groups.reduce((n, g) => n + g.count, 0));

    // Someone with clients only: no policies, no instalments, no claims.
    const emp = (await t.login("caller", "secret1")).accessToken;
    const mine = (await t.call("GET", "/api/reminders", { token: emp })).body as RemindersDto;
    expect(mine.groups.map((g) => g.kind).filter((k) => ["policy_ending", "instalment_due", "claim_stale", "debt_open"].includes(k))).toEqual([]);
  });

  it("the manager changes the delays; a policy ending in 10 days leaves the list at 5", async () => {
    const emp = (await t.login("caller", "secret1")).accessToken;
    expect((await t.call("PUT", "/api/reminders/settings", { token: emp, body: { policyDays: 5, instalmentDays: 3, chequeDays: 3, claimDays: 7 } })).status).toBe(403);
    expect((await t.call("PUT", "/api/reminders/settings", { token: manager, body: { policyDays: 5, instalmentDays: 3, chequeDays: 3, claimDays: 7 } })).body.policyDays).toBe(5);
    const r = (await t.call("GET", "/api/reminders", { token: manager })).body as RemindersDto;
    const ending = r.groups.find((g) => g.kind === "policy_ending");
    expect(ending?.items.every((i) => (i.date ?? "") <= addDays(today(), 5)) ?? true).toBe(true);
    await t.call("PUT", "/api/reminders/settings", { token: manager, body: { policyDays: 30, instalmentDays: 3, chequeDays: 3, claimDays: 7 } });
  });
});
