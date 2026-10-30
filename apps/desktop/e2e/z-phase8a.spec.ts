/**
 * Phase 8A in a real browser (runs last, same test database): the manager forgot his password and
 * uses the printed recovery code; a new code from "My account"; Google Drive not running on the
 * server and the weekly "I checked". Takes the screenshots 25-, 26-, 27-.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ar as Texts } from "@alyassir/i18n";

const load = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../../packages/i18n/src/${lang}.json`, import.meta.url), "utf8")) as typeof Texts;
const ar = load("ar");
const fr = load("fr");
const OUT = new URL("../screenshots/", import.meta.url).pathname;
const CONTROL = "http://127.0.0.1:4198";
const CODE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 900 } });

async function signIn(page: Page, password = "manager-pass") {
  await page.goto("/");
  await page.getByLabel(ar.login.username).fill("manager");
  await page.getByLabel(ar.login.password).fill(password);
  await page.getByRole("button", { name: ar.login.submit }).click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

test("the manager forgot his password: the printed code gives a new one, and a new code", async ({ page, request }) => {
  const printed = (await (await request.get(`${CONTROL}/recovery-code`)).text()).trim();
  expect(printed).toMatch(CODE);
  await page.goto("/");
  await page.getByRole("button", { name: ar.recovery.link }).click();
  const form = page.getByTestId("recover-form");
  await form.getByLabel(ar.login.username).fill("manager");
  await form.getByLabel(ar.recovery.code).fill("AAAA-AAAA-AAAA-AAAA");
  await form.getByLabel(ar.recovery.newPassword).fill("manager-pass");
  await form.getByLabel(ar.recovery.again).fill("manager-pass");
  await form.getByRole("button", { name: ar.recovery.submit }).click();
  await expect(form).toContainText(ar.errors.api.RECOVERY_INVALID);
  // Typed in lower case with spaces: accepted.
  await form.getByLabel(ar.recovery.code).fill(printed.toLowerCase().replace(/-/g, " "));
  await page.screenshot({ path: `${OUT}25-recover.png` });
  await form.getByRole("button", { name: ar.recovery.submit }).click();
  const done = page.getByTestId("recovered");
  await expect(done).toContainText(ar.recovery.done);
  const next = (await page.getByTestId("new-recovery-code").textContent())?.trim() ?? "";
  expect(next).toMatch(CODE);
  expect(next).not.toBe(printed);
  await done.getByRole("button", { name: ar.recovery.backToLogin }).click();
  await signIn(page);
  // The message about it is waiting for the manager.
  await page.getByRole("button", { name: new RegExp(ar.shell.messages) }).first().click();
  await page.getByRole("button", { name: new RegExp(ar.messages.events.manager_recovered.subject) }).click();
  await expect(page.getByText(ar.messages.events.manager_recovered.ways.code)).toBeVisible();
});

test("My account: the recovery code exists; a new one needs the password", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.shell.account }).click();
  const card = page.getByTestId("recovery-card");
  await expect(card).toContainText(ar.recovery.exists.split("{{")[0] as string);
  await card.getByLabel(ar.account.currentPassword).fill("wrong-pass");
  await card.getByRole("button", { name: ar.recovery.create }).click();
  await expect(card).toContainText(ar.errors.api.WRONG_PASSWORD);
  await card.getByLabel(ar.account.currentPassword).fill("manager-pass");
  await card.getByRole("button", { name: ar.recovery.create }).click();
  await expect(card.getByTestId("new-recovery-code")).toHaveText(CODE);
  await page.screenshot({ path: `${OUT}26-recovery-code.png`, fullPage: true });
});

test("Google Drive not running on the server; the weekly check, then I checked", async ({ page, request }) => {
  expect((await request.get(`${CONTROL}/drive?running=0&due=1`)).ok()).toBe(true);
  await signIn(page);
  await expect(page.getByTestId("dash-backup")).toContainText(ar.dashboard.driveNotRunning);
  await page.getByRole("button", { name: ar.shell.reminders }).click();
  await expect(page.getByTestId("reminders-drive_check")).toContainText(ar.followup.reminderKinds.drive_check);
  await page.getByRole("button", { name: ar.shell.backups }).click();
  const drive = page.getByTestId("drive-check");
  await expect(drive).toContainText(ar.backups.drive.notRunning);
  await expect(drive).toContainText(ar.backups.drive.weekly);
  await page.screenshot({ path: `${OUT}27-drive.png`, fullPage: true });
  await drive.getByRole("button", { name: ar.backups.drive.checked }).click();
  await expect(drive).toContainText(ar.backups.drive.lastChecked.split("{{")[0] as string);
  await page.getByRole("button", { name: ar.shell.reminders }).click();
  await expect(page.getByTestId("reminders-drive_check")).toHaveCount(0);
  // French.
  await page.getByRole("button", { name: ar.app.switchLanguage }).click();
  await page.getByRole("button", { name: fr.shell.backups }).click();
  await expect(page.getByTestId("drive-check")).toContainText(fr.backups.drive.notRunning);
  await page.getByRole("button", { name: fr.app.switchLanguage }).click();
  expect((await request.get(`${CONTROL}/drive?running=1&due=0`)).ok()).toBe(true);
});
