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

The repository has two branches (see "The two branches" below for why and how to work with them):

- **`main`**: the code (`scripts/`, the workflows, `mapping/overrides.json`, this README), with a normal history.
- **`data`**: the generated files, which GitHub Pages serves. Replaced by a single new commit on every job run.

On the `data` branch:

```
manifest.json                 what's stored: recorded days, last update, field names
latest/e<expansion>.json      today's prices, one file per Cardmarket expansion (set)
history/<YYYY-MM>/e<exp>.json all prices per product, only on days they changed (the last 90 days)
weekly/<YYYY-MM>/e<exp>.json  older months, rolled up into weekly averages
catalog/products.json         every Pokémon product: id, name, expansion, category
mapping/cards.json            TCGdex card code -> [Cardmarket product id, file name, metacard id, how it was found]
```

On `main`:

```
mapping/overrides.json        your own fixes to the mapping (card code -> product id, or null; set -> expansion)
scripts/                      the jobs (Node 20, no dependencies); they read and write the data in the current folder
scripts/commit-data.sh        saves the data as one fresh commit on the data branch (refuses any other branch)
.github/workflows/            daily prices, weekly mapping; they check out main for the code and data into data/
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
   (including the hidden `.github` folder) to `main`.
2. **Create the data branch**, empty except for `.nojekyll` (so GitHub Pages serves the files as they are)
   and a `.gitignore` for the files the jobs write but don't publish:
   ```
   git switch --orphan data
   touch .nojekyll
   printf 'archive/\n.cache/\nmapping-report.html\nnode_modules/\n.DS_Store\n' > .gitignore
   git add .nojekyll .gitignore && git commit -m "Empty data"
   git push origin data && git switch main
   ```
3. **Let the jobs save data:** Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.
4. **Publish it:** Settings → Pages → Source: **Deploy from a branch**, branch `data`, folder `/ (root)` → Save.
   Your address will be `https://<your-github-name>.github.io/card-watch-data/`.
5. **First run:** Actions → **Daily prices** → Run workflow. Wait for it to finish (a few minutes).
6. **Then:** Actions → **Weekly card mapping** → Run workflow.
7. **Connect the app:** in Card Watch, open **Data → Daily prices**, paste the address from step 4, press **Save and test**.

After that it runs by itself: prices every night around 03:30 Belgian time (with a second try at 09:30),
the mapping every Monday.

GitHub Pages needs a public repository on a free account. A private repository with Pages needs a paid plan.

Optional: Settings → Rules → Rulesets → New branch ruleset for `main` with **Block force pushes**, so nothing
can wipe `main`'s history. Don't add that rule to `data`: the jobs force-push it on every run.

## The two branches

### Why

Every run rewrites about 13 MB of JSON (today's prices plus the growing month files). Git keeps every version
of every file it ever committed, so a normal commit per run would grow the repository by tens of megabytes a
day, several GB a year, while GitHub Pages sites are capped at 1 GB. The price history is already inside the
files (`history/`, `weekly/`), so older commits would only be old copies of them. That's why
`scripts/commit-data.sh` saves the data as **one fresh commit with no parent** and force-pushes it over the
previous one.

That trick wipes the branch's history, so it can only be used on a branch that holds nothing else.
When the data and the code shared `main`, every run gave `main` a brand-new, unrelated history, and every
feature branch broke: GitHub said *"There isn't anything to compare. main and … are entirely different commit
histories."* Hence:

| | `main` | `data` |
|---|---|---|
| Holds | code, workflows, `mapping/overrides.json`, docs | generated files only |
| History | normal; branches and pull requests work | always one commit; replaced on every job run |
| Who changes it | you, through pull requests | only the jobs |
| GitHub Pages | no | yes (Settings → Pages → branch `data`) |

### How the jobs use them

Both workflows check out `main` (the code) and then the `data` branch into a `data/` folder, and run every
step inside `data/`: `node ../scripts/update-prices.mjs`, `node ../scripts/build-mapping.mjs`, and finally
`bash ../scripts/commit-data.sh "<message>"`, which commits and force-pushes `data`. The scripts read and
write the data in the folder they run in (`ROOT` in `scripts/lib.mjs` is the current folder); only
`mapping/overrides.json` is read from next to the scripts, because it's yours, not generated.

Changes to the code reach the next job run as soon as they're merged into `main`.

### Rules of thumb

- **Branch off `main`** and open pull requests against `main`, as in any repository.
- **Never branch off `data`**, open a pull request against it, or push to it yourself: the next job run
  (at most a day later) replaces it, and anything you pushed is gone.
- **To change the published data**, change the code or `mapping/overrides.json` on `main`, then run the
  workflow by hand (Actions → **Daily prices** with **force**, or **Weekly card mapping**).
- **Data files never go on `main`.** `.gitignore` on `main` blocks them, so a local run can't commit them by accident.

### Troubleshooting

- **"There isn't anything to compare … entirely different commit histories"** on a pull request: the branch was
  made from `data` or from the old single-commit `main`. Move your own commits onto the current `main`:
  ```
  git fetch origin
  git log --oneline origin/main..my-branch            # find the oldest commit that is yours
  git rebase --onto origin/main <that commit>~1 my-branch
  git push --force-with-lease origin my-branch
  ```
  If the rebase stops on data files (`manifest.json`, `mapping/cards.json`, …), remove them: `git rm <file>`,
  then `git rebase --continue`.
- **`git pull` in `data/` fails** ("refusing to merge unrelated histories"): expected, the branch is new after
  every run. Use `git -C data fetch origin data && git -C data reset --hard origin/data`.
- **A job fails with "Refusing to squash …"**: `commit-data.sh` ran outside the `data` checkout. Its steps must
  run with `working-directory: data`.
- **A job fails on "Get the data (data branch)"**: the `data` branch doesn't exist on GitHub; see "Set it up", step 2.
- **The site shows no prices after the switch**: check Settings → Pages points at branch `data`, folder `/ (root)`,
  and that `https://<your-github-name>.github.io/card-watch-data/manifest.json` opens.
- **`git push` says "Invalid username or token. Password authentication is not supported"**: GitHub no longer
  accepts passwords over HTTPS. Use SSH (`git remote set-url origin git@github.com:<your-github-name>/card-watch-data.git`)
  or replace the token stored in your keychain with a new personal access token.

### Moving an existing repository to two branches (one time)

For a repository from before the split, where `main` still holds the data. Do steps 2–5 in one go, between
two job runs (the prices job runs at 01:30 and 07:30 UTC); otherwise a run replaces `main` in between and you
have to start again.

1. Make sure `main` on GitHub is a job's commit ("Prices of …" or "Card mapping of …"):
   `git fetch origin && git log -1 --format=%s origin/main`.
2. Create `data` from it, with only the generated files, the same `.gitignore` as in "Set it up" step 2 and no parent:
   ```
   git switch --orphan data
   git checkout origin/main -- .nojekyll manifest.json catalog history latest mapping/cards.json
   git checkout origin/main -- weekly 2>/dev/null || true
   printf 'archive/\n.cache/\nmapping-report.html\nnode_modules/\n.DS_Store\n' > .gitignore
   git add -A && git commit -m "Data split from main" && git push origin data
   git switch main
   ```
3. Settings → Pages → branch `data`, folder `/ (root)` → Save. The address stays the same, so the app needs no change.
4. Merge the code changes (the new workflows, `commit-data.sh`, `.gitignore`, and the data files removed from `main`)
   into `main` through a pull request made from the current `origin/main`.
5. Actions → **Daily prices** → Run workflow with **force**. `data` gets a new "Prices of …" commit and `main` stays
   as it is. Then run **Weekly card mapping** once.

## Size

Each month starts with every product's prices, then only stores changes (about one in four products
changes on a given day; six days with all 12 fields took 13 MB). Months older than 90 days are rolled
up into weekly averages, so the daily part stays around 150–250 MB and each year adds roughly 150–250 MB
of weekly averages, well within GitHub's limits for several years. Cardmarket's original daily files
stay in the release archive, so the daily detail is never lost.
The `data` branch keeps a single commit, so the repository doesn't grow with every day (see "The two branches").
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

Run it on your computer (Node 20+ and git; see "Run it on your own computer" for the `data/` folder;
the first run downloads TCGdex's card data into `data/.cache/`):

```
npm run mapping
```

Then open `data/mapping-report.html` (not committed). Per set it shows the links that differ from TCGdex,
cards without a product, products no card got, and **cards where two products fit** with both prices,
so you can decide. To change a link, add it to `mapping/overrides.json` and run again:

```json
{ "sm1-24": 294121, "base1-58": null, "sets": { "np": 1608 } }
```

A number links that product; `null` removes the link (the app then has no price for that card).
`sets` tells which Cardmarket expansion a whole TCGdex set belongs to, for sets whose TCGdex data has no
Cardmarket link (the Nintendo, BW and Shiny Vault promos, the XY trainer kits); the matching then runs as usual.
Commit `mapping/overrides.json` to `main` (through a pull request), then run Actions → **Weekly card mapping**
to publish the new mapping. The weekly job runs the same script with the same overrides, so it keeps your choices.

## Run it on your own computer

You need Node 20+ and git. The jobs read and write the data in the folder they run in, like on GitHub.
From your `main` checkout, put the `data` branch in a `data/` folder once (a git worktree; `main` ignores the folder):

```
git fetch origin data && git worktree add data data
```

Then, from the repository folder (the npm scripts `cd data` first):

```
git -C data fetch origin data && git -C data reset --hard origin/data     # get the newest data first
npm run prices -- --force                                                # today's prices into data/
npm run mapping                                                          # mapping into data/, plus data/mapping-report.html
```

What you run locally is only for trying things out. Don't commit or push from `data/`: the next job run
replaces that branch anyway. To publish, merge your code change into `main` and run the workflow.
Throw local results away with `git -C data reset --hard origin/data`.

## Rebuild the history

After the history format changed (or to fill a gap), rebuild it from the release archive:
Actions → **Daily prices** → Run workflow → tick **Rebuild the whole history**. That publishes the result.
To try it on your computer first (with the `data/` folder from above):

```
gh release download archive-2026-10 -D data/.cache/archive     # each month you want
npm run rebuild-history -- .cache/archive                      # the path is inside data/
```
