/**
 * Phase 7 in a real browser, on the brand-new test server (runs first): the question "do you have
 * old policies?", the yellow bar with the operation date, a quick entry of an old policy with
 * Ctrl+Enter, the checklist and the button that starts live work. Takes the screenshots 22-, 23-, 24-.
 */
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { ar as Texts } from "@alyassir/i18n";

const load = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../../packages/i18n/src/${lang}.json`, import.meta.url), "utf8")) as typeof Texts;
const ar = load("ar");
const OUT = new URL("../screenshots/", import.meta.url).pathname;
const API = "http://127.0.0.1:4199";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 900 } });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel(ar.login.username).fill("manager");
  await page.getByLabel(ar.login.password).fill("manager-pass");
  await page.getByRole("button", { name: ar.login.submit }).click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

/** The data the quick entry needs (an insurance type, a client and a vehicle), through the API. */
async function prepare(request: APIRequestContext) {
  const headers = { "x-alyassir-client-version": "0.1.0", "x-alyassir-as-of": "2026-05-01" };
  const login = await request.post(`${API}/api/auth/login`, { data: { username: "manager", password: "manager-pass" }, headers });
  const token = (await login.json()).accessToken as string;
  const auth = { ...headers, authorization: `Bearer ${token}` };
  const catalog = await (await request.get(`${API}/api/insurance/catalog`, { headers: auth })).json();
  const rma = catalog.insurers.find((i: { name: string }) => i.name === "RMA").id as string;
  expect((await request.post(`${API}/api/insurance/types`, { headers: auth, data: { insurerId: rma, name: "Assurance moto", requiresVehicle: true, supportsFleet: false } })).ok()).toBe(true);
  const client = await (await request.post(`${API}/api/clients`, { headers: auth, data: { kind: "individual", fullName: "Hamid OLD", idType: "cin", idNumber: "HD123456", phone: "0660000001" } })).json();
  expect((await request.post(`${API}/api/vehicles`, { headers: auth, data: { clientId: client.id, plateType: "ww", plate: "WW778899", fiscalPower: 6, fuel: "petrol", brand: "Peugeot" } })).ok()).toBe(true);
}

test("first start: the manager says there are old policies; the yellow bar appears", async ({ page }) => {
  await signIn(page);
  const first = page.getByTestId("first-start");
  await expect(first).toContainText(ar.historical.question);
  await page.screenshot({ path: `${OUT}22-first-start.png` });
  await first.getByRole("button", { name: ar.historical.yes }).click();
  await expect(page.getByTestId("historical-bar")).toContainText(ar.historical.barManager);
});

test("quick entry of a policy of 01/05/2026, saved with Ctrl+Enter", async ({ page, request }) => {
  await prepare(request);
  await signIn(page);
  await page.getByLabel(ar.historical.operationDay).fill("2026-05-01");
  await expect(page.getByTestId("operation-day")).toHaveText("01/05/2026");
  await page.getByRole("button", { name: ar.shell.quickEntry }).click();
  await page.getByLabel(ar.policies.pickClient).fill("Hamid");
  await page.getByRole("button", { name: /Hamid OLD/ }).click();
  await page.getByLabel(ar.policies.type, { exact: true }).selectOption({ label: "RMA — Assurance moto" });
  await page.getByRole("checkbox", { name: "WW778899" }).check();
  await page.getByLabel(`${ar.policies.certificate} WW778899`).fill("ATT-OLD-001");
  await page.getByLabel(ar.policies.number, { exact: true }).fill("POL-OLD-001");
  await page.getByLabel(ar.policies.amount, { exact: true }).fill("2000");
  await expect(page.getByText("01/05/2026").first()).toBeVisible();
  await page.screenshot({ path: `${OUT}23-quick-entry.png`, fullPage: true });
  await page.getByLabel(ar.policies.number, { exact: true }).press("Control+Enter");
  await expect(page.getByTestId("quick-saved")).toContainText("POL-OLD-001");
  // The form is empty again for the next policy.
  await expect(page.getByLabel(ar.policies.pickClient)).toHaveValue("");
});

test("all old entries are done: checklist, password and sentence, then live work", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.shell.historical }).click();
  await expect(page.getByTestId("balances")).toBeVisible();
  await expect(page.getByText(ar.historical.noNegative)).toBeVisible();
  const form = page.getByTestId("finish-form");
  await form.getByLabel(ar.historical.password).fill("manager-pass");
  await form.getByLabel(ar.historical.phraseLabel.replace("{{phrase}}", ar.historical.phrase)).fill(ar.historical.phrase);
  await page.screenshot({ path: `${OUT}24-finish.png`, fullPage: true });
  await form.getByRole("button", { name: ar.historical.finishButton }).click();
  // The page then shows that live work has started (the success line may already be replaced by it).
  await expect(page.getByText(ar.historical.live.split("{{")[0] as string)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("historical-bar")).toBeHidden();
});
