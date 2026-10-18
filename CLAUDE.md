# Card Watch — project hand-off

Personal Pokémon card collection app with Cardmarket price history.
Two projects that work together:

| Folder | What it is | Runs where |
|---|---|---|
| `cardwatch-web/` | The app. Plain HTML, CSS and JavaScript, no framework, no build step. Installable (PWA). | Any static host (plan: Bunny), or `python3 -m http.server` locally |
| `card-watch-data/` | Your own price database: nightly job that stores Cardmarket's full Pokémon price guide plus history. | GitHub repository + GitHub Actions + GitHub Pages |

Status (14 Oct 2026): both built and tested with simulated data. **Not yet deployed.**
Nothing has run against the live Cardmarket download server or real GitHub Actions yet.

---

## 1. How it fits together

```
Cardmarket downloads (price guide + catalogue, daily, ~80k Pokémon products)
        │  1 download per day
        ▼
card-watch-data  (GitHub Actions, nightly)
  latest/<set>.json · history/<YYYY-MM>/<set>.json · mapping/cards.json · manifest.json
        │  GitHub Pages (static JSON, CORS *)
        ▼
cardwatch-web  (browser, IndexedDB)
  reads manifest → mapping → only the set files for the user's cards
        ▲
TCGdex API (api.tcgdex.net/v2/en) — card names, images, search, set lists;
prices only as fallback for cards the price data doesn't cover (~14%)
```

Key facts that shaped the design:

- **Cardmarket's official API is closed to new users.** Scraping cardmarket.com is against their terms and blocked by Cloudflare.
- **Cardmarket publishes official download files** (announced June 2024): `https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json` (6 = Pokémon), plus `productList/products_singles_6.json` and `products_nonsingles_6.json`. Refreshed daily around 03:00 Belgian time. These files send no CORS headers, so a browser can't fetch them directly. That's why the GitHub job exists.
- **TCGdex serves the same Cardmarket numbers.** Its server downloads that same price guide and links cards via `thirdParty.cardmarket` (the Cardmarket `idProduct`) in its open card database (github.com/tcgdex/cards-database, `data/`). The mapping job reads those files.
- **The price guide is not split by language or condition.** A Dutch or played copy is valued at the card's general trend price.
- **History only starts from the first run.** Cardmarket doesn't offer past days.

Reference project used: github.com/ZyzyThePizi/pokemon-price-data (MIT), a similar relay. It's where the download URLs and the file format were confirmed.

---

## 2. cardwatch-web (the app)

### Files

```
index.html             markup for all tabs + the card sheet <dialog>
css/styles.css         all styling; tokens on :root, dark mode via prefers-color-scheme
js/util.js             $, el(), money/date helpers (local calendar days "YYYY-MM-DD"), download(), armButton()
js/db.js               DB: IndexedDB wrapper (open, all, put, putMany, del, replaceAll)
js/tcgdex.js           TCGdex calls: fetchCard, fetchSet, searchCards, cardsByName, getSets
js/data.js             state S, actions, fetch queue (JOB), read model buildData(), backup/import/CSV
js/pricedata.js        PriceData: reads your card-watch-data files, merges prices + history
js/ui.js               render functions (D = read model), card sheet, panels
js/main.js             event wiring + start()
sw.js                  service worker: network-first for own files, offline fallback. Bump CACHE on every release (now cardwatch-v3)
manifest.webmanifest   PWA manifest; icons/ has svg + png icons
```

Classic `<script defer>` files sharing the global scope, loaded in this order:
util → db → tcgdex → data → pricedata → ui → main. Later files may be referenced inside functions of
earlier ones (e.g. `data.js` calls `PriceData.covers()` at run time), never at load time.

### Data model (IndexedDB database `cardwatch`, version 1)

| Store | Key | Shape |
|---|---|---|
| `cards` | `id` (TCGdex code, e.g. `neo1-6`) | `{id, name, set, setId, localId, rarity, image, variant: 'normal'\|'reverse', watched, wanted, addedAt, checkedOn}` |
| `prices` | `id` (card id) | `{id, series: [{day, fetchedAt, cm, source?}]}`. `cm` uses Cardmarket keys: `trend, low, avg, avg1, avg7, avg30` and the same with `-holo`. `source: 'pricedata'` when it came from your price data. |
| `copies` | `id` (auto) | `{id, cardId, qty, condition: MT\|NM\|EX\|GD\|LP\|PL\|PO, language, variant, paid (per card, €), boughtOn, note, addedAt}` |
| `lists` | `id` (auto) | `{id, kind: 'set'\|'name', query, title, createdAt, cardIds: [...]}` |
| `meta` | `key` | `lastBackupAt`, `persisted`, `priceData {url}`, `priceMap {version, url, cards}`, `priceDataDay`, `priceDataBackfilled [ids]`, `priceDataSyncedAt` |

Rules worth knowing:

- **"Owned" means the card has at least one copy.** Ticking "Own" in a list adds one NM English copy. Unticking only removes it if it's that same untouched single copy; otherwise the card sheet opens.
- **`cleanup(id)` deletes a card when nothing points to it** (not watched, not wanted, no copies, in no list). Its `prices` record is kept on purpose, so re-adding a card keeps its history.
- **Cardmarket's `-holo` fields mean reverse holo / foil.** `variant` chooses which one a card follows. If the chosen variant has no price, the other one is used.
- **`checkedOn` = the day the card's price was last fetched.** It stops the app from fetching twice a day.

### Flows

- **Start** (`main.js start()`): `loadState()` → `render()` → `PriceData.run()` → `refreshPrices(false)`. The last step fetches from TCGdex only for cards not covered by the price data and not checked today.
- **Fetch queue** (`enqueue`/`runQueue` in `data.js`): 3 parallel TCGdex fetches, shared by refreshes and list loading; progress lives in `JOB`.
- **PriceData.run():**
  1. Fetch `manifest.json`, then `mapping/cards.json` only when `mappingVersion` changed (cached in meta).
  2. Fetch `latest/<file>.json` for the sets of the user's cards.
  3. Fetch `history/<month>/<file>.json` for new cards (full history) and for days missed since the last sync.
  4. History is stored "only on change", so `expand()` turns it into one point per day in `manifest.days`.
  5. Mark covered cards `checkedOn = today`.
  A second call while one is running returns the same promise.
- **Collection value chart** (`collectionHistory` in `data.js`): a copy counts from `boughtOn` (or the day it was added), so the line steps up on purchases. Before a card's first stored price, its first known price is used.
- **Backup:** full JSON export/import (`exportData`, `normalizeImport`). Import also accepts the old Python app's backup (`app: 'card-watch'`). Restore downloads a safety copy first. Plus CSV exports (price history, collection). A banner nags after 14 days without a downloaded backup.

### UI conventions

- **No `alert`/`confirm`.** Destructive buttons use `armButton()`, which needs a second click within 3 s.
- **Every action goes through `act(fn, msgEl)`**, which shows errors in place instead of failing silently.
- **Re-render everything** via `onChange()`, which `main.js` sets to call `render()`. During jobs it is throttled to every 500 ms.
- **Formatting:** prices use `nl-BE` (`€ 1.234,56`), dates use `en-GB` ("14 Oct"). All text is English.

---

## 3. card-watch-data (price database)

### Files

```
scripts/lib.mjs            shared helpers; URLs (override base with env CM_BASE for testing); bucketOf()
scripts/update-prices.mjs  nightly job (flag --force ignores the ETag check)
scripts/mapping-lib.mjs    parses TCGdex card .ts files; rebucketMapping()
scripts/build-mapping.mjs  weekly job: node scripts/build-mapping.mjs <tcgdex cards-database checkout>
scripts/commit-data.sh     commits everything as ONE orphan commit + force push (keeps the repo small)
.github/workflows/prices.yml   cron 01:30 + 07:30 UTC; also uploads archive/*.json.gz to release archive-YYYY-MM
.github/workflows/mapping.yml  Mondays 03:00 UTC; sparse-clones tcgdex/cards-database data/
```

Both workflows share the concurrency group `card-watch-data`, so they never run at the same time.

### Output formats (served by GitHub Pages)

- **`manifest.json`:** `{lastDay, days[], months[], sourceTime, productCount, latestFields, historyFields, mappingVersion, guideEtag, catalog{…}, mapping{stats}}`
- **`latest/<file>.json`:** `{day, fields: [low, trend, avg, avg1, avg7, avg30, low-holo, trend-holo, avg-holo, avg1-holo, avg7-holo, avg30-holo], p: {idProduct: [values]}}`
- **`history/<YYYY-MM>/<file>.json`:** `{fields: [trend, trend-holo], p: {idProduct: [[day, trend, trendHolo], …]}}`
  - A point holds from its day until the next point.
  - Each month starts with a full point, so a month file can be read on its own.
  - A point that is all `null` means the product left the price guide.
- **`mapping/cards.json`:** `{version, catalogVersion, cards: {"neo1-6": [274406, "e1531"]}, variants: {cardId: {"holo+1st-edition": id}}, sets: {"neo1": 1531}}`
- **`catalog/products.json`:** `{fields: [idProduct, name, idExpansion, idCategory, categoryName, idMetacard, dateAdded], rows}`
- **File names** ("buckets"): `e<idExpansion>`, or `x<idProduct % 50>` for products without an expansion.
- **Day labels:** a guide's day is the Belgian date of its `createdAt` (e.g. `2026-10-14T02:53:25+0200` → `2026-10-14`).

### Numbers from testing

| What | Result |
|---|---|
| Real TCGdex data | 219 sets, 23,873 cards; 20,457 (86%) linked to a Cardmarket product |
| Real catalogue | 79,767 products (74,694 singles, 5,073 sealed/other) |
| History per run | about 18% of products change trend price per day; 3 days ≈ 5 MB; estimate 150–250 MB per year |
| Latest | about 7 MB in total, 787 set files |

---

## 4. Not done yet / known gaps

Deployment, in this order:
1. Create the `card-watch-data` GitHub repository and upload the folder, including `.github/` and `.nojekyll`.
2. Settings → Actions → General → Workflow permissions → **Read and write permissions**.
3. Settings → Pages → deploy from branch `main`, folder `/` (root).
4. Run **Daily prices** once, then **Weekly card mapping** once.
5. Upload `cardwatch-web` to Bunny.
6. In the app, enter the Pages address under **Data → Daily prices**.

Unverified against the real thing:
- **The download server.** The Cardmarket download server's ETag/HEAD behaviour; the script handles a missing ETag by processing anyway.
- **GitHub Actions:** the release upload (`gh release …`), and that the orphan-commit force push is allowed (no branch protection on `main`).
- **TCGdex CORS:** that TCGdex allows browser requests from your own domain. As far as I know it does, but it hasn't been tested live.

Known limitations:
- **Prices aren't split by language or condition.** It's a limit of the source data.
- **About 14% of TCGdex cards have no Cardmarket link** (mostly very new or unusual cards); those fall back to TCGdex prices.
- **The collection lives per browser and device.** Moving it means backup and restore; there's no sync.
- **GitHub Pages on a free account means a public repository**, so the full price guide becomes publicly readable. Check Cardmarket's terms before sharing the app with others.
- **Long-term size:** after a few years, `history/` will need old months moved out. The release archive keeps the originals.

Feature ideas, roughly in order:
1. **Price alerts:** a target price per card, shown when crossed (in-app; push needs a server).
2. **Card detail chart** over 30/90/365 days, now that real history exists.
3. **Sealed products** (boosters, displays). They're already in the price data (`catalog`, `x*`/`e*` files); they just need a way to search and add them in the app.
4. **Market views** across all products: biggest risers and fallers this week. This needs either a precomputed file in the data job or a database such as SQLite.
5. **Collection sync between devices:** a small backend, or encrypted backup to the data repository.
6. **Dutch sets** (Base/Jungle/Fossil): check how TCGdex and Cardmarket represent them; Cardmarket lists language per offer, not per product.

---

## 5. Working on it

Run the app:
```
cd cardwatch-web && python3 -m http.server 8080      # open http://localhost:8080
```
The app checks the address field: it accepts any `https://` URL, or `http://localhost` / `127.0.0.1` for testing.

Run the data jobs locally (Node 20+):
```
cd card-watch-data
node scripts/update-prices.mjs --force                 # needs access to downloads.s3.cardmarket.com
git clone --depth 1 --filter=blob:none --sparse https://github.com/tcgdex/cards-database /tmp/tcgdex
git -C /tmp/tcgdex sparse-checkout set data
node scripts/build-mapping.mjs /tmp/tcgdex
```

Test with fake Cardmarket files:
1. Serve a folder with `productCatalog/priceGuide/price_guide_6.json` and `productCatalog/productList/products_{singles,nonsingles}_6.json`.
2. Run with `CM_BASE=http://localhost:<port>/productCatalog`.
3. Serve the output with CORS (`Access-Control-Allow-Origin: *`) and point the app at it.

When you change the app, bump `CACHE` in `sw.js`, or installed copies keep old files until the network is reached.

Legacy: `card_watch.py` (single-file Python + SQLite version) is superseded. Its only remaining use: its Backup → Full backup (.json) can be restored into the web app.
