// Loads the inputs for the transform: the committed test fixtures, or this repo's real data files.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.join(HERE, "..");
export const FIXTURES = path.join(REPO, "test", "fixtures");

const json = async (p) => JSON.parse(await readFile(p, "utf8"));

export async function loadTcgdexCards(ids) {
  const dir = path.join(FIXTURES, "tcgdex");
  const files = ids?.length
    ? ids.map((i) => `${i}.json`)
    : (await readdir(dir)).filter((f) => f.endsWith(".json"));
  return Promise.all(files.map((f) => json(path.join(dir, f))));
}

export async function loadSources(source = "fixtures") {
  const hints = await json(path.join(FIXTURES, "hints.json"));
  if (source === "fixtures") {
    const prices = await json(path.join(FIXTURES, "prices.json"));
    return {
      catalog: await json(path.join(FIXTURES, "catalog.json")),
      mapping: await json(path.join(FIXTURES, "mapping.json")),
      latest: prices.latest,
      history: prices.history,
      hints,
    };
  }
  if (source !== "repo")
    throw new Error(`Unknown source "${source}" (use fixtures or repo)`);
  const latest = {},
    history = {};
  const lDir = path.join(REPO, "latest");
  for (const f of await readdir(lDir))
    if (f.endsWith(".json"))
      latest[f.slice(0, -5)] = await json(path.join(lDir, f));
  const hRoot = path.join(REPO, "history");
  for (const month of (await readdir(hRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    for (const f of await readdir(path.join(hRoot, month))) {
      if (!f.endsWith(".json")) continue;
      const file = f.slice(0, -5);
      const part = await json(path.join(hRoot, month, f));
      if (!history[file]) history[file] = { fields: part.fields, p: {} };
      for (const [id, pts] of Object.entries(part.p))
        (history[file].p[id] ||= []).push(...pts);
    }
  }
  return {
    catalog: await json(path.join(REPO, "catalog", "products.json")),
    mapping: await json(path.join(REPO, "mapping", "cards.json")),
    latest,
    history,
    hints,
  };
}
