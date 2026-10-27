import { describe, expect, it } from "vitest";
import ar from "./ar.json";
import fr from "./fr.json";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function value(obj: object, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);
}

describe("translations (SPEC 29)", () => {
  it("Arabic and French have exactly the same keys", () => {
    expect(keys(fr).sort()).toEqual(keys(ar).sort());
  });

  it("no translation is empty", () => {
    for (const lang of [ar, fr]) {
      for (const key of keys(lang)) {
        const v = value(lang, key);
        expect(typeof v === "string" && v.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("no key contains a dot (the dot separates levels)", () => {
    const bad = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => [...(k.includes(".") ? [k] : []), ...(typeof v === "object" && v ? bad(v) : [])]);
    expect(bad(ar)).toEqual([]);
  });

  it("the same placeholders exist in both languages", () => {
    for (const key of keys(ar)) {
      const vars = (s: unknown) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
      expect(vars(value(fr, key)), key).toEqual(vars(value(ar, key)));
    }
  });

  it("uses the glossary terms (SPEC 29)", () => {
    expect(ar.modules.policies).toBe("البوالص");
    expect(fr.modules.policies).toBe("Polices");
    expect(fr.modules.claims).toBe("Sinistres");
    expect(fr.modules.closing).toBe("Clôture de caisse");
    expect(fr.shell.managerBadge).toBe("Gérant");
    expect(fr.shell.supervisorBadge).toBe("Superviseur");
    expect(fr.shell.employeeBadge).toBe("Employé");
  });
});
