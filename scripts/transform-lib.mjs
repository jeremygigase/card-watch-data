// Read-only join of TCGdex cards, mapping/cards.json, the Cardmarket catalog and price files.
// Never picks a product when the sources can't establish it. Node 20+, no dependencies.

export const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

// "Dark Dragonite [Summon Minions | Giant Tail]" -> { base, tokens }
export function parseProductName(full) {
  const m = /^(.*?)\s*\[(.*)\]\s*$/.exec(full);
  return {
    base: norm(m ? m[1] : full),
    tokens: m ? m[2].split("|").map(norm).filter(Boolean).sort().join("|") : "",
  };
}

export const movesKey = (names) =>
  (names ?? []).map(norm).filter(Boolean).sort().join("|");

export function indexCatalog(cat) {
  const f = (n) => cat.fields.indexOf(n);
  const [iId, iName, iExp, iCat, iCatName, iMeta, iAdded] = [
    "idProduct",
    "name",
    "idExpansion",
    "idCategory",
    "categoryName",
    "idMetacard",
    "dateAdded",
  ].map(f);
  const byId = new Map();
  const groups = new Map();
  for (const r of cat.rows) {
    const { base, tokens } = parseProductName(r[iName]);
    const row = {
      idProduct: r[iId],
      name: r[iName],
      idExpansion: r[iExp],
      idCategory: r[iCat],
      categoryName: r[iCatName],
      idMetacard: r[iMeta],
      dateAdded: r[iAdded],
      base,
      tokens,
    };
    byId.set(row.idProduct, row);
    if (row.categoryName !== "Pokémon Single") continue;
    const key = `${row.idExpansion}|${base}|${tokens}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return { byId, groups };
}

// idProduct -> sorted card ids that point at it (card-level and per-variant ids).
export function claimsByProduct(mapping) {
  const claims = new Map();
  const add = (product, cardId) => {
    if (!claims.has(product)) claims.set(product, new Set());
    claims.get(product).add(cardId);
  };
  for (const [cardId, [product]] of Object.entries(mapping.cards ?? {}))
    add(product, cardId);
  for (const [cardId, byType] of Object.entries(mapping.variants ?? {}))
    for (const product of Object.values(byType)) add(product, cardId);
  return claims;
}

export function sharedProductSummary(mapping) {
  const shared = [...claimsByProduct(mapping)].filter(
    ([, cards]) => cards.size > 1,
  );
  return {
    sharedProducts: shared.length,
    cardsInvolved: new Set(shared.flatMap(([, c]) => [...c])).size,
  };
}

const expOfFile = (file) => {
  const m = /^e(\d+)$/.exec(file ?? "");
  return m ? Number(m[1]) : null;
};

function priceOf(id, file, sources) {
  const latest = sources.latest?.[file];
  const lRow = latest?.p?.[id];
  const hist = sources.history?.[file]?.p?.[id];
  return {
    day: latest?.day ?? null,
    latest: lRow
      ? Object.fromEntries(latest.fields.map((f, i) => [f, lRow[i]]))
      : null,
    history: hist
      ? hist.map((p) =>
          Object.fromEntries([
            ["day", p[0]],
            ...sources.history[file].fields.map((f, i) => [f, p[i + 1]]),
          ]),
        )
      : null,
  };
}

const ev = (field, result, detail) => ({ field, result, detail });

function variantTypes(card) {
  const v = card.variants ?? {};
  return Object.keys(v).filter(
    (k) => v[k] === true && k !== "firstEdition" && k !== "wPromo",
  );
}

export function buildRecord(card, sources, indexes) {
  const { catalog, claims } = indexes;
  const entry = sources.mapping.cards?.[card.id] ?? null;
  const mapped = entry?.[0] ?? null;
  const file = entry?.[1] ?? null;
  const mappedRow = mapped != null ? (catalog.byId.get(mapped) ?? null) : null;
  const cardBase = norm(card.name);
  const cardMoves = movesKey(
    [...(card.abilities ?? []), ...(card.attacks ?? [])].map((x) => x.name),
  );
  const expansion = expOfFile(file) ?? mappedRow?.idExpansion ?? null;

  const found = new Map();
  for (const r of catalog.groups.get(`${expansion}|${cardBase}|${cardMoves}`) ??
    [])
    found.set(r.idProduct, r);
  if (mappedRow) found.set(mappedRow.idProduct, mappedRow);
  const rows = [...found.values()].sort((a, b) => a.idProduct - b.idProduct);
  const allSameMeta =
    rows.length > 1 && rows.every((r) => r.idMetacard === rows[0].idMetacard);

  const candidates = rows.map((r) => {
    const claimedBy = [...(claims.get(r.idProduct) ?? [])].sort();
    const evidence = [
      ev(
        "name",
        r.base === cardBase ? "supports" : "fails",
        `${r.name} vs ${card.name}`,
      ),
      ev(
        "moves",
        r.tokens === cardMoves ? "supports" : "fails",
        `catalog "${r.tokens}" vs card "${cardMoves}"`,
      ),
      ev(
        "expansion",
        r.idExpansion === expansion ? "supports" : "fails",
        `catalog ${r.idExpansion} vs mapping file ${file}`,
      ),
      ev(
        "category",
        r.categoryName === "Pokémon Single" ? "supports" : "fails",
        r.categoryName,
      ),
      ev(
        "idMetacard",
        allSameMeta ? "not-discriminating" : "unavailable",
        allSameMeta
          ? `all candidates share ${r.idMetacard}`
          : String(r.idMetacard),
      ),
      ev(
        "dateAdded",
        String(r.dateAdded).startsWith("0000")
          ? "unavailable"
          : "not-discriminating",
        String(r.dateAdded),
      ),
      ev(
        "collectorNumber",
        "unavailable",
        `catalog has no number; card is ${card.localId}`,
      ),
      ev(
        "finish",
        "unavailable",
        `catalog has no finish; card is ${variantTypes(card).join("+") || "unknown"}`,
      ),
      ev(
        "mapping",
        r.idProduct === mapped
          ? "supports"
          : claimedBy.length
            ? "fails"
            : "unavailable",
        r.idProduct === mapped
          ? "mapping/cards.json points here"
          : claimedBy.length
            ? `mapping points ${claimedBy.join(", ")} here instead`
            : "no mapping entry points here",
      ),
    ];
    return {
      ...r,
      claimedBy,
      inMapping: claimedBy.length > 0,
      price: priceOf(r.idProduct, bucket(r, file), sources),
      evidence,
    };
  });

  const flags = [];
  const mappedClaims = mapped != null ? [...(claims.get(mapped) ?? [])] : [];
  if (mapped == null) flags.push("unmapped");
  else if (!mappedRow) flags.push("missing-product");
  if (mappedClaims.length > 1) flags.push("shared-product-id");
  if (candidates.length > 1) flags.push("same-name-in-expansion");
  if (candidates.some((c) => !c.inMapping)) flags.push("unclaimed-candidate");
  if (mapped != null && !priceOf(mapped, file, sources).latest)
    flags.push("missing-price");

  const clean =
    candidates.length === 1 &&
    candidates[0].idProduct === mapped &&
    candidates[0].evidence
      .filter((e) =>
        ["name", "moves", "expansion", "category"].includes(e.field),
      )
      .every((e) => e.result === "supports") &&
    mappedClaims.length === 1;
  const hint = (sources.hints ?? []).find((h) => h.cardId === card.id) ?? null;

  return {
    cardId: card.id,
    name: card.name,
    set: { id: card.set?.id, name: card.set?.name },
    localId: card.localId,
    number: card.set?.cardCount?.official
      ? `${card.localId}/${card.set.cardCount.official}`
      : card.localId,
    variants: variantTypes(card),
    firstEdition: card.variants?.firstEdition === true,
    mappedProduct: mapped,
    mappedFile: file,
    mappingVariants: sources.mapping.variants?.[card.id] ?? null,
    candidates,
    flags,
    status: mapped == null ? "unmapped" : clean ? "confirmed" : "ambiguous",
    resolved: clean ? mapped : null,
    unverifiedHint: hint,
  };
}

// Price files are keyed by the mapping's file name; unmapped candidates use their own expansion.
const bucket = (row, file) =>
  file && expOfFile(file) === row.idExpansion ? file : `e${row.idExpansion}`;

export function buildRecords(cards, sources) {
  const indexes = {
    catalog: indexCatalog(sources.catalog),
    claims: claimsByProduct(sources.mapping),
  };
  return cards.map((c) => buildRecord(c, sources, indexes));
}

export function neededToResolve(record) {
  const need = [];
  if (
    record.flags.includes("shared-product-id") ||
    record.flags.includes("same-name-in-expansion")
  )
    need.push(
      "A Cardmarket per-product print attribute (version/edition, collector number or finish) that the catalog does not provide.",
    );
  if (record.flags.includes("shared-product-id"))
    need.push(
      "A TCGdex variant-level Cardmarket id for each of the cards that share the product.",
    );
  if (record.flags.includes("unclaimed-candidate"))
    need.push(
      "Evidence tying each unclaimed candidate product to a specific card and finish (for example the product page or a reviewed override).",
    );
  if (
    record.flags.includes("missing-product") ||
    record.flags.includes("missing-price")
  )
    need.push(
      "A refreshed catalog or price file that contains the mapped product.",
    );
  return need;
}
