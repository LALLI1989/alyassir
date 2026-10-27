import { pendingMigrations } from "@alyassir/db";
import { Pool } from "pg";
import { createApp } from "./app";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();

  // Migrations run only during setup / update on the server computer (SPEC 6.3).
  // The server refuses to start on a database that is not exactly up to date.
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    const pending = await pendingMigrations((sql) => pool.query(sql));
    if (pending.length) throw new Error(`Database is not up to date (pending: ${pending.join(", ")}). Run the installer update.`);
  } finally {
    await pool.end();
  }

  const app = await createApp(config);
  await app.listen(config.port, config.host);
  console.log(`Alyassir server listening on ${config.tls ? "https" : "http"}://${config.host}:${config.port}`);
}

main().catch((error: unknown) => {
  // Print the message only: never dump env or config (may hold secrets).
  console.error("Server failed to start:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
