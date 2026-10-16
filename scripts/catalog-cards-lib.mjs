// Bulk join: every Cardmarket single -> the TCGdex cards that claim it. Read-only on the sources.
// A product is only "confirmed" when TCGdex's own ids settle it; otherwise it stays ambiguous or unclaimed.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseCardFile } from "./mapping-lib.mjs";
import { norm, movesKey, indexCatalog } from "./transform-lib.mjs";

const STR = `(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`;
const EN_NAME = new RegExp(`\\bname\\s*:\\s*\\{[^{}]*?\\ben\\s*:\\s*${STR}`);
const EN_NAME_G = new RegExp(
  `\\bname\\s*:\\s*\\{[^{}]*?\\ben\\s*:\\s*${STR}`,
  "g",
);
const unq = (m) => (m ? String(m[1] ?? m[2]).replace(/\\(.)/g, "$1") : null);

function matchBracket(text, start) {
  const open = text[start],
    close = open === "[" ? "]" : "}";
  let depth = 0,
    quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

function namesIn(text, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(text);
  if (!m) return [];
  const start = m.index + m[0].length - 1;
  const end = matchBracket(text, start);
  if (end < 0) return [];
  return [...text.slice(start, end + 1).matchAll(EN_NAME_G)].map((x) => unq(x));
}

export function parseSetFile(text) {
  return {
    id: (/\bid\s*:\s*["']([^"']+)["']/.exec(text) || [])[1] ?? null,
    name: unq(EN_NAME.exec(text)),
    official:
      Number(
        (/cardCount\s*:\s*\{[^{}]*?official\s*:\s*(\d+)/.exec(text) || [])[1],
      ) || null,
    expansion:
      Number(
        (/thirdParty\s*:\s*\{[^{}]*?cardmarket\s*:\s*(\d+)/.exec(text) ||
          [])[1],
      ) || null,
  };
}

export function parseCardDetails(text) {
  const { cardLevel, variants } = parseCardFile(text);
  const ids = [];
  if (cardLevel != null) ids.push({ product: cardLevel, variant: "card" });
  for (const v of variants)
    ids.push({ product: v.id, variant: [v.type, ...v.stamps].join("+") });
  return {
    name: unq(EN_NAME.exec(text)),
    moves: movesKey([
      ...namesIn(text, "abilities"),
      ...namesIn(text, "attacks"),
    ]),
    ids,
  };
}

const dirs = async (p) =>
  (await readdir(p, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
const tsFiles = async (p) =>
  (await readdir(p, { withFileTypes: true }))
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => d.name);

// Reads <checkout>/data/<Serie>/<Set>.ts and <Set>/<localId>.ts.
export async function readTcgdex(checkout) {
  const data = path.join(checkout, "data");
  const sets = {},
    cards = [];
  for (const serie of await dirs(data)) {
    for (const setName of await dirs(path.join(data, serie))) {
      let setText;
      try {
        setText = await readFile(
          path.join(data, serie, setName + ".ts"),
          "utf8",
        );
      } catch {
        continue;
      }
      const set = parseSetFile(setText);
      if (!set.id) continue;
      sets[set.id] = set;
      const dir = path.join(data, serie, setName);
      const files = await tsFiles(dir);
      for (let i = 0; i < files.length; i += 64) {
        const batch = await Promise.all(
          files.slice(i, i + 64).map(async (f) => {
            const d = parseCardDetails(
              await readFile(path.join(dir, f), "utf8"),
            );
            return {
              id: `${set.id}-${f.slice(0, -3)}`,
              localId: f.slice(0, -3),
              setId: set.id,
              ...d,
            };
          }),
        );
        cards.push(...batch);
      }
    }
  }
  return { sets, cards };
}

const sha = (v) =>
  createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const NEIGHBOURS = 3;

/* Same-name products in one expansion are numbered in card-number order, so when a group has as many
   products as same-name cards in one TCGdex set, pair them by order. Only used when the catalog's own
   product names line up with the set's card names at that offset (id = number + offset). Marks the
   group "inferred-by-order"; never "confirmed". */
function inferByOrder(pending, index, tcgdex) {
  const cardsBySet = new Map();
  for (const c of tcgdex.cards) {
    if (!cardsBySet.has(c.setId)) cardsBySet.set(c.setId, []);
    cardsBySet.get(c.setId).push(c);
  }
  const seen = new Set();
  let marked = 0;
  for (const [id, { group, body }] of pending) {
    if (seen.has(id) || group.length < 2 || body.status !== "ambiguous")
      continue;
    group.forEach((g) => seen.add(g.idProduct));
    const products = group.map((g) => g.idProduct).sort((a, b) => a - b);
    const claimers = new Set(
      products.flatMap(
        (p) => pending.get(p)?.body.claims.map((c) => c.card) ?? [],
      ),
    );
    const sample = group[0];
    const sets = new Set(
      [...claimers].map((c) => tcgdex.cards.find((x) => x.id === c)?.setId),
    );
    if (sets.size !== 1) continue;
    const [setId] = sets;
    if (tcgdex.sets[setId]?.expansion !== sample.idExpansion) continue;
    const setCards = cardsBySet.get(setId) ?? [];
    const same = setCards.filter(
      (c) =>
        c.name != null &&
        norm(c.name) === sample.base &&
        c.moves === sample.tokens,
    );
    if (
      same.length !== products.length ||
      [...claimers].some((c) => !same.some((s) => s.id === c))
    )
      continue;
    if (same.some((c) => !/^\d+$/.test(c.localId))) continue;
    const ordered = [...same].sort(
      (a, b) => Number(a.localId) - Number(b.localId),
    );
    if (new Set(ordered.map((c) => c.localId)).size !== ordered.length)
      continue;

    const pairs = ordered.map((card, i) => ({ card, product: products[i] }));
    const checks = pairs.map(({ card, product }) => {
      const offset = product - Number(card.localId);
      let aligned = 0,
        misaligned = 0;
      for (const d of setCards) {
        const delta = Number(d.localId) - Number(card.localId);
        if (
          d === card ||
          !/^\d+$/.test(d.localId) ||
          Math.abs(delta) > NEIGHBOURS ||
          d.name == null
        )
          continue;
        const row = index.byId.get(Number(d.localId) + offset);
        if (!row || row.categoryName !== "Pokémon Single") continue;
        if (row.base === norm(d.name) && row.tokens === d.moves) aligned++;
        else misaligned++;
      }
      return { offset, aligned, misaligned };
    });
    if (!checks.every((c) => c.aligned >= 2 && c.misaligned === 0)) continue;

    for (const [i, { card, product }] of pairs.entries()) {
      const rec = pending.get(product);
      rec.body.status = "inferred-by-order";
      rec.body.inferred = {
        card: card.id,
        number: `${card.localId}/${tcgdex.sets[setId].official ?? ""}`.replace(
          /\/$/,
          "",
        ),
        variants: [...new Set(card.ids.map((x) => x.variant))],
        offset: checks[i].offset,
        alignedNeighbours: checks[i].aligned,
      };
      const claimed = rec.body.claims.some((c) => c.card === card.id);
      if (!claimed) rec.body.flags.push("tcgdex-claim-differs");
      marked++;
    }
  }
  return marked;
}

export function buildCatalogCards({
  catalog,
  tcgdex,
  previous = null,
  tcgdexRev = null,
  catalogVersion = null,
  overrides = {},
  now = new Date().toISOString().slice(0, 10),
}) {
  const index = indexCatalog(catalog);
  const claims = new Map();
  for (const card of tcgdex.cards) {
    const set = tcgdex.sets[card.setId];
    for (const { product, variant } of card.ids) {
      if (!claims.has(product)) claims.set(product, new Map());
      const byCard = claims.get(product);
      if (!byCard.has(card.id))
        byCard.set(card.id, {
          card: card.id,
          number: set?.official
            ? `${card.localId}/${set.official}`
            : card.localId,
          variants: [],
          _c: card,
          _s: set,
        });
      byCard.get(card.id).variants.push(variant);
    }
  }
  const claimsOf = (id) =>
    [...(claims.get(id)?.values() ?? [])].sort((a, b) =>
      a.card < b.card ? -1 : 1,
    );

  const records = {};
  const pending = new Map();
  const stats = {
    singles: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    orphanClaims: 0,
    manual: 0,
    unknownOverrides: [],
  };
  const prev = previous?.records ?? {};
  for (const row of index.byId.values()) {
    if (row.categoryName !== "Pokémon Single") continue;
    stats.singles++;
    const group = index.groups.get(
      `${row.idExpansion}|${row.base}|${row.tokens}`,
    ) ?? [row];
    const mine = claimsOf(row.idProduct);
    const flags = [];
    if (mine.length > 1) flags.push("shared-product-id");
    if (group.length > 1) flags.push("same-name-in-expansion");
    const groupClaims = group.map((g) => claimsOf(g.idProduct));
    if (!mine.length && groupClaims.some((c) => c.length))
      flags.push("unclaimed-sibling");
    const checked = mine.map((c) => {
      const nameMatch =
        c._c.name == null
          ? null
          : norm(c._c.name) === row.base && c._c.moves === row.tokens;
      const expansionMatch =
        c._s?.expansion == null ? null : c._s.expansion === row.idExpansion;
      return {
        card: c.card,
        number: c.number,
        variants: c.variants,
        nameMatch,
        expansionMatch,
      };
    });
    if (checked.some((c) => c.nameMatch === false))
      flags.push("claim-name-mismatch");
    if (checked.some((c) => c.expansionMatch === false))
      flags.push("claim-expansion-mismatch");

    const everyoneUnique =
      groupClaims.every((c) => c.length === 1) &&
      new Set(groupClaims.flat().map((c) => c.card)).size === group.length;
    const status =
      !mine.length && !groupClaims.some((c) => c.length)
        ? "unclaimed"
        : mine.length === 1 &&
            everyoneUnique &&
            !flags.includes("claim-name-mismatch") &&
            !flags.includes("claim-expansion-mismatch")
          ? "confirmed"
          : "ambiguous";

    pending.set(row.idProduct, {
      group,
      body: {
        name: row.name,
        expansion: row.idExpansion,
        status,
        flags,
        claims: checked,
      },
    });
  }

  stats.inferred = inferByOrder(pending, index, tcgdex);

  // Hand-made decisions win over every computed status.
  for (const [id, o] of Object.entries(overrides)) {
    const rec = pending.get(Number(id));
    if (!rec || !o?.card) {
      stats.unknownOverrides.push(id);
      continue;
    }
    rec.body.status = "manual";
    rec.body.manual = { ...o };
    delete rec.body.inferred;
    stats.manual++;
  }

  for (const [id, { group, body }] of pending) {
    const fp = sha([body, group.map((g) => g.idProduct)]);
    const old = prev[id];
    if (!old) {
      records[id] = { ...body, fp, firstSeen: now, updatedAt: now };
      stats.added++;
    } else if (old.fp === fp) {
      records[id] = old;
      stats.unchanged++;
    } else {
      records[id] = { ...body, fp, firstSeen: old.firstSeen, updatedAt: now };
      stats.updated++;
    }
  }
  for (const id of Object.keys(prev)) if (!records[id]) stats.removed++;
  for (const id of claims.keys()) if (!index.byId.has(id)) stats.orphanClaims++;

  const byStatus = {};
  for (const r of Object.values(records))
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    output: {
      version: now,
      source: "https://github.com/tcgdex/cards-database",
      tcgdexRev,
      catalogVersion,
      overridesHash: sha(overrides),
      count: stats.singles,
      byStatus,
      records,
    },
    stats,
  };
}

export const newSingleIds = (catalog, previous) => {
  const index = indexCatalog(catalog);
  return [...index.byId.values()]
    .filter(
      (r) =>
        r.categoryName === "Pokémon Single" &&
        !previous?.records?.[r.idProduct],
    )
    .map((r) => r.idProduct);
};
