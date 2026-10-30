/**
 * Phase 8B in a real browser (runs last, after going live): a policy renewed on paper in time but
 * entered late, renewed by the manager on its real date with a reason. Takes the screenshot 29-.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ar as Texts } from "@alyassir/i18n";

const load = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../../packages/i18n/src/${lang}.json`, import.meta.url), "utf8")) as typeof Texts;
const ar = load("ar");
const OUT = new URL("../screenshots/", import.meta.url).pathname;
const API = "http://127.0.0.1:4199";

test.use({ viewport: { width: 1280, height: 900 } });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel(ar.login.username).fill("manager");
  await page.getByLabel(ar.login.password).fill("manager-pass");
  await page.getByRole("button", { name: ar.login.submit }).click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

test("late renewal: the manager renews on the real date (E+1) with a reason", async ({ page, request }) => {
  const base = { "x-alyassir-client-version": "0.1.0" };
  const token = (await (await request.post(`${API}/api/auth/login`, { data: { username: "manager", password: "manager-pass" }, headers: base })).json()).accessToken as string;
  const auth = { ...base, authorization: `Bearer ${token}` };
  const catalog = await (await request.get(`${API}/api/insurance/catalog`, { headers: auth })).json();
  const type = catalog.types.find((x: { name: string }) => x.name === "Assurance moto").id as string;
  const month = catalog.durations.find((d: { months: number }) => d.months === 1).id as string;
  const client = await (await request.post(`${API}/api/clients`, { headers: auth, data: { kind: "individual", fullName: "Omar LATE", idType: "cin", idNumber: "OL445566", phone: "0660000077" } })).json();
  const vehicle = await (await request.post(`${API}/api/vehicles`, { headers: auth, data: { clientId: client.id, plateType: "ww", plate: "WW445566", fiscalPower: 5, fuel: "petrol", brand: "Yamaha" } })).json();
  const late = { ...auth, "x-alyassir-as-of": "2026-06-15", "x-alyassir-late-reason": encodeURIComponent("Classeur papier") };
  const created = await request.post(`${API}/api/policies`, {
    headers: late,
    data: { idempotencyKey: crypto.randomUUID(), clientId: client.id, insuranceTypeId: type, policyNumber: "POL-LATE-001", coverageDurationId: month, totalAmountCents: 80_000, isFleet: false, vehicles: [{ vehicleId: vehicle.id, certificateNumber: "ATT-LATE-001" }] },
  });
  expect(created.status()).toBe(201);

  await signIn(page);
  await page.getByRole("button", { name: ar.modules.policies, exact: true }).click();
  await page.getByLabel(ar.common.search).fill("POL-LATE-001");
  await page.getByRole("row", { name: /POL-LATE-001/ }).getByRole("button", { name: ar.common.open }).click();
  await page.getByRole("button", { name: ar.policies.lateRenew }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: ar.common.confirm })).toBeDisabled();
  await dialog.getByLabel(ar.policies.lateRenewDay).fill("2026-07-15");
  await dialog.getByLabel(ar.historical.lateReason).fill("Renouvelée sur papier");
  await dialog.getByLabel("WW445566").fill("ATT-LATE-002");
  await page.screenshot({ path: `${OUT}29-late-renewal.png` });
  await dialog.getByRole("button", { name: ar.common.confirm }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("cell", { name: new RegExp(ar.policies.periodOps.renewal) }).first()).toBeVisible();
  await expect(page.getByText("15/07/2026").first()).toBeVisible();
});
