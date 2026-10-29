/**
 * Phase 6A in a real browser: the dashboard, a report with a filter and its totals, the printed
 * version (A4 landscape PDF), the Excel file, French. Runs after the payment tests (same test
 * database). Takes the screenshots 16-, 17-, 18-.
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

test("the dashboard: cards and charts from the server", async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId("dash-payments")).toContainText(ar.dashboard.payments);
  await expect(page.getByTestId("dash-payments")).toContainText(",");
  await expect(page.getByTestId("dash-clients")).toBeVisible();
  await expect(page.getByTestId("dash-drawer")).toBeVisible();
  await expect(page.getByText(ar.dashboard.chartPayments)).toBeVisible();
  await expect(page.getByText(ar.dashboard.chartPolicies)).toBeVisible();
  await page.getByLabel(ar.dashboard.period).selectOption("year");
  await expect(page.getByTestId("dash-payments")).toBeVisible();
  await page.getByLabel(ar.dashboard.period).selectOption("month");
  await page.screenshot({ path: `${OUT}16-dashboard.png`, fullPage: true });
});

test("a report: payments in cash, with totals, printed and saved as Excel", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.reports, exact: true }).click();
  await page.getByLabel(ar.reports.choose).selectOption("payments");
  await page.getByLabel(ar.reports.filters.method).selectOption("cash");
  await page.getByRole("button", { name: ar.reports.show }).click();
  const table = page.getByTestId("report-table");
  await expect(table).toContainText(ar.reports.columns.amount);
  await expect(table).toContainText(ar.finance.methods.cash);
  await expect(page.getByTestId("report-totals")).toContainText(ar.reports.total);
  await expect(page.getByText(ar.finance.methods.cash).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}17-report.png` });

  // On paper: only the report, A4 landscape.
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".report-print")).toBeVisible();
  await expect(page.locator(".report-print")).toContainText(ar.reports.titles.payments);
  await expect(table).toBeHidden();
  await page.pdf({ path: `${OUT}report-A4.pdf`, preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: "screen" });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: ar.reports.excel }).click();
  expect((await download).suggestedFilename()).toMatch(/^payments-\d{4}-\d{2}-\d{2}\.xlsx$/);
  await expect(page.getByRole("status").filter({ hasText: "payments-" })).toBeVisible();
});

test("in French: the report is written in French", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.app.switchLanguage }).click();
  await page.getByRole("button", { name: fr.modules.reports, exact: true }).click();
  await page.getByLabel(fr.reports.choose).selectOption("clients");
  await page.getByRole("button", { name: fr.reports.show }).click();
  const table = page.getByTestId("report-table");
  await expect(table).toContainText(fr.reports.columns.clientKind);
  await expect(table).toContainText(fr.clients.kinds.individual);
  await page.screenshot({ path: `${OUT}18-report-fr.png` });
  await page.getByRole("button", { name: fr.app.switchLanguage }).click();
});
