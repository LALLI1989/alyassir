import { defineConfig, devices } from "@playwright/test";

// Interface tests in a real browser, against a real server and a real PostgreSQL database.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: [
    {
      command: "node ../server/test/e2e-server.mjs",
      url: "http://127.0.0.1:4199/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
    },
    {
      command: "pnpm exec vite --port 4173 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_ADAPTER: "web", VITE_API_URL: "http://127.0.0.1:4199" },
    },
  ],
});
