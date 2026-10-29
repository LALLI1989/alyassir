/**
 * Phase 2 in a real browser: insurance settings, client, vehicles, policy, vehicle change with its
 * confirmation window, renewal, search, French. Runs after app.spec.ts on the same test database.
 * Also takes the screenshots shown to the owner (4-, 5-, 6-).
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ar as Texts } from "@alyassir/i18n";

const load = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../../packages/i18n/src/${lang}.json`, import.meta.url), "utf8")) as typeof Texts;
const ar = load("ar");
const fr = load("fr");
const OUT = new URL("../screenshots/", import.meta.url).pathname;

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 860 } });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel(ar.login.username).fill("manager");
  await page.getByLabel(ar.login.password).fill("manager-pass");
  await page.getByRole("button", { name: ar.login.submit }).click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

async function openClient(page: Page, name: string) {
  await page.getByRole("button", { name: ar.modules.clients, exact: true }).click();
  await page.getByLabel(ar.common.search).fill(name);
  await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: ar.common.open }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function openPolicy(page: Page, number: string) {
  await page.getByRole("button", { name: ar.modules.policies, exact: true }).click();
  await page.getByLabel(ar.common.search).fill(number);
  await page.getByRole("row", { name: new RegExp(number) }).getByRole("button", { name: ar.common.open }).click();
  await expect(page.getByRole("heading", { name: new RegExp(number) })).toBeVisible();
}

test("the manager adds an insurance type for RMA", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.shell.insurance, exact: true }).click();
  await expect(page.getByRole("cell", { name: "RMA", exact: true }).first()).toBeVisible();
  await page.getByLabel(ar.policies.insurer).selectOption({ label: "RMA" });
  await page.getByLabel(ar.insurance.typeName).fill("Assurance automobile");
  await page.getByRole("button", { name: ar.insurance.addType, exact: true }).click();
  await expect(page.getByRole("cell", { name: "Assurance automobile" })).toBeVisible();
});

test("a client: wrong identity refused at once, then created; two vehicles", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.clients, exact: true }).click();
  await page.getByRole("button", { name: ar.clients.add }).click();
  await page.getByLabel(ar.clients.fullName).fill("Said EL IDRISSI");
  await page.getByLabel(ar.clients.idNumber).fill("ABC1");
  await page.getByLabel(ar.clients.phone).fill("0661 23 45 67");
  await page.getByRole("button", { name: ar.common.create }).click();
  await expect(page.getByText(ar.errors.fields.id_format_cin)).toBeVisible();
  await page.getByLabel(ar.clients.idNumber).fill("ab 123456");
  await page.getByRole("button", { name: ar.common.create }).click();
  await expect(page.getByRole("heading", { name: "Said EL IDRISSI" })).toBeVisible();

  // Moroccan plate: wrong shape first.
  await page.getByRole("button", { name: ar.vehicles.add }).click();
  await page.getByLabel(ar.vehicles.plateType).selectOption("ma");
  await page.getByLabel(ar.vehicles.plate).fill("123-AB-4");
  await page.getByLabel(ar.vehicles.fiscalPower).fill("7");
  await page.getByLabel(ar.vehicles.brand).fill("Dacia Logan");
  await page.getByRole("button", { name: ar.common.create }).click();
  await expect(page.getByText(ar.errors.fields.plate_format_ma)).toBeVisible();
  await page.getByLabel(ar.vehicles.plate).fill("00123 b 01");
  await page.getByRole("button", { name: ar.common.create }).click();
  await expect(page.getByRole("cell", { name: /00123-B-01/ })).toBeVisible();

  // WW is the default type.
  await page.getByRole("button", { name: ar.vehicles.add }).click();
  await expect(page.getByLabel(ar.vehicles.plateType)).toHaveValue("ww");
  await page.getByLabel(ar.vehicles.plate).fill("WW 778899");
  await page.getByLabel(ar.vehicles.fiscalPower).fill("6");
  await page.getByLabel(ar.vehicles.brand).fill("Renault Clio");
  await page.getByRole("button", { name: ar.common.create }).click();
  await expect(page.getByRole("cell", { name: /WW778899/ })).toBeVisible();
});

test("a new policy from the client file: number, certificate, amount; end computed by the server", async ({ page }) => {
  await signIn(page);
  await openClient(page, "Said EL IDRISSI");
  await page.getByRole("button", { name: ar.clients.newPolicy }).click();
  await page.getByLabel(ar.policies.type).selectOption({ label: "RMA — Assurance automobile" });
  await page.getByRole("checkbox", { name: "00123-B-01" }).click();
  await page.getByLabel(`${ar.policies.certificate} 00123-B-01`).fill("ATT-2026-0001");
  await page.getByLabel(ar.policies.number).fill("POL-2026-001");
  await page.getByLabel(ar.policies.amount).fill("2500");
  await expect(page.getByText(ar.policies.endComputed.split("{{")[0] ?? "")).toBeVisible();
  await page.screenshot({ path: `${OUT}4-new-policy.png`, fullPage: true });
  await page.getByRole("button", { name: ar.common.create }).click();

  await expect(page.getByRole("heading", { name: /POL-2026-001/ })).toBeVisible();
  await expect(page.getByText(ar.policies.validities.active).first()).toBeVisible();
  await expect(page.getByText("2 500,00").first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "ATT-2026-0001" })).toBeVisible();
});

test("vehicle change: confirmation shows 300 + 17 = 317 before saving", async ({ page }) => {
  await signIn(page);
  // Phase 4: the 317 MAD are paid in cash, so the manager receives the drawer first (empty: 0).
  await page.getByTestId("drawer-badge").click();
  const receive = page.getByTestId("receive-drawer");
  await receive.getByLabel(ar.drawer.counted).fill("0");
  await receive.getByRole("button", { name: ar.drawer.receive }).click();
  await expect(page.getByTestId("drawer-badge")).toContainText(ar.drawer.held);
  await openPolicy(page, "POL-2026-001");
  await page.getByRole("button", { name: ar.policies.vehicleChange }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(ar.policies.newVehicle).selectOption({ label: "WW778899 — Renault Clio" });
  await dialog.getByLabel(ar.policies.newCertificate).fill("ATT-2026-0002");
  await dialog.getByLabel(ar.policies.newPrice).fill("2800");
  await dialog.getByLabel(ar.common.reason).fill("باع المركبة القديمة");
  await dialog.getByRole("button", { name: ar.common.continue }).click();
  const summary = page.getByTestId("confirm-summary");
  await expect(summary).toContainText("300,00");
  await expect(summary).toContainText("17,00");
  await expect(summary).toContainText("317,00");
  await expect(summary).toContainText(ar.policies.clientPays);
  await page.screenshot({ path: `${OUT}6-vehicle-change-confirmation.png` });
  await dialog.getByRole("button", { name: ar.common.confirm }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("cell", { name: "WW778899" })).toBeVisible();
  await expect(page.getByTestId("operations")).toContainText("317,00");
});

test("renewal keeps the same number and adds a second period", async ({ page }) => {
  await signIn(page);
  await openPolicy(page, "POL-2026-001");
  await page.getByRole("button", { name: ar.policies.renew, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("WW778899").fill("ATT-2026-0003");
  await dialog.getByRole("button", { name: ar.common.confirm }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: /POL-2026-001/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: new RegExp(ar.policies.periodOps.renewal) }).first()).toBeVisible();
  // A renewal not started yet: vehicle changes wait for it.
  await expect(page.getByRole("button", { name: ar.policies.vehicleChange })).toHaveCount(0);
  await page.screenshot({ path: `${OUT}5-policy.png`, fullPage: true });
});

test("search by part of the name and by plate; the client file shows everything", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.clients, exact: true }).click();
  await page.getByLabel(ar.common.search).fill("idris");
  await expect(page.getByRole("row", { name: /Said EL IDRISSI/ })).toBeVisible();
  await page.getByRole("button", { name: ar.modules.vehicles, exact: true }).click();
  await page.getByLabel(ar.common.search).fill("ww778");
  await expect(page.getByRole("button", { name: ar.vehicles.insuredBy.replace("{{number}}", "POL-2026-001") })).toBeVisible();
  // The old vehicle left the policy and has none now.
  await page.getByLabel(ar.common.search).fill("00123B01");
  await expect(page.getByText(ar.vehicles.notInsured)).toBeVisible();
});

test("the policy page in French", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.app.switchLanguage }).click();
  await page.getByRole("button", { name: fr.modules.policies, exact: true }).click();
  await page.getByLabel(fr.common.search).fill("POL-2026");
  await expect(page.getByRole("row", { name: /POL-2026-001/ })).toContainText(fr.policies.validities.active);
  await page.getByRole("row", { name: /POL-2026-001/ }).getByRole("button", { name: fr.common.open }).click();
  await expect(page.getByRole("heading", { name: fr.policies.periods })).toBeVisible();
  await expect(page.getByRole("cell", { name: new RegExp(fr.policies.periodOps.renewal) }).first()).toBeVisible();
  await page.getByRole("button", { name: fr.app.switchLanguage }).click();
});
