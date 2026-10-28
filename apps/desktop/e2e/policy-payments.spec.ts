/**
 * Phase 3 in a real browser: policy in 2 instalments (4000 → 2017 + 2000), cash paid at issue,
 * a cheque recorded with its receipt, confirmed then bounced by the manager, the debt it leaves,
 * the automatic message, French. Runs after policies.spec.ts (same test database, RMA type exists).
 * Also takes the screenshots shown to the owner (7-, 8-, 9-).
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

async function openPolicy(page: Page, number: string) {
  await page.getByRole("button", { name: ar.modules.policies, exact: true }).click();
  await page.getByLabel(ar.common.search).fill(number);
  await page.getByRole("row", { name: new RegExp(number) }).getByRole("button", { name: ar.common.open }).click();
  await expect(page.getByRole("heading", { name: new RegExp(number) })).toBeVisible();
}

test("a policy in 2 instalments: the server shows 2 017 + 2 000 = 4 017; 1 000 paid in cash now", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.clients, exact: true }).click();
  await page.getByRole("button", { name: ar.clients.add }).click();
  await page.getByLabel(ar.clients.fullName).fill("Nadia BENNANI");
  await page.getByLabel(ar.clients.idNumber).fill("cd 654321");
  await page.getByLabel(ar.clients.phone).fill("0662 11 22 33");
  await page.getByRole("button", { name: ar.common.create }).click();
  await expect(page.getByRole("heading", { name: "Nadia BENNANI" })).toBeVisible();
  await page.getByRole("button", { name: ar.vehicles.add }).click();
  await page.getByLabel(ar.vehicles.plateType).selectOption("ww");
  await page.getByLabel(ar.vehicles.plate).fill("WW 112233");
  await page.getByLabel(ar.vehicles.fiscalPower).fill("8");
  await page.getByLabel(ar.vehicles.brand).fill("Peugeot 208");
  await page.getByRole("button", { name: ar.common.create }).click();
  await expect(page.getByRole("cell", { name: /WW112233/ })).toBeVisible();

  await page.getByRole("button", { name: ar.clients.newPolicy }).click();
  await page.getByLabel(ar.policies.type).selectOption({ label: "RMA — Assurance automobile" });
  await page.getByRole("checkbox", { name: "WW112233" }).click();
  await page.getByLabel(`${ar.policies.certificate} WW112233`).fill("ATT-2026-0101");
  await page.getByLabel(ar.policies.number).fill("POL-2026-010");
  await page.getByLabel(ar.policies.amount, { exact: true }).fill("4000");
  await page.getByLabel(ar.finance.modes.instalments).check();
  await page.getByLabel(ar.finance.instalmentCount).selectOption("2");
  const preview = page.getByTestId("instalments-preview");
  await expect(preview).toContainText("2 017,00");
  await expect(preview).toContainText("2 000,00");
  await expect(preview).toContainText("4 017,00");
  await page.getByRole("button", { name: ar.finance.addPayment }).click();
  await page.getByLabel(ar.finance.amount, { exact: true }).fill("1000");
  await page.screenshot({ path: `${OUT}7-instalments.png`, fullPage: true });
  await page.getByRole("button", { name: ar.common.create }).click();

  await expect(page.getByRole("heading", { name: /POL-2026-010/ })).toBeVisible();
  const totals = page.getByTestId("finance-totals");
  await expect(totals).toContainText("4 017,00");
  await expect(totals).toContainText("1 000,00");
  await expect(totals).toContainText("3 017,00");
  await expect(page.getByTestId("instalments")).toContainText(ar.finance.instalmentStatus.partial);
  await expect(page.getByTestId("receipts").getByRole("row")).toHaveCount(2);
});

test("a cheque of 1 017: in collection, with its printable receipt", async ({ page }) => {
  await signIn(page);
  await openPolicy(page, "POL-2026-010");
  await page.getByRole("button", { name: ar.finance.record }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(ar.finance.method).selectOption("cheque");
  await dialog.getByLabel(ar.finance.amount, { exact: true }).fill("1017");
  await dialog.getByLabel(ar.finance.chequeNumber).fill("CHQ-778");
  await dialog.getByLabel(ar.finance.bank).fill("Attijariwafa bank");
  await dialog.getByLabel(ar.finance.drawerName).fill("Nadia BENNANI");
  await dialog.getByLabel(ar.finance.chequeDue).fill("2026-12-01");
  await dialog.getByRole("button", { name: ar.common.confirm }).click();

  const receipt = page.getByTestId("receipt");
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText(ar.receipt.titles.payment);
  await expect(receipt).toContainText(/\d{4}-\d{6}/);
  await expect(receipt).toContainText("Nadia BENNANI");
  await expect(receipt).toContainText("1 017,00");
  await expect(receipt).toContainText("2 000,00");
  await expect(receipt).toContainText("CHQ-778");
  await page.screenshot({ path: `${OUT}8-receipt.png` });
  // On paper: only the receipt, on an A5 page (owner remark 28/10/2026).
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".print-root")).toBeVisible();
  await expect(page.locator(".print-root")).toContainText("CHQ-778");
  await expect(page.getByTestId("receipt")).toBeHidden();
  await page.pdf({ path: `${OUT}receipt-A5.pdf`, preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("dialog").getByRole("button", { name: ar.common.close }).first().click();

  const totals = page.getByTestId("finance-totals");
  await expect(totals).toContainText("2 000,00");
  await expect(page.getByTestId("policy-payments")).toContainText(ar.finance.paymentStatus.in_collection);
  await expect(page.getByTestId("finance")).toContainText(ar.finance.collection.in_collection);
});

test("the manager confirms the cheque, then it bounces: back to a debt, and a message", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.payments, exact: true }).click();
  const row = page.getByRole("row", { name: /CHQ-778/ });
  await expect(row).toContainText(ar.finance.paymentStatus.in_collection);
  await page.screenshot({ path: `${OUT}9-payments.png` });
  await row.getByRole("button", { name: ar.finance.confirm }).click();
  await page.getByRole("dialog").getByRole("button", { name: ar.common.confirm }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByLabel(ar.common.status).selectOption("all");
  await expect(row).toContainText(ar.finance.paymentStatus.confirmed);
  await row.getByRole("button", { name: ar.finance.bounce }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(ar.common.reason).fill("Provision insuffisante");
  await dialog.getByRole("button", { name: ar.common.confirm }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText(ar.finance.paymentStatus.rejected);

  await page.getByRole("button", { name: ar.modules.debts, exact: true }).click();
  await expect(page.getByRole("row", { name: new RegExp(ar.finance.debtSources.rejected_payment) })).toContainText("1 017,00");
  // Owner request 28/10/2026: pay a debt straight from the list (here by card, so the drawer does not move).
  const debtRow = page.getByRole("row", { name: new RegExp(ar.finance.debtSources.rejected_payment) });
  await debtRow.getByRole("button", { name: new RegExp(ar.finance.record) }).click();
  const payDialog = page.getByRole("dialog");
  await payDialog.getByLabel(ar.finance.method).selectOption("card");
  await payDialog.getByLabel(ar.finance.amount, { exact: true }).fill("1017");
  await payDialog.getByRole("button", { name: ar.common.confirm }).click();
  await expect(page.getByTestId("receipt")).toContainText(ar.finance.methods.card);
  await page.getByRole("dialog").getByRole("button", { name: ar.common.close }).first().click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await openPolicy(page, "POL-2026-010");
  await expect(page.getByTestId("finance")).toContainText(ar.finance.collection.payment_rejected);
  await expect(page.getByTestId("receipts")).toContainText(ar.receipt.cancelled);

  await page.getByRole("button", { name: new RegExp(ar.shell.messages) }).first().click();
  await page.getByText(ar.messages.events.payment_rejected.subject).first().click();
  await expect(page.getByText(ar.messages.events.payment_rejected.intro)).toBeVisible();
  await expect(page.getByText("Provision insuffisante")).toBeVisible();
});

test("the money of the policy in French", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.app.switchLanguage }).click();
  await page.getByRole("button", { name: fr.modules.policies, exact: true }).click();
  await page.getByLabel(fr.common.search).fill("POL-2026-010");
  await page.getByRole("row", { name: /POL-2026-010/ }).getByRole("button", { name: fr.common.open }).click();
  await expect(page.getByTestId("finance")).toContainText(fr.finance.title);
  // The bounced cheque became a separate debt; the first instalment stays paid (SPEC 14.1).
  await expect(page.getByTestId("instalments")).toContainText(fr.finance.instalmentStatus.paid);
  await expect(page.getByTestId("policy-debts")).toContainText(fr.finance.debtSources.rejected_payment);
  await page.getByRole("button", { name: fr.app.switchLanguage }).click();
});
