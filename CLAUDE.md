# Card Watch — project hand-off

Personal Pokémon card collection app with Cardmarket price history.
Two projects that work together:

| Folder | What it is | Runs where |
|---|---|---|
| `cardwatch-web/` | The app. Plain HTML, CSS and JavaScript, no framework, no build step. Installable (PWA). | Any static host (plan: Bunny), or `python3 -m http.server` locally |
| `card-watch-data/` | Your own price database: nightly job that stores Cardmarket's full Pokémon price guide plus history. | Private GitHub repository + GitHub Actions + Netlify (signed-in users only) |

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
        │  Netlify (static JSON behind an edge function: Supabase sign-in required, CORS for the app only)
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
scripts/update-prices.mjs  nightly job (flag --force ignores the ETag check); rolls months older than 90 days into weekly/
scripts/history-lib.mjs    history format: recordDay() (change-only points, all 12 fields), upgradeMonth(), weekly roll-up (rollupDue)
scripts/rebuild-history.mjs  npm run rebuild-history -- <dir of archive .json.gz>: rebuilds history/ from the release archive
scripts/mapping-lib.mjs    parses TCGdex card .ts files; rebucketMapping()
scripts/match-lib.mjs      matches TCGdex cards to Cardmarket products by catalogue order + name/attacks
scripts/build-mapping.mjs  weekly job and local tool (npm run mapping): writes mapping/cards.json and mapping-report.html;
                           without an argument it clones/updates TCGdex into .cache/tcgdex; applies mapping/overrides.json
scripts/commit-data.sh     commits the data as ONE orphan commit + force push (keeps the repo small); refuses any branch but `data`
site/inspector.html        price data inspector (no build): per card its mapping, TCGdex printings, every candidate product
                           (same metacard / same name in the set) with all 12 latest fields and history. deploy-netlify.sh
                           publishes it at <Netlify>/inspector.html; it signs in (Supabase) and only goes on for OWNER_EMAILS;
                           `?data=<url>` reads another copy of the data
.github/workflows/prices.yml   cron 01:30 + 07:30 UTC; also uploads archive/*.json.gz to release archive-YYYY-MM;
                               manual input "rebuild" downloads all archive releases and runs rebuild-history
.github/workflows/mapping.yml  Mondays 03:00 UTC; sparse-clones tcgdex/cards-database data/
.github/workflows/deploy.yml   manual, or on main changes to netlify/**: publishes the data branch to Netlify
scripts/deploy-netlify.sh  copies data/ (minus .git, archive, .cache) plus site/*.html and runs `netlify deploy --prod`; prices/mapping call it when commit-data.sh pushed
netlify/edge-functions/require-login.ts  every request needs a valid Supabase access token (JWKS, or SUPABASE_JWT_SECRET for HS256); CORS only for ALLOWED_ORIGINS;
                           except /inspector.html (excludedPath) and /inspector-config.json; /inspector-access answers 200 only for OWNER_EMAILS
```

Both workflows share the concurrency group `card-watch-data`, so they never run at the same time.

**Two branches:** `main` holds the code (scripts, workflows, `mapping/overrides.json`, docs) with a normal history, so feature
branches and pull requests work. `data` holds the generated files (`manifest.json`, `latest/`, `history/`, `weekly/`, `catalog/`,
`mapping/cards.json`, `.nojekyll`) and is what the Netlify site serves (`scripts/deploy-netlify.sh`, after every change); each job run replaces it with a single new commit.
The workflows check out `main`, then `data` into `data/`, and run `node ../scripts/…` from `data/` (`ROOT = process.cwd()`).
`build-mapping.mjs` reads `mapping/overrides.json` next to the scripts, not from the data folder.
Locally: `git worktree add data data` (ignored on main), then `npm run prices` / `npm run mapping`, which `cd data` first.

### Output formats (served by Netlify)

- **`manifest.json`:** `{lastDay, days[], months[], weeklyMonths[], sourceTime, productCount, latestFields, historyFields, weeklyFields, historyVersion, historyBytes{}, mappingVersion, guideEtag, catalog{…}, mapping{stats}}`. `days`/`months` list only the daily history; `historyVersion` 2 = all 12 fields (1 = trend only; the app refetches history when it goes up).
- **`latest/<file>.json`:** `{day, fields: [low, trend, avg, avg1, avg7, avg30, low-holo, trend-holo, avg-holo, avg1-holo, avg7-holo, avg30-holo], p: {idProduct: [values]}}`
- **`history/<YYYY-MM>/<file>.json`:** `{fields: [the 12 latest fields], p: {idProduct: [[day, ...values], …]}}` (daily, last 90 days)
  - A point is written when any field changes and holds from its day until the next point. Trailing nulls are left out.
  - Each month starts with a full point, so a month file can be read on its own.
  - A point without values (`[day]`) means the product left the price guide.
  - Older month files (`fields: [trend, trend-holo]`) are converted by `upgradeMonth()`.
- **`weekly/<YYYY-MM>/<file>.json`:** months older than 90 days (`manifest.weeklyMonths`), rolled up into 4 weeks per month (days 1–7, 8–14, 15–21, 22–end): `{fields: [12 means, trend-min, trend-max], p: {idProduct: [[weekStartDay, ...values], …]}}`, also change-only (hold until the next point); a recorded week without prices is an empty point. The daily folder is deleted afterwards; the release archive keeps the originals.
- **`mapping/cards.json`:** `{version, catalogVersion, fields: [idProduct, file, idMetacard, how], cards: {"base5-22": [274075, "e1528", 211936, "order"]}, variants: {cardId: {"holo+1st-edition": id}}, sets: {"neo1": 1531}, custom: {…}, logos: {"2022swsh": "https://images.pokemontcg.io/mcd22/logo.png"}}`
  - `how`: `order` (lined up with the expansion's products by card number vs product id, name + attacks must fit), `name` (only fitting left-over product), `tcgdex` (TCGdex's own link), `override` (from `mapping/overrides.json`).
  - `mapping/overrides.json` `logos: {tcgdexSetId: imageUrl}` gives sets TCGdex has no logo for one (McDonald's Collections 2011–2022, from pokemontcg.io); it is copied as is into `cards.json` `logos`, and the app uses it as `SetInfo.logo` (`setLogoOverrides` in `lib/tcgdex.ts`).
  - `mapping/overrides.json` `sets: {tcgdexSetId: idExpansion}` places sets TCGdex gives no Cardmarket link (np → 1608, bwp → 1611, sma → 2514 with Hidden Fates, tk-xy-* → 1631/1632/1683/1707).
  - Why: TCGdex gives holo and non-holo printings of old cards the same Cardmarket id; Cardmarket has one product per printing, created in card-number order.
- **`catalog/products.json`:** `{fields: [idProduct, name, idExpansion, idCategory, categoryName, idMetacard, dateAdded], rows}`
- **File names** ("buckets"): `e<idExpansion>`, or `x<idProduct % 50>` for products without an expansion.
- **Day labels:** a guide's day is the Belgian date of its `createdAt` (e.g. `2026-10-14T02:53:25+0200` → `2026-10-14`).

### Numbers from testing

| What | Result |
|---|---|
| Real TCGdex data | 219 sets, 23,873 cards; 21,197 (89%) linked to a Cardmarket product (with the `sets` overrides) |
| Real catalogue | 79,767 products (74,694 singles, 5,073 sealed/other) |
| History per run | about 25% of products change some price per day (all 12 fields); 6 days ≈ 13 MB; daily part (90 days) ≈ 150–250 MB, weekly ≈ 150–250 MB per year |
| Latest | about 7 MB in total, 787 set files |

---

## 4. Not done yet / known gaps

Deployment, in this order:
1. Create the `card-watch-data` GitHub repository and upload the folder, including `.github/` and `.nojekyll`.
2. Settings → Actions → General → Workflow permissions → **Read and write permissions**.
3. Netlify: a manually deployed project with env `SUPABASE_URL` and `ALLOWED_ORIGINS` (plus `SUPABASE_PUBLISHABLE_KEY` and `OWNER_EMAILS` for the inspector); GitHub secrets `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` (see README step 4). (Create `data` first: an orphan branch with `.nojekyll`.)
4. Run **Daily prices** once, then **Weekly card mapping** once.
5. Upload `cardwatch-web` to Bunny.
6. Build the app with `VITE_PRICE_DATA_URL` = the Netlify address, then make this repository private.

Unverified against the real thing:
- **The download server.** The Cardmarket download server's ETag/HEAD behaviour; the script handles a missing ETag by processing anyway.
- **GitHub Actions:** the release upload (`gh release …`), and that the orphan-commit force push is allowed (no branch protection on `data`; `main` can be protected).
- **TCGdex CORS:** that TCGdex allows browser requests from your own domain. As far as I know it does, but it hasn't been tested live.

Known limitations:
- **Prices aren't split by language or condition.** It's a limit of the source data.
- **About 14% of TCGdex cards have no Cardmarket link** (mostly very new or unusual cards); those fall back to TCGdex prices.
- **The collection lives per browser and device.** Moving it means backup and restore; there's no sync.
- **The data is only served to signed-in users** (`netlify/edge-functions/require-login.ts` checks the Supabase access token). A signed-in user can still copy it. Check Cardmarket's terms before sharing the app with others.
- **Long-term size:** months older than 90 days are rolled into weekly averages; after several years `weekly/` may need a monthly roll-up (same `rollupSeries`, bigger buckets). The release archive keeps the originals.

Feature ideas, roughly in order:
1. **Price alerts:** a target price per card, shown when crossed (in-app; push needs a server).
2. **Sealed products** (boosters, displays). They're already in the price data (`catalog`, `x*`/`e*` files); they just need a way to search and add them in the app.
3. **Market views** across all products: biggest risers and fallers this week. This needs either a precomputed file in the data job or a database such as SQLite.
4. **Collection sync between devices:** a small backend, or encrypted backup to the data repository.
5. **Dutch sets** (Base/Jungle/Fossil): check how TCGdex and Cardmarket represent them; Cardmarket lists language per offer, not per product.

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
git worktree add data data                             # once: the data branch in data/ (ignored on main)
npm run prices -- --force                              # runs in data/; needs access to downloads.s3.cardmarket.com
npm run mapping                                        # downloads TCGdex into data/.cache/, writes mapping + mapping-report.html
```

Test with fake Cardmarket files:
1. Serve a folder with `productCatalog/priceGuide/price_guide_6.json` and `productCatalog/productList/products_{singles,nonsingles}_6.json`.
2. Run with `CM_BASE=http://localhost:<port>/productCatalog`.
3. Serve the output with CORS (`Access-Control-Allow-Origin: *`) and point the app at it.

When you change the app, bump `CACHE` in `sw.js`, or installed copies keep old files until the network is reached.

Legacy: `card_watch.py` (single-file Python + SQLite version) is superseded. Its only remaining use: its Backup → Full backup (.json) can be restored into the web app.
