import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { SetupLog } from "./log";
import { SetupError } from "./steps";

/** Well-known Windows SIDs: identical on Arabic, French and English Windows. */
export const SID = {
  administrators: "*S-1-5-32-544",
  system: "*S-1-5-18",
  networkService: "*S-1-5-20",
} as const;

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Do not throw on a non-zero exit code. */
  allowFail?: boolean;
  /** Error code to throw on failure. */
  code?: string;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function run(log: SetupLog, file: string, args: string[], options: RunOptions & { display?: string } = {}): RunResult {
  log.info(`RUN ${options.display ?? `${file} ${args.join(" ")}`}`);
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? 120_000,
  });
  const out: RunResult = {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "") + (result.error ? ` ${result.error.message}` : ""),
  };
  if (out.stdout.trim()) log.info(`  stdout: ${out.stdout.trim().slice(0, 2000)}`);
  const stderr = out.stderr
    .replace(/#< CLIXML/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/_x000D__x000A_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stderr) log.info(`  stderr: ${stderr.slice(0, 2000)}`);
  if (out.status !== 0 && !options.allowFail) {
    throw new SetupError(options.code ?? "E_COMMAND", `${file} exited with ${out.status}`);
  }
  return out;
}

/** Runs a PowerShell script without any quoting problems (-EncodedCommand). */
export function powershell(log: SetupLog, script: string, options: RunOptions = {}): RunResult {
  // Silence PowerShell progress output (it pollutes stderr with CLIXML).
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'; ${script}`, "utf16le").toString("base64");
  // Log the script itself (scripts never contain secrets; those are passed as environment variables).
  const display = `powershell: ${script.replace(/\s+/g, " ").trim().slice(0, 300)}`;
  return run(log, "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encoded], { ...options, display });
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** "Running", "Stopped", ... or null when the service does not exist. */
export function serviceStatus(log: SetupLog, name: string): string | null {
  const res = powershell(log,
    `$s = Get-Service -Name ${psQuote(name)} -ErrorAction SilentlyContinue; if ($s) { $s.Status.ToString() }`,
    { allowFail: true });
  const status = res.stdout.trim();
  return status === "" ? null : status;
}

export function startService(log: SetupLog, name: string, code: string): void {
  powershell(log, `$ErrorActionPreference='Stop'; Start-Service -Name ${psQuote(name)}`, { code });
}

export function stopService(log: SetupLog, name: string): void {
  if (serviceStatus(log, name) === null) return;
  powershell(log, `Stop-Service -Name ${psQuote(name)} -Force -ErrorAction SilentlyContinue`, { allowFail: true });
}

/** Restrict a folder to Administrators + SYSTEM (+ extra SIDs), dropping inherited rights (e.g. Users). */
export function restrictAcl(log: SetupLog, dir: string, extraSids: string[] = []): void {
  const grants = [SID.administrators, SID.system, ...extraSids].flatMap((sid) => ["/grant:r", `${sid}:(OI)(CI)F`]);
  // Set the rights on the folder itself only...
  run(log, "icacls.exe", [dir, "/inheritance:r", ...grants, "/Q"], { code: "E_ACL" });
  // ...then make everything inside inherit exactly those rights (and drop any other explicit rights).
  if (readdirSync(dir).length > 0) {
    run(log, "icacls.exe", [join(dir, "*"), "/reset", "/T", "/C", "/Q"], { code: "E_ACL" });
  }
}

/** SID of the account running setup, e.g. "S-1-5-21-...". */
export function currentUserSid(log: SetupLog): string {
  const res = run(log, "whoami.exe", ["/user", "/fo", "csv", "/nh"], { code: "E_ACL" });
  const match = /"(S-1-[0-9-]+)"/.exec(res.stdout);
  if (!match?.[1]) throw new SetupError("E_ACL", "Could not read the current user SID");
  return match[1];
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}
