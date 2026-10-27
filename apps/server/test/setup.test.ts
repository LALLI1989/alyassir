import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/setup/cli";
import { readBootstrap, readWinswEnv } from "../src/setup/common";
import { SetupLog } from "../src/setup/log";
import { isPortFree, suggestPort } from "../src/setup/ports";
import { POSTGRES_CONF, winswXml } from "../src/setup/provision";
import { SetupError, runSteps, type Step } from "../src/setup/steps";

describe("runSteps rollback", () => {
  it("undoes finished steps in reverse order when a step fails", async () => {
    const events: string[] = [];
    const step = (name: string, fail = false): Step => ({
      name,
      code: `E_${name.toUpperCase()}`,
      run: () => {
        if (fail) throw new Error("boom");
        events.push(`run ${name}`);
      },
      undo: () => {
        events.push(`undo ${name}`);
      },
    });
    const result = await runSteps([step("a"), step("b"), step("c", true), step("d")], new SetupLog(null));
    expect(result).toMatchObject({ ok: false, failedStep: "c", errorCode: "E_C" });
    expect(events).toEqual(["run a", "run b", "undo b", "undo a"]);
  });

  it("keeps undoing even if one undo fails, and reports the SetupError code", async () => {
    const events: string[] = [];
    const steps: Step[] = [
      { name: "a", code: "E_A", run: () => void events.push("run a"), undo: () => void events.push("undo a") },
      { name: "b", code: "E_B", run: () => void events.push("run b"), undo: () => { throw new Error("cannot"); } },
      { name: "c", code: "E_C", run: () => { throw new SetupError("E_SPECIFIC", "x"); } },
    ];
    const result = await runSteps(steps, new SetupLog(null));
    expect(result.errorCode).toBe("E_SPECIFIC");
    expect(events).toEqual(["run a", "run b", "undo a"]);
  });

  it("simulates a failure at a named step (used by the installer tests)", async () => {
    const events: string[] = [];
    const steps: Step[] = ["a", "b", "c"].map((name) => ({
      name, code: "E", run: () => void events.push(`run ${name}`), undo: () => void events.push(`undo ${name}`),
    }));
    const result = await runSteps(steps, new SetupLog(null), "c");
    expect(result).toMatchObject({ ok: false, errorCode: "E_SIMULATED", failedStep: "c" });
    expect(events).toEqual(["run a", "run b", "undo b", "undo a"]);
  });
});

describe("SetupLog", () => {
  it("never writes registered secrets", () => {
    const log = new SetupLog(null);
    log.addSecret("TopSecret123");
    expect(log.redact("postgres://u:TopSecret123@h/db")).toBe("postgres://u:***@h/db");
  });
});

describe("ports", () => {
  it("detects a used port and suggests the next free one", async () => {
    const server: Server = createServer();
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
    const used = (server.address() as { port: number }).port;
    try {
      expect(await isPortFree(used)).toBe(false);
      const suggestion = await suggestPort(used);
      expect(suggestion).not.toBe(used);
      expect(suggestion).toBeGreaterThan(used);
    } finally {
      server.close();
    }
  });
});

describe("cli args", () => {
  it("parses flags", () => {
    expect(parseArgs(["provision", "--port", "4100", "--data-dir", "C:\\Data"])).toEqual({
      command: "provision",
      flags: { port: "4100", "data-dir": "C:\\Data" },
    });
  });
  it("rejects a flag without value", () => {
    expect(() => parseArgs(["provision", "--port"])).toThrow(/Missing value/);
  });
});

describe("generated configuration", () => {
  it("binds PostgreSQL to loopback only, on 5433, with full durability", () => {
    expect(POSTGRES_CONF).toContain("listen_addresses = '127.0.0.1'");
    expect(POSTGRES_CONF).toContain("port = 5433");
    expect(POSTGRES_CONF).toContain("fsync = on");
    expect(POSTGRES_CONF).toContain("synchronous_commit = on");
    expect(POSTGRES_CONF).toContain("full_page_writes = on");
  });

  it("escapes values in the Windows service file", () => {
    const xml = winswXml({
      nodeExe: "C:\\Program Files\\Alyassir\\server\\node.exe",
      mainJs: "C:\\a&b\\main.js",
      workDir: "C:\\w",
      logDir: "C:\\l",
      env: { K: `v"<>&` },
    });
    expect(xml).toContain("<startmode>Automatic</startmode>");
    expect(xml).toContain("<depend>AlyassirPostgres</depend>");
    expect(xml).toContain('"C:\\a&amp;b\\main.js"');
    expect(xml).toContain('value="v&quot;&lt;&gt;&amp;"');
  });
});

describe("installer data file (agency and first manager)", () => {
  function file(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "boot-"));
    const f = join(dir, "bootstrap.txt");
    writeFileSync(f, content, "utf8");
    return f;
  }

  it("reads Arabic text and a password with '=' and spaces, then deletes the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-"));
    const f = file(`﻿agencyName=وكالة اليسير للتأمين\r\nmanagerUsername=gerant\r\nmanagerPassword= a=b c \r\nlanguage=fr\r\nbackupDir=${dir}\r\n`);
    const b = readBootstrap(f);
    expect(b).toEqual({ agencyName: "وكالة اليسير للتأمين", managerUsername: "gerant", managerPassword: " a=b c ", language: "fr", backupDir: dir });
    expect(existsSync(f)).toBe(false);
  });

  it("refuses a short password or a missing backup folder (and still deletes the file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-"));
    const short = file(`agencyName=A\nmanagerUsername=gerant\nmanagerPassword=12345\nbackupDir=${dir}\n`);
    expect(() => readBootstrap(short)).toThrow(/too short/);
    expect(existsSync(short)).toBe(false);
    const noDir = file(`agencyName=A\nmanagerUsername=gerant\nmanagerPassword=123456\nbackupDir=${join(dir, "missing")}\n`);
    expect(() => readBootstrap(noDir)).toThrow(/Backup folder/);
  });

  it("reads back the environment of a service file (used by the update)", () => {
    const text = winswXml({ nodeExe: "n", mainJs: "m", workDir: "w", logDir: "l", env: { A: "x&y", B: 'q"<' } });
    expect(readWinswEnv(text)).toEqual({ A: "x&y", B: 'q"<' });
  });
});
