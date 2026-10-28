/**
 * Phase 5 in a real browser: a claim on a policy and its follow-up, a promise to pay in the contact
 * log, a WhatsApp message filled by the server, the reminders screen, French. Runs after the other
 * files (same test database). Takes the screenshots 13-, 14-, 15-.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ar as Texts } from "@alyassir/i18n";

const load = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../../packages/i18n/src/${lang}.json`, import.meta.url), "utf8")) as typeof Texts;
const ar = load("ar");
const fr = load("fr");
const OUT = new URL("../screenshots/", import.meta.url).pathname;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca" }).format(new Date());

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 900 } });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel(ar.login.username).fill("manager");
  await page.getByLabel(ar.login.password).fill("manager-pass");
  await page.getByRole("button", { name: ar.login.submit }).click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

test("a claim on a policy: declared today, then in expertise", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.policies, exact: true }).click();
  await page.getByLabel(ar.common.search).fill("POL-2026-010");
  await page.getByRole("row", { name: /POL-2026-010/ }).getByRole("button", { name: ar.common.open }).click();
  await page.getByRole("button", { name: ar.followup.newClaim }).click();
  const dialog = page.getByTestId("claim-dialog");
  await dialog.getByLabel(ar.followup.accidentDate).fill(today);
  await dialog.getByLabel(ar.followup.place).fill("Casablanca, Bd Zerktouni");
  await dialog.getByLabel(new RegExp(ar.followup.requested)).fill("5000");
  await dialog.getByRole("button", { name: ar.common.save }).click();
  const row = page.getByTestId("claims").getByRole("row", { name: /Casablanca/ });
  await expect(row).toContainText(ar.followup.claimStatus.declared);
  await expect(row).toContainText("5 000,00");
  await row.getByRole("button", { name: ar.common.edit }).click();
  await page.getByTestId("claim-dialog").getByLabel(ar.common.status).selectOption("expertise");
  await page.screenshot({ path: `${OUT}13-claim.png` });
  await page.getByTestId("claim-dialog").getByRole("button", { name: ar.common.save }).click();
  await expect(row).toContainText(ar.followup.claimStatus.expertise);
});

test("contact log: a promise to pay today; WhatsApp with the message filled by the server", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.clients, exact: true }).click();
  await page.getByLabel(ar.common.search).fill("Said EL IDRISSI");
  await page.getByRole("row", { name: /Said EL IDRISSI/ }).getByRole("button", { name: ar.common.open }).click();
  await page.getByRole("button", { name: ar.followup.addContact }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(ar.followup.contactKind).selectOption("promise");
  await dialog.getByLabel(ar.followup.promiseDate).fill(today);
  await dialog.getByLabel(new RegExp(ar.cash.note)).fill("Passera à l'agence");
  await dialog.getByRole("button", { name: ar.common.save }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("contacts")).toContainText(ar.followup.contactKinds.promise);

  await page.getByRole("button", { name: ar.followup.whatsapp }).first().click();
  const wa = page.getByTestId("whatsapp-dialog");
  await wa.getByLabel(ar.followup.template).selectOption("payment");
  await wa.getByLabel(ar.followup.language).selectOption("fr");
  const popup = page.waitForEvent("popup");
  await wa.getByRole("button", { name: ar.followup.openWhatsapp }).click();
  const opened = await popup;
  expect(opened.url()).toMatch(/^https:\/\/wa\.me\/212661234567\?text=/);
  await opened.close();
  await expect(page.getByTestId("whatsapp-text")).toContainText("Said EL IDRISSI");
  await expect(page.getByTestId("whatsapp-text")).toContainText("MAD");
  await page.screenshot({ path: `${OUT}14-whatsapp.png` });
  await wa.getByRole("button", { name: ar.common.close }).first().click();
  await expect(page.getByTestId("contacts")).toContainText(ar.followup.contactKinds.whatsapp);
});

test("the reminders screen shows the promise of today", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: new RegExp(ar.shell.reminders) }).first().click();
  const promises = page.getByTestId("reminders-promise_due");
  await expect(promises).toContainText("Said EL IDRISSI");
  await expect(promises.getByRole("button", { name: ar.followup.whatsapp })).toBeVisible();
  await page.screenshot({ path: `${OUT}15-reminders.png`, fullPage: true });
});

test("claims and reminders in French", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.app.switchLanguage }).click();
  await page.getByRole("button", { name: fr.modules.claims, exact: true }).click();
  await expect(page.getByRole("heading", { name: fr.followup.claimsTitle })).toBeVisible();
  await expect(page.getByTestId("claims")).toContainText(fr.followup.claimStatus.expertise);
  await page.getByRole("button", { name: new RegExp(fr.shell.reminders) }).first().click();
  await expect(page.getByTestId("reminders-promise_due")).toContainText(fr.followup.reminderKinds.promise_due);
  await page.getByRole("button", { name: fr.app.switchLanguage }).click();
});
