# Card Watch data

Your own daily copy of Cardmarket's Pokémon price guide, with history, for the Card Watch app.

Every night a GitHub Action downloads Cardmarket's public price guide and product catalogue
(one download each, all ~80,000 Pokémon products, singles and sealed), stores today's prices,
and adds the day to the price history. Once a week it links TCGdex card codes (`neo1-6`) to
Cardmarket products (`274406`) using TCGdex's open card database. GitHub Pages serves the files,
so the app (and anyone you give the address to) reads prices from here instead of calling an API per card.

History starts on the day you set this up; Cardmarket doesn't offer older days.

## What's in here

```
manifest.json                 what's stored: recorded days, last update, field names
latest/e<expansion>.json      today's prices, one file per Cardmarket expansion (set)
history/<YYYY-MM>/e<exp>.json trend prices per product, only on days they changed
catalog/products.json         every Pokémon product: id, name, expansion, category
mapping/cards.json            TCGdex card code -> [Cardmarket product id, file name]
scripts/                      the jobs (Node 20, no dependencies)
.github/workflows/            daily prices, weekly mapping
```

Releases named `archive-YYYY-MM` hold Cardmarket's original file of every day, gzipped,
so you can rebuild or extend the history later (for example with fields this repo doesn't keep).

### Reading the files

- `latest/e1531.json` → `{"day": "2026-10-14", "fields": ["low", "trend", …], "p": {"274406": [3.9, 36.64, …]}}`
- `history/2026-10/e1531.json` → `{"fields": ["trend", "trend-holo"], "p": {"274406": [["2026-10-12", 36.64, 14.01], ["2026-10-14", 39.1, 14.01]]}}`
  A point means "from this day on, until the next point". Use `manifest.days` for the days that were recorded.
  A point with only `null`s means the product left the price guide.
- `mapping/cards.json` → `"cards": {"neo1-6": [274406, "e1531"]}`. The second value is the file name to open in `latest/` and `history/`.
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

Each month starts with every product's price, then only stores changes (about one in five products
changes on a given day). Expect roughly 150–250 MB of history per year, well within GitHub's limits for a few years.
The repository keeps a single commit (see `scripts/commit-data.sh`), so it doesn't grow with every day.
When it gets large after a few years, move old `history/` months elsewhere; the release archive keeps everything.

## Usage terms

Cardmarket publishes these files for download, but its announcement doesn't spell out how the data may be reused.
Using it for yourself is one thing; before you open this up to other people or use it commercially,
check Cardmarket's terms or ask them. Keeping this repository private is not possible with free GitHub Pages,
so the files are publicly readable.

## Run it on your own computer

```
node scripts/update-prices.mjs --force
git clone --depth 1 --filter=blob:none --sparse https://github.com/tcgdex/cards-database /tmp/tcgdex
git -C /tmp/tcgdex sparse-checkout set data
node scripts/build-mapping.mjs /tmp/tcgdex
```
