#!/usr/bin/env node
// Builds catalog-cards.json: every Cardmarket single with the TCGdex cards that claim it.
// Re-runs only touch records for new products or whose claims changed; unchanged ones are kept as they are.
//
//   node scripts/build-catalog-cards.mjs <tcgdex cards-database checkout> [--out file] [--full] [--dry-run]
//
// Never edits mapping/cards.json or the price files.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { ROOT, readJson, writeJson } from "./lib.mjs";
import {
  buildCatalogCards,
  newSingleIds,
  readTcgdex,
} from "./catalog-cards-lib.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, fallback) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SRC = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (!SRC) {
  console.error(
    "Usage: node scripts/build-catalog-cards.mjs <tcgdex checkout> [--out file] [--full] [--dry-run]",
  );
  process.exit(1);
}

const out = path.resolve(opt("out", path.join(ROOT, "catalog-cards.json")));
const catalog = await readJson(path.join(ROOT, "catalog", "products.json"));
if (!catalog)
  throw new Error("catalog/products.json is missing; run the price job first");

let rev = null;
try {
  rev = execFileSync("git", ["-C", SRC, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
} catch {
  /* not a git checkout */
}

// overrides.json: { "<cardmarket id>": { "card": "base5-5", "number": "5/82", "variant": "Holo", "note": "..." } }
const overrides = (await readJson(path.join(ROOT, "overrides.json"))) ?? {};
const overridesHash = createHash("sha1")
  .update(JSON.stringify(overrides))
  .digest("hex")
  .slice(0, 12);

const previous = flag("full") ? null : await readJson(out);
const fresh = newSingleIds(catalog, previous);
if (
  previous &&
  !fresh.length &&
  rev &&
  previous.tcgdexRev === rev &&
  previous.overridesHash === overridesHash
) {
  console.log(
    `Up to date: no new Cardmarket singles and TCGdex is still at ${rev.slice(0, 7)}.`,
  );
  process.exit(0);
}

console.log(
  previous
    ? `${fresh.length} new singles; re-checking claims against TCGdex ${rev?.slice(0, 7) ?? ""}`
    : "Building from scratch",
);
const tcgdex = await readTcgdex(SRC);
const { output, stats } = buildCatalogCards({
  catalog,
  tcgdex,
  previous,
  tcgdexRev: rev,
  overrides,
  catalogVersion: catalog.updatedAt ?? null,
});

console.log(
  `Singles: ${stats.singles}  added: ${stats.added}  updated: ${stats.updated}  unchanged: ${stats.unchanged}  removed: ${stats.removed}  inferred-by-order: ${stats.inferred}  manual: ${stats.manual}`,
);
if (stats.unknownOverrides.length)
  console.log(
    `  Ignored overrides (unknown product or no card): ${stats.unknownOverrides.join(", ")}`,
  );
console.log(
  "Status:",
  Object.entries(output.byStatus)
    .map(([k, v]) => `${k} ${v}`)
    .join(", "),
);
if (stats.orphanClaims)
  console.log(
    `  ${stats.orphanClaims} TCGdex-claimed products are not in the current catalogue`,
  );
if (flag("dry-run")) console.log("Dry run: nothing written.");
else {
  await writeJson(out, output);
  console.log(`Wrote ${path.relative(ROOT, out)}`);
}
