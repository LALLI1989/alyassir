import { readFileSync } from "node:fs";

/**
 * All server settings come from environment variables only (SPEC 4.13).
 * On the server computer, the Windows service (WinSW) sets them.
 */
export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  tls: { pfx: Buffer; passphrase: string } | null;
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`Missing environment variable ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.ALYASSIR_PORT ?? "4100");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("ALYASSIR_PORT must be a valid TCP port");
  }

  // HTTPS is mandatory. Plain HTTP is allowed only for automated tests.
  let tls: ServerConfig["tls"] = null;
  if (env.ALYASSIR_INSECURE_HTTP === "1") {
    if (env.NODE_ENV !== "test") {
      throw new ConfigError("ALYASSIR_INSECURE_HTTP is only allowed when NODE_ENV=test");
    }
  } else {
    tls = {
      pfx: readFileSync(required(env, "ALYASSIR_TLS_PFX")),
      passphrase: required(env, "ALYASSIR_TLS_PFX_PASSPHRASE"),
    };
  }

  return {
    host: env.ALYASSIR_HOST ?? "0.0.0.0",
    port,
    databaseUrl: required(env, "DATABASE_URL"),
    tls,
  };
}
