#!/usr/bin/env node
// Builds mapping/cards.json, which links TCGdex card codes (like "base5-22") to Cardmarket product
// ids (like 274075), plus mapping-report.html to review the result.
//
//   node scripts/build-mapping.mjs                 # local: downloads/updates TCGdex into .cache/tcgdex
//   node scripts/build-mapping.mjs <tcgdex path>   # use an existing checkout of tcgdex/cards-database
//
// Cards are matched to products by Cardmarket's catalogue order (see match-lib.mjs). TCGdex's own
// Cardmarket links are only used for cards the catalogue can't place.
import { readdir, readFile, writeFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, readJson, writeJson, bucketOf } from './lib.mjs'
import { parseCardFile, primaryProduct, matchBracket } from './mapping-lib.mjs'
import { matchExpansion, parseCardMeta, productFitsCard } from './match-lib.mjs'

const CACHE = path.join(ROOT, '.cache', 'tcgdex')
const REPORT = path.join(ROOT, 'mapping-report.html')
// Your own fixes are code, not data: they live on main, next to the scripts (the data folder is the current one).
const OVERRIDES = fileURLToPath(new URL('../mapping/overrides.json', import.meta.url))

async function exists(p) { try { await access(p); return true } catch { return false } }
async function dirs(p) { return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name) }
async function tsFiles(p) { return (await readdir(p, { withFileTypes: true })).filter(d => d.isFile() && d.name.endsWith('.ts')).map(d => d.name) }

/* A local copy of TCGdex's card database (only its data/ folder), fetched or updated with git. */
async function tcgdexCheckout() {
  const git = (...args) => execFileSync('git', args, { stdio: 'inherit' })
  try {
    if (await exists(path.join(CACHE, '.git'))) {
      console.log('Updating TCGdex card data in .cache/tcgdex …')
      git('-C', CACHE, 'pull', '--ff-only', '--quiet')
    } else {
      console.log('Downloading TCGdex card data into .cache/tcgdex (first time only, takes a minute) …')
      git('clone', '--depth', '1', '--filter=blob:none', '--sparse', '--quiet', 'https://github.com/tcgdex/cards-database', CACHE)
      git('-C', CACHE, 'sparse-checkout', 'set', 'data')
    }
  } catch {
    throw new Error('Couldn\'t get TCGdex\'s card data with git. Is git installed and are you online? ' +
      'You can also pass the path of a checkout: node scripts/build-mapping.mjs <path>')
  }
  return CACHE
}

/* Cardmarket catalogue: product info by id, and the singles of each expansion. */
async function loadCatalogue() {
  const cat = await readJson(path.join(ROOT, 'catalog', 'products.json'))
  if (!cat) throw new Error('catalog/products.json is missing. Run the prices job first (node scripts/update-prices.mjs).')
  const F = Object.fromEntries(cat.fields.map((f, i) => [f, i]))
  const info = new Map(), singles = new Map(), setName = new Map()
  for (const r of cat.rows) {
    const p = { idProduct: r[F.idProduct], name: r[F.name], idExpansion: r[F.idExpansion], idMetacard: r[F.idMetacard] || null, dateAdded: r[F.dateAdded] }
    info.set(p.idProduct, p)
    if (r[F.idCategory] === 51) {
      if (!singles.has(p.idExpansion)) singles.set(p.idExpansion, [])
      singles.get(p.idExpansion).push(p)
    } else if (/ Booster$/.test(p.name) && !setName.has(p.idExpansion)) {
      setName.set(p.idExpansion, p.name.replace(/ Booster$/, ''))   // the expansion's name, for the report
    }
  }
  return { info, singles, setName, updatedAt: cat.updatedAt ?? null }
}

/* Every TCGdex set (English/international data/ folder) with its cards. */
async function loadTcgdex(src) {
  const data = path.join(src, 'data')
  const sets = []
  let noSetId = 0
  for (const serie of await dirs(data)) {
    for (const folder of await dirs(path.join(data, serie))) {
      let setText
      try { setText = await readFile(path.join(data, serie, folder + '.ts'), 'utf8') } catch { continue }
      const id = (/\bid\s*:\s*["']([^"']+)["']/.exec(setText) || [])[1]
      if (!id) { noSetId++; continue }
      const exp = (/thirdParty\s*:\s*\{[^{}]*?cardmarket\s*:\s*(\d+)/.exec(setText) || [])[1]
      const cards = []
      for (const f of await tsFiles(path.join(data, serie, folder))) {
        const text = await readFile(path.join(data, serie, folder, f), 'utf8')
        const parsed = parseCardFile(text)
        const meta = parseCardMeta(text, matchBracket)
        const localId = f.slice(0, -3)
        cards.push({ id: `${id}-${localId}`, localId, name: meta.name ?? '', moves: meta.moves, parsed, tcgdex: primaryProduct(parsed) })
      }
      sets.push({ id, name: folder, serie, setExp: exp ? Number(exp) : null, cards })
    }
  }
  return { sets, noSetId }
}

/* Which Cardmarket expansion a TCGdex set belongs to. Usually the set file says so; when it says
   nothing or disagrees with where its cards' links point, take whichever the catalogue fits best. */
function chooseExpansion(set, cat, setOverrides = {}) {
  const forced = setOverrides[set.id]
  if (forced != null && cat.singles.has(Number(forced))) return Number(forced)   // mapping/overrides.json "sets"
  const votes = new Map()
  for (const c of set.cards) {
    const e = c.tcgdex != null ? cat.info.get(c.tcgdex)?.idExpansion : undefined
    if (e != null) votes.set(e, (votes.get(e) || 0) + 1)
  }
  const top = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const options = [...new Set([set.setExp, top].filter(e => e != null && cat.singles.has(e)))]
  if (options.length < 2) return options[0] ?? null
  const score = e => matchExpansion(set.cards, cat.singles.get(e)).links.size
  return options.sort((a, b) => score(b) - score(a))[0]
}

async function main() {
  const src = process.argv[2] || await tcgdexCheckout()
  const cat = await loadCatalogue()
  const { sets, noSetId } = await loadTcgdex(src)
  const overrides = (await readJson(OVERRIDES)) || {}

  // Group TCGdex sets per expansion; the set the expansion belongs to comes first.
  const groups = new Map()
  for (const s of sets) {
    s.exp = chooseExpansion(s, cat, overrides.sets)
    if (s.exp == null) continue
    if (!groups.has(s.exp)) groups.set(s.exp, [])
    groups.get(s.exp).push(s)
  }
  for (const [exp, ss] of groups) ss.sort((a, b) => (b.setExp === exp) - (a.setExp === exp) || a.id.localeCompare(b.id))

  // Oversized (jumbo) cards are separate products but never "the" card: leave them out of the matching.
  const jumbo = new Set()
  for (const s of sets) for (const c of s.cards) for (const v of c.parsed.variants) if (v.size) jumbo.add(v.id)
  for (const p of cat.info.values()) if (/\[Oversized\]/i.test(p.name)) jumbo.add(p.idProduct)

  // 1 + 2: catalogue order and unique names, per expansion.
  const link = new Map()            // cardId -> { idProduct, how }
  const leftovers = new Map()       // exp -> products no card got
  for (const [exp, ss] of groups) {
    const cards = ss.flatMap((s, g) => s.cards.map(c => ({ ...c, group: g })))
    const { links, leftover } = matchExpansion(cards, cat.singles.get(exp).filter(p => !jumbo.has(p.idProduct)))
    links.forEach((v, k) => link.set(k, v))
    leftovers.set(exp, leftover)
  }

  // 3: TCGdex's own link for the rest. When another card already has that product, only if the
  //    product's name and attacks fit this card too (the same card in both halves of a trainer kit).
  const used = new Set([...link.values()].map(l => l.idProduct))
  const skipped = new Map()         // cardId -> TCGdex product we didn't use
  for (const s of sets) {
    for (const c of s.cards) {
      if (link.has(c.id) || c.tcgdex == null || jumbo.has(c.tcgdex)) continue
      const p = cat.info.get(c.tcgdex)
      if (used.has(c.tcgdex) && !(p && productFitsCard(c, p.name))) { skipped.set(c.id, c.tcgdex); continue }
      link.set(c.id, { idProduct: c.tcgdex, how: 'tcgdex' })
      used.add(c.tcgdex)
    }
  }
  // 4: your own decisions in mapping/overrides.json win: { "sm1-24": 294121, "base1-58": null }
  for (const [id, product] of Object.entries(overrides)) {
    if (id.startsWith('_') || id === 'sets' || id === 'custom' || id === 'logos') continue   // "_comment" keys; "sets": chooseExpansion; "custom": step 5; "logos": passed on as is
    if (product == null) link.delete(id)
    else link.set(id, { idProduct: Number(product), how: 'override' })
  }
  // 5: cards TCGdex doesn't have at all (mapping/overrides.json "custom"), such as Japan's Premium File promos.
  const custom = customCards(overrides.custom, cat)
  used.clear()
  for (const l of link.values()) used.add(l.idProduct)
  for (const c of custom.cards) if (c.idProduct != null) used.add(c.idProduct)
  for (const [exp, list] of leftovers) leftovers.set(exp, list.filter(p => !used.has(p.idProduct)))

  // Output, same shape as before plus idMetacard and how each link was found.
  const primaryOf = new Map([...link].map(([id, l]) => [l.idProduct, id]))
  const cards = {}, variants = {}, setsOut = {}
  const stats = { sets: sets.length, cards: 0, mapped: 0, byOrder: 0, byName: 0, byTcgdex: 0, byOverride: 0, byCustom: 0, changedFromTcgdex: 0, unknownToCatalogue: 0, noSetId }
  for (const s of sets) {
    if (s.exp != null) setsOut[s.id] = s.exp
    for (const c of s.cards) {
      stats.cards++
      const l = link.get(c.id)
      if (!l) continue
      const p = cat.info.get(l.idProduct)
      cards[c.id] = [l.idProduct, bucketOf(l.idProduct, p?.idExpansion), p?.idMetacard ?? null, l.how]
      stats.mapped++
      stats[{ order: 'byOrder', name: 'byName', tcgdex: 'byTcgdex', override: 'byOverride' }[l.how]]++
      if (!p) stats.unknownToCatalogue++
      if (c.tcgdex != null && c.tcgdex !== l.idProduct) stats.changedFromTcgdex++
      // TCGdex's printings (1st edition, stamps, shadowless, jumbo …), minus links that belong to another card.
      const vs = c.parsed.variants.filter(v => (primaryOf.get(v.id) ?? c.id) === c.id)
      const pv = printingKeys(vs)
      // Plain printings ("normal", "holo", "reverse") are the card itself and follow its own product
      // (above). TCGdex sometimes links them to a later reprint, which priced plain copies far too high.
      for (const k of Object.keys(pv)) if (!k.includes('+')) delete pv[k]
      if (Object.values(pv).some(id => id !== l.idProduct)) variants[c.id] = pv
    }
  }

  const customOut = { sets: custom.sets, cards: {} }
  for (const c of custom.cards) {
    customOut.cards[c.id] = c.info
    if (c.idProduct == null) continue            // listed for the set, but Cardmarket has no product: no price
    const p = cat.info.get(c.idProduct)
    if (!p) { stats.unknownToCatalogue++; console.warn(`  custom card ${c.id}: product ${c.idProduct} isn't in the catalogue`) }
    cards[c.id] = [c.idProduct, bucketOf(c.idProduct, p?.idExpansion), p?.idMetacard ?? null, 'custom']
    stats.byCustom++
  }

  const version = new Date().toISOString()
  const manifest = (await readJson(path.join(ROOT, 'manifest.json'))) || { version: 1, days: [] }
  await writeJson(path.join(ROOT, 'mapping', 'cards.json'), {
    version,
    catalogVersion: manifest?.catalog?.updatedAt ?? cat.updatedAt,
    source: 'Cardmarket catalogue order + https://github.com/tcgdex/cards-database',
    fields: ['idProduct', 'file', 'idMetacard', 'how'],
    cards,
    variants,
    sets: setsOut,
    custom: customOut,
    logos: overrides.logos || {},
  })
  manifest.mappingVersion = version
  manifest.mapping = { ...stats, updatedAt: version }
  await writeJson(path.join(ROOT, 'manifest.json'), manifest, true)

  // Today's trend prices, only to show in the report (they never change the mapping).
  const trend = new Map()
  for (const exp of groups.keys()) {
    const f = await readJson(path.join(ROOT, 'latest', `e${exp}.json`))
    const i = f?.fields?.indexOf('trend') ?? -1
    if (i >= 0) for (const [id, v] of Object.entries(f.p)) trend.set(Number(id), v[i])
  }
  const page = report({ sets, groups, link, leftovers, skipped, cat, stats, version, trend, used })
  await writeFile(REPORT, page.html)

  const pct = n => Math.round(n / stats.cards * 100)
  console.log(`Sets: ${stats.sets}, cards: ${stats.cards}, linked to Cardmarket: ${stats.mapped} (${pct(stats.mapped)}%)`)
  console.log(`  by catalogue order ${stats.byOrder}, by unique name ${stats.byName}, TCGdex's link ${stats.byTcgdex}`)
  console.log(`  ${stats.changedFromTcgdex} cards now point to a different product than TCGdex says`)
  if (stats.byCustom) console.log(`  plus ${stats.byCustom} cards TCGdex doesn't have, from mapping/overrides.json "custom"`)
  if (stats.unknownToCatalogue) console.log(`  ${stats.unknownToCatalogue} linked products aren't in the current catalogue`)
  if (page.toCheck) console.log(`  ${page.toCheck} cards where two products fit: check them in the report`)
  console.log(`Wrote mapping/cards.json. Review: open mapping-report.html`)
}

/* Cards TCGdex doesn't have, from mapping/overrides.json "custom":
     { "pf2": { "lang": "ja", "name": "Premium File 2", "cards": [{ "n": 3, "name": "Pichu", "idProduct": 571910 }, …] } }
   Each card gets the code "<lang>:<set>-<n>" ("ja:pf2-3"), the form the app uses for non-English cards
   ("<set>-<n>" for English). Everything but idProduct is passed on to the app as the card's details.
   "idProduct": null lists a card that Cardmarket has no product for: it's in the set, without a price.
   A set with "expansion" instead of "cards" is built from that Cardmarket expansion: one card per product
   name, numbered in product order and linked to the first product with that name (see expansionCards). */
function customCards(spec = {}, cat) {
  const sets = {}, cards = [], seen = new Set()
  for (const [setId, s] of Object.entries(spec)) {
    if (setId.startsWith('_')) continue
    const { cards: given, expansion, ...info } = s
    const list = given ?? expansionCards(setId, expansion, cat)
    const prefix = info.lang && info.lang !== 'en' ? `${info.lang}:` : ''
    sets[setId] = { ...info, total: list.length }
    for (const c of list) {
      const { idProduct, ...rest } = c
      const id = `${prefix}${setId}-${c.n}`
      if (c.n == null || (idProduct !== null && !Number.isInteger(Number(idProduct)))) throw new Error(`mapping/overrides.json custom "${setId}": every card needs "n" and an "idProduct" (a number, or null when Cardmarket has none) (${JSON.stringify(c)})`)
      if (seen.has(id)) throw new Error(`mapping/overrides.json custom: ${id} appears twice`)
      seen.add(id)
      cards.push({ id, idProduct: idProduct === null ? null : Number(idProduct), info: { set: setId, ...rest } })
    }
  }
  return { sets, cards }
}

/* The singles of a Cardmarket expansion as custom cards. Products with the same name (the same card in
   several World Championship decks) become one card, linked to the first of them; online code cards are
   left out. New products get the next numbers, so existing card codes stay the same. */
function expansionCards(setId, expansion, cat) {
  const products = cat?.singles.get(Number(expansion))
  if (!products) {
    console.warn(`  custom "${setId}": Cardmarket expansion ${expansion} isn't in the catalogue, so it has no cards`)
    return []
  }
  const first = new Map()
  for (const p of [...products].sort((a, b) => a.idProduct - b.idProduct)) {
    if (/code card/i.test(p.name) || first.has(p.name)) continue
    first.set(p.name, p)
  }
  // "name" without the last [ … ] (usually the attacks); "cmName" keeps Cardmarket's full name ("Unown [R] [Reassure | Hidden Power]").
  return [...first.values()].map((p, i) => ({ n: i + 1, name: p.name.replace(/ \[[^\[\]]*\]$/, ''), cmName: p.name, idProduct: p.idProduct }))
}

/* Keys for a card's printings, in the form the app looks them up: version + stamps ("holo",
   "holo+1st-edition"), plus the TCGdex subtype ("holo+shadowless") and size ("holo+jumbo") where given.
   Plain keys only come from plain printings: a "shadowless" printing never becomes plain "holo",
   so a regular copy keeps the card's own product. The first printing with a key wins. */
function printingKeys(vs) {
  const out = {}
  const add = (parts, id) => { const k = parts.filter(Boolean).join('+'); if (!(k in out)) out[k] = id }
  const plain = vs.filter(v => !v.subtype && !v.size)
  for (const v of plain) add([v.type, ...v.stamps], v.id)
  for (const v of vs.filter(v => v.subtype && !v.size)) {
    add([v.type, v.subtype, ...v.stamps], v.id)
    if (v.stamps.length) add([v.type, ...v.stamps], v.id)          // "holo+1st-edition"
  }
  for (const v of vs.filter(v => v.size)) add([v.type, ...v.stamps, v.size], v.id)
  return out
}

/* ---------- review page ---------- */

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function report({ sets, groups, link, leftovers, skipped, cat, stats, version, trend, used }) {
  const euro = id => trend.get(id) != null ? ` <span class="price">€${trend.get(id).toFixed(2)}</span>` : ''
  const pname = id => id == null ? '—' : `${esc(cat.info.get(id)?.name ?? '(not in catalogue)')} <span class="id">${id}</span>${euro(id)}`
  const added = id => esc(cat.info.get(id)?.dateAdded?.slice(0, 10) ?? '')
  const blocks = []
  let toCheck = 0
  const ordered = [...groups].map(([exp, ss]) => ({ exp, ss }))
  ordered.push(...sets.filter(s => s.exp == null).map(s => ({ exp: null, ss: [s] })))
  for (const { exp, ss } of ordered) {
    const cards = ss.flatMap(s => s.cards)
    const count = { order: 0, name: 0, tcgdex: 0, override: 0, none: 0 }
    const fixed = [], choice = [], open = []
    for (const c of cards) {
      const l = link.get(c.id)
      count[l ? l.how : 'none']++
      if (!l) { open.push(c); continue }
      if (c.tcgdex == null || c.tcgdex === l.idProduct || l.how === 'override') continue
      // TCGdex's product fits this card too and no other card has it: two products for one card.
      const tp = cat.info.get(c.tcgdex)
      if (tp && tp.idExpansion === exp && !used.has(c.tcgdex) && productFitsCard(c, tp.name)) choice.push(c)
      else fixed.push(c)
    }
    toCheck += choice.length
    const left = exp != null ? leftovers.get(exp) : []
    const flag = choice.length || fixed.length || open.length || left.length
    const title = ss.map(s => `${esc(s.name)} <span class="id">${esc(s.id)}</span>`).join(' + ')
    const sortNum = (a, b) => a.localId.localeCompare(b.localId, 'en', { numeric: true })
    blocks.push(`<details class="set${flag ? ' flag' : ''}" data-q="${esc(ss.map(s => s.name + ' ' + s.id).join(' ').toLowerCase())}">
<summary><b>${title}</b> <span class="muted">${exp != null ? `Cardmarket ${esc(cat.setName.get(exp) ?? '')} <span class="id">e${exp}</span>` : 'no Cardmarket expansion'}</span>
<span class="chips"><span>${cards.length} cards</span>${exp != null ? `<span>${cat.singles.get(exp)?.length ?? 0} products</span>` : ''}
<span title="matched by catalogue order">order ${count.order}</span><span title="matched by unique name">name ${count.name}</span><span title="TCGdex's own link">TCGdex ${count.tcgdex}</span>${count.override ? `<span>yours ${count.override}</span>` : ''}
${choice.length ? `<span class="bad">${choice.length} to check</span>` : ''}${fixed.length ? `<span class="ok">${fixed.length} fixed</span>` : ''}${open.length ? `<span class="warn">${open.length} no link</span>` : ''}${left.length ? `<span class="warn">${left.length} extra products</span>` : ''}</span></summary>
${choice.length ? `<h4>Two products fit: check these</h4><p class="muted">Same name and attacks. The catalogue order picked one, TCGdex picks the other. Usually the one from the main batch is the regular card and the other a stamped or later version, but not always. Keep the choice, or put the other id in <code>mapping/overrides.json</code>.</p>
<table><tr><th>Card</th><th>Picked (catalogue order)</th><th>Added</th><th>TCGdex's pick</th><th>Added</th><th>Override line</th></tr>
${choice.sort(sortNum).map(c => { const l = link.get(c.id); return `<tr><td>${esc(c.localId)} ${esc(c.name)}</td><td>${pname(l.idProduct)}</td><td>${added(l.idProduct)}</td><td>${pname(c.tcgdex)}</td><td>${added(c.tcgdex)}</td><td><code>"${esc(c.id)}": ${c.tcgdex},</code></td></tr>` }).join('\n')}</table>` : ''}
${fixed.length ? `<h4>Fixed TCGdex links</h4><p class="muted">TCGdex's product belongs to another card of this set, or its name or attacks don't match this card.</p><table><tr><th>Card</th><th>TCGdex said</th><th>Now</th><th>How</th></tr>
${fixed.sort(sortNum).map(c => `<tr><td>${esc(c.localId)} ${esc(c.name)}</td><td>${pname(c.tcgdex)}</td><td>${pname(link.get(c.id).idProduct)}</td><td>${link.get(c.id).how}</td></tr>`).join('\n')}</table>` : ''}
${open.length ? `<h4>Cards without a product</h4><p class="muted">These fall back to TCGdex's prices in the app.</p><table><tr><th>Card</th><th>Note</th></tr>
${open.sort(sortNum).map(c => `<tr><td>${esc(c.localId)} ${esc(c.name)}</td><td>${skipped.has(c.id) ? `TCGdex links ${pname(skipped.get(c.id))}, but that belongs to another card` : c.tcgdex == null ? 'TCGdex has no link either' : ''}</td></tr>`).join('\n')}</table>` : ''}
${left.length ? `<h4>Products in this expansion no card got</h4><p class="muted">Usually misprints, stamped, jumbo or later-added versions.</p><table><tr><th>Product</th><th>Added</th></tr>
${left.map(p => `<tr><td>${pname(p.idProduct)}</td><td>${added(p.idProduct)}</td></tr>`).join('\n')}</table>` : ''}
${!flag ? '<p class="muted">Everything matched, nothing to review.</p>' : ''}
</details>`)
  }
  stats = { ...stats, toCheck }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Card mapping report</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--card:#fff;--warn:#9a5b00;--warnbg:#fff3df;--bad:#a1271b;--badbg:#fde8e5;--ok:#2b6b2f;--okbg:#e6f3e4}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#9c9b94;--line:#33322f;--card:#1f1f1d;--warn:#f0b35a;--warnbg:#3a2a12;--bad:#f08b7f;--badbg:#3d1c18;--ok:#8fd18f;--okbg:#1d3320}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}.id{color:var(--muted);font:12px ui-monospace,Menlo,monospace}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.stats div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.stats b{display:block;font-size:18px}
.tools{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:16px 0}
input[type=search]{flex:1;min-width:200px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);font:inherit}
.set{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:6px 0;padding:0 12px}
.set summary{cursor:pointer;padding:10px 0;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-left:auto}.chips span{font-size:12px;border:1px solid var(--line);border-radius:99px;padding:1px 8px}
.chips .ok{color:var(--ok);background:var(--okbg);border-color:transparent}.chips .warn{color:var(--warn);background:var(--warnbg);border-color:transparent}.chips .bad{color:var(--bad);background:var(--badbg);border-color:transparent}
h4{margin:12px 0 6px}table{border-collapse:collapse;width:100%;margin-bottom:12px;font-size:14px}
code{font:12px ui-monospace,Menlo,monospace}.price{font-variant-numeric:tabular-nums;color:var(--muted)}
td,th{text-align:left;padding:4px 8px;border-top:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--muted)}
.wrap{overflow-x:auto}
</style></head><body><main>
<h1>Card mapping report</h1>
<p class="muted">Built ${esc(version.slice(0, 16).replace('T', ' '))} UTC from the Cardmarket catalogue and TCGdex's card data.</p>
<div class="stats">
<div><b>${stats.mapped} / ${stats.cards}</b>cards linked</div>
<div><b>${stats.byOrder}</b>by catalogue order</div>
<div><b>${stats.byName}</b>by unique name</div>
<div><b>${stats.byTcgdex}</b>TCGdex's link</div>
<div><b>${stats.changedFromTcgdex}</b>differ from TCGdex</div>
<div><b>${stats.toCheck}</b>to check</div>
${stats.byOverride ? `<div><b>${stats.byOverride}</b>your overrides</div>` : ''}
${stats.byCustom ? `<div><b>${stats.byCustom}</b>your own cards (not in TCGdex)</div>` : ''}
</div>
<p class="muted">To change a link yourself, add it to <code>mapping/overrides.json</code> (create it if it isn't there) and run <code>npm run mapping</code> again:
<code>{ "sm1-24": 294121, "base1-58": null }</code>. A number links that product, <code>null</code> removes the link.</p>
<div class="tools"><input type="search" id="q" placeholder="Find a set (name or code, e.g. Team Rocket or base5)">
<label><input type="checkbox" id="only" checked> Only sets with something to review</label></div>
<div class="wrap">${blocks.join('\n')}</div>
</main>
<script>
const q=document.getElementById('q'),only=document.getElementById('only')
function filter(){const t=q.value.trim().toLowerCase();document.querySelectorAll('.set').forEach(d=>{d.hidden=(only.checked&&!d.classList.contains('flag'))||(t&&!d.dataset.q.includes(t))})}
q.addEventListener('input',filter);only.addEventListener('change',filter);filter()
</script></body></html>`
  return { html, toCheck }
}

main().catch(err => {
  console.error('FAILED:', err.stack || err.message)
  process.exit(1)
})
