# Card Watch data

Your own daily copy of Cardmarket's Pokémon price guide, with history, for the Card Watch app.

Every night a GitHub Action downloads Cardmarket's public price guide and product catalogue
(one download each, all ~80,000 Pokémon products, singles and sealed), stores today's prices,
and adds the day to the price history. Once a week it links TCGdex card codes (`neo1-6`) to
Cardmarket products (`274406`), using the order of Cardmarket's own catalogue and TCGdex's open card database
(see "The card mapping" below). GitHub Pages serves the files,
so the app (and anyone you give the address to) reads prices from here instead of calling an API per card.

History starts on the day you set this up; Cardmarket doesn't offer older days.

## What's in here

```
manifest.json                 what's stored: recorded days, last update, field names
latest/e<expansion>.json      today's prices, one file per Cardmarket expansion (set)
history/<YYYY-MM>/e<exp>.json all prices per product, only on days they changed (the last 90 days)
weekly/<YYYY-MM>/e<exp>.json  older months, rolled up into weekly averages
catalog/products.json         every Pokémon product: id, name, expansion, category
mapping/cards.json            TCGdex card code -> [Cardmarket product id, file name, metacard id, how it was found]
mapping/overrides.json        your own fixes to the mapping (card code -> product id, or null; set -> expansion)
scripts/                      the jobs (Node 20, no dependencies)
.github/workflows/            daily prices, weekly mapping
```

Releases named `archive-YYYY-MM` hold Cardmarket's original file of every day, gzipped,
so you can rebuild or extend the history later (for example with fields this repo doesn't keep).

### Reading the files

- `latest/e1531.json` → `{"day": "2026-10-14", "fields": ["low", "trend", …], "p": {"274406": [3.9, 36.64, …]}}`
- `history/2026-10/e1531.json` → `{"fields": ["low", "trend", …all 12 like latest], "p": {"274406": [["2026-10-12", 30.5, 36.64, …], ["2026-10-14", 31, 39.1, …]]}}`
  A point means "from this day on, until the next point". Use `manifest.days` for the days that were recorded.
  Empty values at the end of a point are left out; a point with no values (`["2026-10-20"]`) means the product left the price guide.
- `weekly/2026-07/e1531.json` → the same, for months older than 90 days: four "weeks" per month (days 1–7, 8–14, 15–21, 22–end),
  each point starting on the week's first day, holding the week's **average** of every field plus `trend-min` and `trend-max`
  (the week's lowest and highest trend). Also stored only when a week differs from the one before. `manifest.weeklyMonths` lists these months.
- `mapping/cards.json` → `"cards": {"base5-22": [274075, "e1528", 211936, "order"]}`. The second value is the file name to open in `latest/` and `history/`;
  the third is Cardmarket's metacard id (the same for every printing of a card); the last says how the link was found (see below).
- Products without an expansion are in `x0` … `x49` (by product id modulo 50).

## Set it up (about 10 minutes)

1. **Create a repository** on GitHub, for example `card-watch-data`, and upload everything in this folder
   (including the hidden `.github` folder and `.nojekyll`).
2. **Let the jobs save data:** Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.
3. **Publish it:** Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)` → Save.
   Your address will be `https://<your-github-name>.github.io/card-watch-data/`.
4. **First run:** Actions → **Daily prices** → Run workflow. Wait for it to finish (a few minutes).
5. **Then:** Actions → **Weekly card mapping** → Run workflow.
6. **Connect the app:** in Card Watch, open **Data → Daily prices**, paste the address from step 3, press **Save and test**.

After that it runs by itself: prices every night around 03:30 Belgian time (with a second try at 09:30),
the mapping every Monday.

GitHub Pages needs a public repository on a free account. A private repository with Pages needs a paid plan.

## Size

Each month starts with every product's prices, then only stores changes (about one in four products
changes on a given day; six days with all 12 fields took 13 MB). Months older than 90 days are rolled
up into weekly averages, so the daily part stays around 150–250 MB and each year adds roughly 150–250 MB
of weekly averages, well within GitHub's limits for several years. Cardmarket's original daily files
stay in the release archive, so the daily detail is never lost.
The repository keeps a single commit (see `scripts/commit-data.sh`), so it doesn't grow with every day.
When it gets large after a few years, move old `history/` months elsewhere; the release archive keeps everything.

## Usage terms

Cardmarket publishes these files for download, but its announcement doesn't spell out how the data may be reused.
Using it for yourself is one thing; before you open this up to other people or use it commercially,
check Cardmarket's terms or ask them. Keeping this repository private is not possible with free GitHub Pages,
so the files are publicly readable.

## The card mapping

TCGdex's card files carry a Cardmarket product id, but for older sets it often gives two printings of
the same card the same id (the holo #5 and the non-holo #22 Dark Dragonite in Team Rocket both get 274058).
Cardmarket has a separate product for each. Within an expansion Cardmarket created its products in
card-number order, so `scripts/build-mapping.mjs` lines up each TCGdex set (by card number) with its expansion's
products (by product id), pairing only cards and products whose name and attacks fit. The last value of each
entry says how a card was linked:

- `order`: by that line-up (almost all cards)
- `name`: the only left-over product that fits the card
- `tcgdex`: TCGdex's own link, for cards the catalogue can't place
- `override`: your own choice from `mapping/overrides.json`

Run it on your computer (Node 20+ and git; the first run downloads TCGdex's card data into `.cache/`):

```
npm run mapping
```

Then open `mapping-report.html` (not committed). Per set it shows the links that differ from TCGdex,
cards without a product, products no card got, and **cards where two products fit** with both prices,
so you can decide. To change a link, add it to `mapping/overrides.json` and run again:

```json
{ "sm1-24": 294121, "base1-58": null, "sets": { "np": 1608 } }
```

A number links that product; `null` removes the link (the app then has no price for that card).
`sets` tells which Cardmarket expansion a whole TCGdex set belongs to, for sets whose TCGdex data has no
Cardmarket link (the Nintendo, BW and Shiny Vault promos, the XY trainer kits); the matching then runs as usual.
Commit `mapping/cards.json`, `mapping/overrides.json` and `manifest.json`. The weekly job runs the same
script with the same overrides, so it keeps your choices.

## Run it on your own computer

```
node scripts/update-prices.mjs --force
npm run mapping
```

## Rebuild the history

After the history format changed (or to fill a gap), rebuild it from the release archive:
Actions → **Daily prices** → Run workflow → tick **Rebuild the whole history**. Or on your computer:

```
gh release download archive-2026-10 -D .cache/archive     # each month you want
npm run rebuild-history -- .cache/archive
```
