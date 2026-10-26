/**
 * Setup helper called by the Windows installer (Inno Setup) with the bundled node.exe.
 *
 *   check-port   --port N [--out FILE]        exit 0 free, 3 in use
 *   suggest-port --from N --out FILE          writes the first free port
 *   provision    --app-dir D --data-dir D --port N --result FILE [--simulate-failure-at STEP]
 *   unprovision  --app-dir D
 */
import { writeFileSync } from "node:fs";
import { isPortFree, suggestPort } from "./ports";
import { PG_PORT, provision, unprovision } from "./provision";

export function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    flags[key.slice(2)] = value;
    i++;
  }
  return { command, flags };
}

function need(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function port(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`Invalid port ${value}`);
  return n;
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "check-port": {
      const p = port(need(flags, "port"));
      const free = p !== PG_PORT && (await isPortFree(p));
      if (flags.out) writeFileSync(flags.out, free ? "free" : "in-use");
      return free ? 0 : 3;
    }
    case "suggest-port": {
      const p = await suggestPort(port(need(flags, "from")), [PG_PORT]);
      writeFileSync(need(flags, "out"), p === null ? "" : String(p));
      return p === null ? 3 : 0;
    }
    case "provision": {
      const result = await provision({
        appDir: need(flags, "app-dir"),
        dataDir: need(flags, "data-dir"),
        port: port(need(flags, "port")),
        resultFile: need(flags, "result"),
        simulateFailureAt: flags["simulate-failure-at"],
      });
      return result.ok ? 0 : 1;
    }
    case "unprovision":
      unprovision(need(flags, "app-dir"));
      return 0;
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    },
  );
}
