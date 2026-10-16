#!/usr/bin/env node
// Report only: joins TCGdex cards, the mapping, the catalog and prices, and flags what is ambiguous.
//   node scripts/transform-report.mjs [--source fixtures|repo] [--cards base5-5,base5-22] [--json]
// Writes nothing. The TCGdex cards always come from test/fixtures/tcgdex.
import { loadSources, loadTcgdexCards } from "./transform-sources.mjs";
import {
  buildRecords,
  neededToResolve,
  sharedProductSummary,
} from "./transform-lib.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : fallback;
};
const source = opt("source", "fixtures");
const ids = opt("cards", "base5-5,base5-22").split(",").filter(Boolean);

const sources = await loadSources(source);
const records = buildRecords(await loadTcgdexCards(ids), sources);

if (args.includes("--json")) {
  console.log(JSON.stringify({ source, records }, null, 2));
  process.exit(0);
}

const money = (v) => (v == null ? "-" : v.toFixed(2));
console.log(`Transform report (source: ${source})`);
if (source === "repo") {
  const s = sharedProductSummary(sources.mapping);
  console.log(
    `Mapping-wide: ${s.sharedProducts} products are claimed by more than one card (${s.cardsInvolved} cards).`,
  );
}
for (const r of records) {
  console.log(
    `\n${r.cardId}  ${r.name}  ${r.number}  ${r.set.name}  [${r.variants.join("+") || "?"}${r.firstEdition ? ", 1st edition exists" : ""}]`,
  );
  console.log(
    `  mapped product: ${r.mappedProduct ?? "none"} (file ${r.mappedFile ?? "-"})  status: ${r.status.toUpperCase()}  resolved: ${r.resolved ?? "none"}`,
  );
  console.log(`  flags: ${r.flags.join(", ") || "none"}`);
  for (const c of r.candidates) {
    const l = c.price.latest;
    console.log(
      `  candidate ${c.idProduct}  ${c.name}  claimed by: ${c.claimedBy.join(", ") || "nobody"}`,
    );
    console.log(
      `    price ${c.price.day ?? "-"}: trend ${money(l?.trend)}  trend-holo ${money(l?.["trend-holo"])}  low ${money(l?.low)}  (${c.price.history?.length ?? 0} history points)`,
    );
    for (const e of c.evidence)
      console.log(
        `    ${e.result.padEnd(18)} ${e.field.padEnd(16)} ${e.detail}`,
      );
  }
  if (r.unverifiedHint)
    console.log(
      `  unverified app hint (not used): ${r.unverifiedHint.from} -> ${r.unverifiedHint.to} for ${r.unverifiedHint.variant}`,
    );
  const need = neededToResolve(r);
  if (need.length)
    console.log(
      "  needed to resolve:\n" + need.map((n) => `    - ${n}`).join("\n"),
    );
}
