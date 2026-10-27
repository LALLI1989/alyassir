import { createApp } from "./app";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, config.host);
  console.log(`Alyassir server listening on ${config.tls ? "https" : "http"}://${config.host}:${config.port}`);
}

main().catch((error: unknown) => {
  // Print the message only: never dump env or config (may hold secrets).
  console.error("Server failed to start:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
