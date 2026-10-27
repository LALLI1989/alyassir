// Dependency boundaries (SPEC 24): the desktop app must never import the database
// or the financial domain package. Fails the build otherwise.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const forbidden = ["@alyassir/db", "@alyassir/domain", "pg", "drizzle-orm"];
const errors = [];
const pkg = JSON.parse(readFileSync("apps/desktop/package.json", "utf8"));
for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (forbidden.includes(dep)) errors.push(`apps/desktop/package.json depends on ${dep}`);
}
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name)) {
      const src = readFileSync(p, "utf8");
      for (const f of forbidden) {
        if (src.includes(`from "${f}`) || src.includes(`from '${f}`)) errors.push(`${p} imports ${f}`);
      }
    }
  }
}
walk("apps/desktop/src");
walk("packages/ui/src");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Dependency boundaries OK");
