/**
 * Interface walk-through in a real browser (Playwright), Arabic and French.
 * Runs in order: each test builds on the previous one (same test database).
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ar as Texts } from "@alyassir/i18n";

// Read as files: the test runner loads plain JSON more reliably than through the package.
const load = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../../packages/i18n/src/${lang}.json`, import.meta.url), "utf8")) as typeof Texts;
const ar = load("ar");
const fr = load("fr");

test.describe.configure({ mode: "serial" });

async function login(page: Page, username: string, password: string, texts = ar) {
  await page.goto("/");
  await page.getByLabel(texts.login.username).fill(username);
  await page.getByLabel(texts.login.password).fill(password);
  await page.getByRole("button", { name: texts.login.submit }).click();
}

async function logout(page: Page, texts = ar) {
  await page.getByRole("button", { name: texts.shell.logout }).click();
  await expect(page.getByRole("button", { name: texts.login.submit })).toBeVisible();
}

test("the manager signs in in Arabic (right to left) and switches to French instantly", async ({ page }) => {
  await login(page, "manager", "manager-pass");
  await expect(page.getByTestId("current-user")).toHaveText("manager");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("button", { name: ar.shell.users })).toBeVisible();
  await expect(page.getByText(ar.status.connected)).toBeVisible();

  await page.getByRole("button", { name: ar.app.switchLanguage }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByRole("button", { name: fr.shell.users })).toBeVisible();
  await page.getByRole("button", { name: fr.app.switchLanguage }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test("wrong password: clear message in the user's language", async ({ page }) => {
  await login(page, "manager", "not-the-password");
  await expect(page.getByText(ar.errors.api.INVALID_CREDENTIALS)).toBeVisible();
  await expect(page.getByText("API-INVALID_CREDENTIALS")).toBeVisible();
});

test("the manager creates an employee and gives one permission", async ({ page }) => {
  await login(page, "manager", "manager-pass");
  await page.getByRole("button", { name: ar.shell.users }).click();
  await page.getByRole("button", { name: ar.users.add }).click();

  // Instant check with the same rule as the server: 6 characters at least.
  await page.getByLabel(ar.users.displayName).fill("كريم");
  await page.getByLabel(ar.users.username).fill("karim");
  await page.getByLabel(ar.users.password, { exact: true }).fill("12345");
  await page.getByRole("button", { name: ar.common.create }).click();
  await expect(page.getByText(ar.errors.fields.password_too_short)).toBeVisible();

  await page.getByLabel(ar.users.password, { exact: true }).fill("karim-pass");
  await page.getByRole("button", { name: ar.common.create }).click();
  const row = page.getByRole("row", { name: /karim/ });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: ar.users.permissions }).click();
  await page.locator('[data-code="clients.view"]').click();
  await expect(page.getByText(ar.permissions.notSupervisorHint)).toBeVisible();
  await page.getByRole("button", { name: ar.common.save }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 5000 }).catch(async (e: unknown) => {
    // Show the error message the dialog displays, to explain the failure.
    throw new Error(`${String(e)}\nDialog says: ${(await page.getByRole("dialog").innerText()).slice(0, 500)}`);
  });
});

test("first sign-in of the employee: chooses French, sees only what he may see", async ({ page }) => {
  await login(page, "karim", "karim-pass");
  await expect(page.getByText(ar.language.title)).toBeVisible();
  await page.getByRole("button", { name: fr.language.fr }).click();

  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("current-user")).toHaveText("كريم");
  await expect(page.getByRole("button", { name: fr.modules.clients })).toBeVisible();
  await expect(page.getByRole("button", { name: fr.modules.policies })).toHaveCount(0);
  await expect(page.getByRole("button", { name: fr.shell.users })).toHaveCount(0);
  await expect(page.getByRole("button", { name: fr.shell.audit })).toHaveCount(0);

  // Message to the manager.
  await page.getByRole("button", { name: fr.shell.messages }).click();
  await page.getByRole("button", { name: fr.messages.new }).click();
  await page.getByRole("dialog").getByRole("group", { name: fr.messages.to }).getByRole("checkbox").first().click();
  await page.getByLabel(fr.messages.subject).fill("Question sur un client");
  await page.getByLabel(fr.messages.body).fill("Bonjour, pouvez-vous vérifier ?");
  await page.getByRole("button", { name: fr.messages.send }).click();
  await expect(page.getByRole("heading", { name: "Question sur un client" })).toBeVisible();
  await logout(page, fr);
});

test("the manager sees the new message at once, reads it and replies", async ({ page }) => {
  await login(page, "manager", "manager-pass");
  const messagesButton = page.getByRole("button", { name: new RegExp(ar.shell.messages) });
  await expect(messagesButton).toContainText("1");
  await messagesButton.click();
  await page.getByRole("button", { name: /Question sur un client/ }).click();
  await expect(page.getByText("Bonjour, pouvez-vous vérifier ?")).toBeVisible();
  await page.getByLabel(ar.messages.reply).fill("تم التحقق");
  await page.getByRole("button", { name: ar.messages.reply }).click();
  await expect(page.getByText("تم التحقق")).toBeVisible();
});

test("the audit log shows what happened, with the device", async ({ page }) => {
  await login(page, "manager", "manager-pass");
  await page.getByRole("button", { name: ar.shell.audit }).click();
  await expect(page.getByRole("cell", { name: ar.audit.actions.user_create })).toBeVisible();
  await expect(page.getByRole("cell", { name: ar.audit.actions.user_permissions })).toBeVisible();
  await expect(page.getByRole("cell", { name: "BROWSER-TEST" }).first()).toBeVisible();
});

test("five wrong passwords lock the account for 15 minutes", async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await login(page, "karim", "wrong-pass");
  }
  await expect(page.getByText(ar.login.lockedUntil.split("{{")[0] ?? "")).toBeVisible();
});
