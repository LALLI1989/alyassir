// CI: opens the browser demo like a person would (real browser), signs in, and checks the home page.
import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "http://127.0.0.1:5173";
const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(String(e)));
try {
  await page.goto(url);
  await page.getByLabel("اسم المستخدم").fill("gerant", { timeout: 30_000 });
  await page.getByLabel("كلمة المرور").fill("gerant123");
  await page.getByRole("button", { name: "دخول", exact: true }).click();
  await page.getByTestId("current-user").waitFor({ timeout: 30_000 });
  await page.getByText("متصل بالخادم").waitFor({ timeout: 30_000 });
  console.log("Browser demo OK: signed in, connected to the server");
} catch (e) {
  console.log(`BROWSER DEMO FAILED: ${String(e)}\nPage errors: ${problems.join("\n")}\nPage text: ${(await page.innerText("body").catch(() => "")).slice(0, 500)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
