/**
 * The interface texts (packages/i18n), read by the server for reports and Excel files, so a report
 * uses exactly the words of the screen in the chosen language (SPEC 19, 29).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

type Tree = { [key: string]: string | Tree };
export type Lang = "ar" | "fr";

const load = createRequire(join(__dirname, "texts.js"));
const cache = new Map<Lang, Tree>();

function tree(lang: Lang): Tree {
  let t = cache.get(lang);
  if (!t) {
    t = JSON.parse(readFileSync(load.resolve(`@alyassir/i18n/src/${lang}.json`), "utf8")) as Tree;
    cache.set(lang, t);
  }
  return t;
}

/** Text for a key ("a.b.c") with {{name}} values; the fallback (or the key) when missing. */
export function tr(lang: Lang, key: string, values: Record<string, string | number> = {}, fallback?: string): string {
  let cur: string | Tree | undefined = tree(lang);
  for (const part of key.split(".")) {
    cur = typeof cur === "object" ? cur[part] : undefined;
    if (cur === undefined) break;
  }
  const text = typeof cur === "string" ? cur : (fallback ?? key);
  return text.replace(/\{\{(\w+)\}\}/g, (all, name: string) => (name in values ? String(values[name]) : all));
}

/** A code translated under a prefix (statuses, methods…), or the code itself if unknown. */
export function word(lang: Lang, prefix: string, code: string | null | undefined): string {
  if (code === null || code === undefined || code === "") return "";
  return tr(lang, `${prefix}.${code}`, {}, code);
}
