/**
 * Interface rules checked on every build (SPEC 3.1, 23, 29):
 *  - no fixed text inside components: everything goes through the translation files;
 *  - every translation key used exists in Arabic (and so in French, see packages/i18n);
 *  - only logical direction classes (ms-/me-/start/end), never left/right.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ar } from "@alyassir/i18n";
import { businessDayBound, formatDateTime } from "./lib/format";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [p] : [];
  });
}

const SOURCES = [...files(join(__dirname)), ...files(join(__dirname, "..", "..", "..", "packages", "ui", "src"))];

function has(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null || !(part in cur)) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string";
}

describe("interface quality", () => {
  it("no fixed text between JSX tags", () => {
    const offenders: string[] = [];
    for (const file of SOURCES.filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(file, "utf8");
      // Text directly between > and < containing letters (Latin or Arabic), not inside {...}.
      for (const m of src.matchAll(/(.)>([^<>{}\n]*[A-Za-z\u0600-\u06FF]{2,}[^<>{}\n]*)<(\/?)/g)) {
        const before = m[1] ?? "";
        const raw = m[2] ?? "";
        const closing = m[3] === "/";
        // TypeScript, not JSX: "=> api<T>(...)" (arrow) or "Promise<T>" (a generic right after a name).
        if (before === "=" || (/\w$/.test(raw) && !closing)) continue;
        const text = raw.trim();
        offenders.push(`${file}: "${text}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every translation key used exists in the Arabic file", () => {
    const missing: string[] = [];
    for (const file of SOURCES) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)) {
        if (m[1] && !has(ar, m[1])) missing.push(`${file}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("only logical direction classes (works in Arabic and French)", () => {
    const physical = /(?<![\w-])(?:-?(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br)-[\w./[\]]+|text-left|text-right|float-left|float-right)(?![\w-])/g;
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{cn\(([^)]*)\)\}|\{`([^`]*)`\})/g)) {
        const classes = m[1] ?? m[2] ?? m[3] ?? "";
        const hits = classes.match(physical);
        if (hits) offenders.push(`${file}: ${hits.join(" ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("dates", () => {
  it("are shown DD/MM/YYYY in Casablanca time", () => {
    expect(formatDateTime("2026-10-27T09:05:00Z")).toMatch(/^27\/10\/2026 \d{2}:05$/);
  });

  it("a business day starts at midnight Casablanca, whatever the season", () => {
    for (const day of ["2026-01-15", "2026-03-01", "2026-07-15", "2026-10-27"]) {
      const start = businessDayBound(day, false);
      const end = businessDayBound(day, true);
      expect(start).toBeDefined();
      expect(formatDateTime(start)).toBe(`${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)} 00:00`);
      expect(formatDateTime(end)).toBe(`${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)} 23:59`);
    }
    expect(businessDayBound("27/10/2026", false)).toBeUndefined();
  });
});
