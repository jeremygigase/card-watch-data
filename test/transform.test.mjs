import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadSources,
  loadTcgdexCards,
  FIXTURES,
  REPO,
} from "../scripts/transform-sources.mjs";
import { buildRecords, claimsByProduct } from "../scripts/transform-lib.mjs";

const deepFreeze = (o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};

async function run(ids) {
  const sources = deepFreeze(await loadSources("fixtures"));
  const cards = deepFreeze(await loadTcgdexCards(ids));
  return Object.fromEntries(
    buildRecords(cards, sources).map((r) => [r.cardId, r]),
  );
}

test("Dark Dragonite #5 and #22 both map to 274058 and are flagged, not resolved", async () => {
  const rec = await run(["base5-5", "base5-22"]);
  for (const id of ["base5-5", "base5-22"]) {
    const r = rec[id];
    assert.equal(r.mappedProduct, 274058);
    assert.equal(r.mappedFile, "e1528");
    assert.equal(r.status, "ambiguous");
    assert.equal(r.resolved, null);
    assert.ok(r.flags.includes("shared-product-id"));
    assert.ok(r.flags.includes("same-name-in-expansion"));
    assert.ok(r.flags.includes("unclaimed-candidate"));
  }
  assert.deepEqual(rec["base5-5"].variants, ["holo"]);
  assert.deepEqual(rec["base5-22"].variants, ["normal"]);
  assert.equal(rec["base5-5"].number, "5/82");
  assert.equal(rec["base5-22"].number, "22/82");
});

test("candidates are the same-name products only, and 274075 is unclaimed", async () => {
  const { "base5-22": r } = await run(["base5-22"]);
  assert.deepEqual(
    r.candidates.map((c) => c.idProduct),
    [274058, 274075],
  );
  assert.deepEqual(r.candidates[0].claimedBy, ["base5-22", "base5-5"]);
  assert.deepEqual(r.candidates[1].claimedBy, []);
});

test("each candidate carries its own price and history", async () => {
  const { "base5-5": r } = await run(["base5-5"]);
  const [a, b] = r.candidates;
  assert.equal(a.price.latest.trend, 582.47);
  assert.equal(a.price.latest["trend-holo"], 45.98);
  assert.equal(b.price.latest.trend, 21.14);
  assert.equal(b.price.latest["trend-holo"], 22.95);
  assert.equal(a.price.history.length, 2);
  assert.equal(b.price.history.length, 2);
});

test("evidence: name/moves/expansion support, number/finish/metacard cannot discriminate", async () => {
  const { "base5-22": r } = await run(["base5-22"]);
  for (const c of r.candidates) {
    const by = Object.fromEntries(c.evidence.map((e) => [e.field, e.result]));
    assert.equal(by.name, "supports");
    assert.equal(by.moves, "supports");
    assert.equal(by.expansion, "supports");
    assert.equal(by.idMetacard, "not-discriminating");
    assert.equal(by.collectorNumber, "unavailable");
    assert.equal(by.finish, "unavailable");
    assert.equal(by.dateAdded, "unavailable");
  }
});

test("the unverified app hint is shown but never changes the verdict", async () => {
  const { "base5-22": r } = await run(["base5-22"]);
  assert.equal(r.unverifiedHint.to, 274075);
  assert.equal(r.resolved, null);
  assert.equal(r.status, "ambiguous");
});

test("a one-card, one-product control is confirmed", async () => {
  const { "ctl-1": r } = await run(["ctl-1"]);
  assert.equal(r.status, "confirmed");
  assert.equal(r.resolved, 999001);
  assert.deepEqual(r.flags, []);
});

test("claims come from both card-level and variant-level mapping ids", () => {
  const claims = claimsByProduct({
    cards: { a: [1, "e1"] },
    variants: { b: { holo: 1, normal: 2 } },
  });
  assert.deepEqual([...claims.get(1)].sort(), ["a", "b"]);
  assert.deepEqual([...claims.get(2)], ["b"]);
});

test("running the transform leaves fixtures and the real mapping untouched", async () => {
  const hashDir = async (dir) => {
    const out = [];
    for (const e of await readdir(dir, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (e.isFile()) {
        const p = path.join(e.parentPath ?? e.path, e.name);
        out.push(
          p +
            createHash("sha256")
              .update(await readFile(p))
              .digest("hex"),
        );
      }
    }
    return out.sort().join();
  };
  const before = [
    await hashDir(FIXTURES),
    await hashDir(path.join(REPO, "mapping")),
  ];
  await run(["base5-5", "base5-22", "ctl-1"]);
  const after = [
    await hashDir(FIXTURES),
    await hashDir(path.join(REPO, "mapping")),
  ];
  assert.deepEqual(after, before);
});
