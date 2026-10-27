import { describe, expect, it } from "vitest";
import ar from "./ar.json";
import fr from "./fr.json";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("translations", () => {
  it("Arabic and French have exactly the same keys", () => {
    expect(keys(ar).sort()).toEqual(keys(fr).sort());
  });

  it("no translation is empty", () => {
    for (const lang of [ar, fr]) {
      for (const key of keys(lang)) {
        const value = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], lang);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });
});
