/**
 * Phase 4 in a real browser: an expense waiting for approval then approved, 500 MAD moved from the
 * drawer to the safe, the drawer closed with a gap (refused without a reason), the day status,
 * French. Runs after policy-payments.spec.ts: the manager holds the drawer with 1 317 MAD
 * (317 from the vehicle change + 1 000 paid in cash). Takes the screenshots 10-, 11-, 12-.
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
test.use({ viewport: { width: 1280, height: 900 } });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel(ar.login.username).fill("manager");
  await page.getByLabel(ar.login.password).fill("manager-pass");
  await page.getByRole("button", { name: ar.login.submit }).click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

test("an expense of 150: waiting, no effect on the drawer, then approved", async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId("drawer-badge")).toContainText(ar.drawer.held);
  await page.getByRole("button", { name: ar.modules.expenses, exact: true }).click();
  await page.getByRole("button", { name: ar.cash.addExpense }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(ar.cash.category).selectOption({ label: ar.cash.categories.cleaning });
  await dialog.getByLabel(ar.finance.amount, { exact: true }).fill("150");
  await dialog.getByRole("button", { name: ar.common.confirm }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole("row", { name: new RegExp(ar.cash.categories.cleaning) });
  await expect(row).toContainText(ar.cash.expenseStatus.pending);
  await expect(row).toContainText("150,00");
  await page.screenshot({ path: `${OUT}11-expenses.png` });
  await row.getByRole("button", { name: ar.cash.approve }).click();
  await page.getByRole("dialog").getByRole("button", { name: ar.common.confirm }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByLabel(ar.common.status).selectOption("all");
  await expect(page.getByRole("row", { name: new RegExp(ar.cash.categories.cleaning) })).toContainText(ar.cash.expenseStatus.approved);
});

test("500 from the drawer to the safe, in one operation", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.shell.accounts, exact: true }).click();
  const balances = page.getByTestId("balances");
  await expect(balances).toContainText("1 167,00");
  await page.getByRole("button", { name: ar.cash.transfer, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(ar.finance.amount, { exact: true }).fill("500");
  await dialog.getByRole("button", { name: ar.common.confirm }).click();
  await expect(dialog).toBeHidden();
  await expect(balances).toContainText("667,00");
  await expect(balances).toContainText("500,00");
  await expect(page.getByTestId("movements")).toContainText(ar.cash.kinds.transfer_out);
  await page.screenshot({ path: `${OUT}12-accounts.png` });
});

test("closing with 650 found for 667 expected: a reason is required, then the gap is shown", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.closing, exact: true }).click();
  await expect(page.getByTestId("drawer-session")).toContainText("667,00");
  await page.getByRole("button", { name: ar.drawer.close }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(ar.drawer.counted).fill("650");
  await dialog.getByRole("button", { name: ar.common.confirm }).click();
  await expect(dialog).toContainText(ar.errors.api.DIFFERENCE_REASON_REQUIRED);
  await dialog.getByLabel(ar.drawer.reason).fill("Monnaie rendue en trop");
  await page.screenshot({ path: `${OUT}10-closing.png` });
  await dialog.getByRole("button", { name: ar.common.confirm }).click();
  const result = page.getByTestId("closing-result");
  await expect(result).toContainText("667,00");
  await expect(result).toContainText("650,00");
  await expect(result).toContainText("-17,00");
  await result.getByRole("button", { name: ar.common.close }).click();
  await expect(page.getByTestId("drawer-session")).toContainText(ar.drawer.noSession);
  await expect(page.getByTestId("days")).toContainText(ar.drawer.dayStatus.closed);
  await expect(page.getByTestId("closings")).toContainText("-17,00");
  // The drawer has to be received again before any cash.
  await expect(page.getByTestId("drawer-badge")).toContainText(ar.drawer.receive);
});

test("the closing page in French", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.app.switchLanguage }).click();
  await page.getByRole("button", { name: fr.modules.closing, exact: true }).click();
  await expect(page.getByRole("heading", { name: fr.drawer.title })).toBeVisible();
  await expect(page.getByTestId("days")).toContainText(fr.drawer.dayStatus.closed);
  await page.getByRole("button", { name: fr.app.switchLanguage }).click();
});
