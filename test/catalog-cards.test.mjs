import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { FIXTURES } from "../scripts/transform-sources.mjs";
import {
  buildCatalogCards,
  newSingleIds,
  parseCardDetails,
  readTcgdex,
} from "../scripts/catalog-cards-lib.mjs";

const checkout = path.join(FIXTURES, "tcgdex-ts");
const catalog = JSON.parse(
  await readFile(path.join(FIXTURES, "catalog.json"), "utf8"),
);
const tcgdex = await readTcgdex(checkout);
const build = (extra = {}) =>
  buildCatalogCards({ catalog, tcgdex, now: "2026-10-16", ...extra });

test("reads TCGdex names, moves, set data and every variant id", () => {
  const r22 = tcgdex.cards.find((c) => c.id === "base5-22");
  assert.equal(r22.name, "Dark Dragonite");
  assert.equal(r22.moves, "gianttail|summonminions");
  assert.deepEqual(r22.ids, [
    { product: 274058, variant: "normal" },
    { product: 274058, variant: "normal+1st-edition" },
  ]);
  assert.deepEqual(tcgdex.sets.base5, {
    id: "base5",
    name: "Team Rocket",
    official: 82,
    expansion: 1528,
  });
  assert.equal(tcgdex.cards.find((c) => c.id === "base5-5").ids.length, 2);
});

test("card-level Cardmarket ids count as claims", () => {
  assert.deepEqual(
    parseCardDetails('name: { en: "X" }, thirdParty: { cardmarket: 5 }').ids,
    [{ product: 5, variant: "card" }],
  );
});

test("Dark Dragonite: 274058 is claimed twice, 274075 has no claim, both stay ambiguous", () => {
  const { records } = build().output;
  const a = records[274058];
  assert.equal(a.status, "ambiguous");
  assert.deepEqual(
    a.claims.map((c) => [c.card, c.number]),
    [
      ["base5-22", "22/82"],
      ["base5-5", "5/82"],
    ],
  );
  assert.deepEqual(a.claims.find((c) => c.card === "base5-5").variants, [
    "holo",
    "holo+1st-edition",
  ]);
  assert.ok(
    a.flags.includes("shared-product-id") &&
      a.flags.includes("same-name-in-expansion"),
  );
  const b = records[274075];
  assert.equal(b.status, "ambiguous");
  assert.deepEqual(b.claims, []);
  assert.ok(b.flags.includes("unclaimed-sibling"));
});

test("products nobody claims are unclaimed, and a clean one-to-one card is confirmed", () => {
  const { records } = build().output;
  assert.equal(records[274057].status, "unclaimed");
  assert.equal(records[274074].status, "unclaimed");
  assert.equal(records[999001].status, "confirmed");
  assert.equal(records[999001].claims[0].number, "1/10");
});

test("a claim whose name does not match the product blocks confirmation", () => {
  const odd = {
    ...tcgdex,
    cards: tcgdex.cards.map((c) =>
      c.id === "ctl-1" ? { ...c, name: "Other Card" } : c,
    ),
  };
  const { records } = buildCatalogCards({
    catalog,
    tcgdex: odd,
    now: "2026-10-16",
  }).output;
  assert.equal(records[999001].status, "ambiguous");
  assert.ok(records[999001].flags.includes("claim-name-mismatch"));
});

test("a second run changes nothing; a new product is the only addition", () => {
  const first = build();
  assert.equal(first.stats.added, 5);
  const again = build({ previous: first.output, now: "2026-10-20" });
  assert.deepEqual(
    [again.stats.added, again.stats.updated, again.stats.unchanged],
    [0, 0, 5],
  );
  assert.deepEqual(again.output.records, first.output.records);

  const grown = {
    ...catalog,
    rows: [
      ...catalog.rows,
      [
        274076,
        "Dark Dugtrio [Sinkhole | Knock Down]",
        1528,
        51,
        "Pokémon Single",
        211937,
        "0000-00-00 00:00:00",
      ],
    ],
  };
  assert.deepEqual(newSingleIds(grown, first.output), [274076]);
  const next = buildCatalogCards({
    catalog: grown,
    tcgdex,
    previous: first.output,
    now: "2026-10-21",
  });
  assert.deepEqual(
    [next.stats.added, next.stats.updated, next.stats.unchanged],
    [1, 0, 5],
  );
  assert.equal(next.output.records[274076].firstSeen, "2026-10-21");
  assert.equal(next.output.records[274058].firstSeen, "2026-10-16");
});

test("when TCGdex changes a claim only the affected records are updated", () => {
  const first = build();
  const moved = {
    ...tcgdex,
    cards: tcgdex.cards.map((c) =>
      c.id === "base5-22"
        ? { ...c, ids: [{ product: 274075, variant: "normal" }] }
        : c,
    ),
  };
  const next = buildCatalogCards({
    catalog,
    tcgdex: moved,
    previous: first.output,
    now: "2026-10-25",
  });
  assert.equal(next.stats.updated, 2);
  assert.equal(next.output.records[274058].status, "confirmed");
  assert.equal(next.output.records[274075].status, "confirmed");
  assert.equal(next.output.records[274058].updatedAt, "2026-10-25");
  assert.equal(next.output.records[274058].firstSeen, "2026-10-16");
  assert.equal(next.output.records[999001], first.output.records[999001]);
});

// In-memory Team Rocket slice: holo products are 274053+number, non-holo continue the same numbering.
const rocket = () => {
  const names = { 4: ["Dark Charizard", "Nail Flick|Continuous Fireball"], 5: ["Dark Dragonite", "Summon Minions|Giant Tail"], 6: ["Dark Dugtrio", "Sinkhole|Knock Down"] };
  const cardList = [];
  const rows = [];
  for (const n of [4, 5, 6, 21, 22, 23]) {
    const [name, moves] = names[n > 17 ? n - 17 : n];
    const holo = n <= 17;
    cardList.push({
      id: `base5-${n}`, localId: String(n), setId: "base5", name,
      moves: moves.split("|").map((m) => m.toLowerCase().replace(/ /g, "")).sort().join("|"),
      // TCGdex repeats the holo ids for the non-holo cards (#N points at the product of #N-17).
      ids: [{ product: 274053 + (holo ? n : n - 17), variant: holo ? "holo" : "normal" }],
    });
    rows.push([274053 + n, `${name} [${moves.replace("|", " | ")}]`, 1528, 51, "Pokémon Single", 1, "0000-00-00 00:00:00"]);
  }
  return {
    catalog: { fields: ["idProduct", "name", "idExpansion", "idCategory", "categoryName", "idMetacard", "dateAdded"], rows },
    tcgdex: { sets: { base5: { id: "base5", name: "Team Rocket", official: 82, expansion: 1528 } }, cards: cardList },
  };
};

test("inferred-by-order pairs holo and non-holo cards with their products, never as confirmed", () => {
  const { output, stats } = buildCatalogCards({ ...rocket(), now: "2026-10-16" });
  const r = output.records;
  assert.equal(stats.inferred, 6);
  assert.equal(r[274058].status, "inferred-by-order");
  assert.equal(r[274058].inferred.card, "base5-5");
  assert.equal(r[274058].inferred.offset, 274053);
  assert.equal(r[274075].status, "inferred-by-order");
  assert.equal(r[274075].inferred.card, "base5-22");
  assert.equal(r[274075].inferred.number, "22/82");
  assert.deepEqual(r[274075].inferred.variants, ["normal"]);
  assert.ok(r[274075].flags.includes("tcgdex-claim-differs"));
  assert.ok(!r[274058].flags.includes("tcgdex-claim-differs"));
  assert.ok(Object.values(r).every((x) => x.status !== "confirmed"));
});

test("order inference is skipped when neighbouring names do not line up", () => {
  const data = rocket();
  data.catalog.rows = data.catalog.rows.filter(([id]) => ![274057, 274059, 274074, 274076].includes(id));
  const { output } = buildCatalogCards({ ...data, now: "2026-10-16" });
  assert.equal(output.records[274058].status, "ambiguous");
  assert.equal(output.records[274075].status, "ambiguous");
});

test("overrides win over computed status and unknown ones are reported", () => {
  const overrides = { 274075: { card: "base5-22", number: "22/82", variant: "Normal" }, 1: { card: "x" } };
  const { output, stats } = buildCatalogCards({ ...rocket(), overrides, now: "2026-10-16" });
  assert.equal(output.records[274075].status, "manual");
  assert.equal(output.records[274075].manual.card, "base5-22");
  assert.equal(output.records[274058].status, "inferred-by-order");
  assert.equal(stats.manual, 1);
  assert.deepEqual(stats.unknownOverrides, ["1"]);
  assert.notEqual(output.overridesHash, buildCatalogCards({ ...rocket(), now: "x" }).output.overridesHash);
});
