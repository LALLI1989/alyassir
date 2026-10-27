/**
 * Screenshots of the real interface for the owner (runs after app.spec.ts, same test data).
 * Saved to apps/desktop/screenshots/ and published by CI on the "screenshots" branch.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ar as Texts } from "@alyassir/i18n";

const ar = JSON.parse(readFileSync(new URL("../../../packages/i18n/src/ar.json", import.meta.url), "utf8")) as typeof Texts;
const OUT = new URL("../screenshots/", import.meta.url).pathname;

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 800 } });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel(ar.login.username).fill("manager");
  await page.getByLabel(ar.login.password).fill("manager-pass");
  await page.getByRole("button", { name: ar.login.submit }).click();
  await expect(page.getByTestId("current-user")).toBeVisible();
  await expect(page.getByText(ar.status.connected)).toBeVisible();
}

test("1 - sign-in screen", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(ar.login.username).fill("manager");
  await page.screenshot({ path: `${OUT}1-login.png` });
});

test("2 - users and permissions", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: ar.shell.users, exact: true }).click();
  await page.getByRole("row", { name: /karim/ }).getByRole("button", { name: ar.users.permissions }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: `${OUT}2-permissions.png` });
});

test("3 - internal messages", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: new RegExp(ar.shell.messages) }).first().click();
  await page.getByRole("button", { name: /Question sur un client/ }).click();
  await expect(page.getByText("تم التحقق")).toBeVisible();
  await page.screenshot({ path: `${OUT}3-messages.png` });
});
