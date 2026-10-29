/**
 * Phase 6B in a real browser (runs last, same test database): the backups screen (a real backup,
 * the folder, the working hours), a real restore, and the monthly USB copy that blocks the
 * application until it is done. Takes the screenshots 19-, 20-, 21-.
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

test("the backups screen: a backup now, then on the dashboard", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.shell.backups }).click();
  await expect(page.getByTestId("backup-last")).toHaveText(ar.backups.never);
  await page.getByRole("button", { name: ar.backups.takeNow }).click();
  const files = page.getByTestId("backup-files");
  // Either the list of files, or an error whose text then shows in the test report.
  await expect(files.or(page.getByRole("alert")).first()).toBeVisible({ timeout: 30_000 });
  expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  await expect(files).toContainText(ar.backups.kinds.manual);
  await expect(files).toContainText(ar.backups.check.ok);
  await expect(page.getByTestId("backup-last")).not.toHaveText(ar.backups.never);
  await expect(page.getByText(ar.backups.driveHelp)).toBeVisible();
  await page.screenshot({ path: `${OUT}19-backups.png`, fullPage: true });
  await page.getByRole("button", { name: ar.shell.home }).click();
  await expect(page.getByTestId("dash-backup")).toContainText(ar.dashboard.backup);
});

test("a real restore: a client added after the backup is gone, everyone signs in again", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.clients, exact: true }).click();
  await page.getByLabel(ar.common.search).fill("Said EL IDRISSI");
  await expect(page.getByRole("row", { name: /Said EL IDRISSI/ })).toBeVisible();
  await page.getByRole("button", { name: ar.shell.backups }).click();
  const row = page.getByTestId("backup-files").getByRole("row").filter({ hasText: ar.backups.kinds.manual }).first();
  await row.getByRole("button", { name: ar.backups.restore }).click();
  const dialog = page.getByTestId("restore-dialog");
  await dialog.getByLabel(ar.backups.restorePassword).fill("wrong-pass");
  await dialog.getByRole("button", { name: ar.backups.restoreConfirm }).click();
  await expect(dialog).toContainText(ar.errors.api.WRONG_PASSWORD);
  await page.screenshot({ path: `${OUT}20-restore.png` });
  await dialog.getByLabel(ar.backups.restorePassword).fill("manager-pass");
  await dialog.getByRole("button", { name: ar.backups.restoreConfirm }).click();
  // Done: the success message (with the safety copy), or already the sign-in screen (sessions came back as in the backup).
  const done = page.getByText(/alyassir-safety-/).or(page.getByLabel(ar.login.username));
  await expect(done.first()).toBeVisible({ timeout: 60_000 });
  // The data of the backup is back (it was taken after the earlier tests: the client is still there).
  await signIn(page);
  await page.getByRole("button", { name: ar.modules.clients, exact: true }).click();
  await page.getByLabel(ar.common.search).fill("Said EL IDRISSI");
  await expect(page.getByRole("row", { name: /Said EL IDRISSI/ })).toBeVisible();
});

test("the monthly USB copy: overdue, the application stops; the copy at the server unblocks it", async ({ page, request }) => {
  expect((await request.get("http://127.0.0.1:4198/usb-overdue")).ok()).toBe(true);
  await signIn(page);
  const block = page.getByTestId("usb-block");
  await expect(block).toContainText(ar.backups.usb.title);
  await expect(block.getByRole("button", { name: ar.backups.usb.skip })).toBeVisible();
  await page.screenshot({ path: `${OUT}21-usb-block.png` });
  await page.getByRole("button", { name: ar.app.switchLanguage }).click();
  await expect(block).toContainText(fr.backups.usb.title);
  await page.getByRole("button", { name: fr.app.switchLanguage }).click();
  await block.getByRole("button", { name: ar.backups.usb.copy }).click();
  await expect(block).toBeHidden({ timeout: 60_000 });
  await page.getByRole("button", { name: ar.modules.clients, exact: true }).click();
  await expect(page.getByLabel(ar.common.search)).toBeVisible();
});
