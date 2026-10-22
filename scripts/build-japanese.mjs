#!/usr/bin/env node
// Builds ja/cards.json: the Japanese cards TCGdex doesn't have, from TCGplayer's Japanese catalogue, plus
// TCGplayer's picture for TCGdex's Japanese cards that have none.
//
//   node scripts/build-japanese.mjs
//
// TCGdex's Japanese database is small (13k cards, 30% with a picture, no McDonald's or vintage promos).
// TCGplayer's (category 85, "Pokemon Japan") is mirrored daily as plain JSON by https://tcgcsv.com, free and
// without a key, but without CORS headers, so the app can't read it itself. Names there are English.
//
// TCGplayer groups are linked to TCGdex sets by set code (the group's abbreviation or "SV2a:" name prefix),
// else by mapping/ja-sets.json. In a linked set, a card TCGdex has (same number) only lends its picture;
// everything else becomes a row.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, readJson, writeJson } from './lib.mjs'

const TCGCSV = 'https://tcgcsv.com/tcgplayer/85'
const TCGDEX = 'https://api.tcgdex.net/v2/ja'
// Pokémon names in every language (one CSV): pairs unnumbered vintage cards, Japanese name ↔ English name.
const SPECIES_NAMES = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv'
// Hand links are code, not data: they live on main, next to the scripts.
const HAND_LINKS = fileURLToPath(new URL('../mapping/ja-sets.json', import.meta.url))

// TCGCSV refuses requests without a descriptive User-Agent (Node's default "node" gets 401).
const HEADERS = { 'User-Agent': 'card-watch-data (https://github.com/jeremygigase/card-watch-data)', Accept: 'application/json' }

async function getJsonRetry(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS })
      if (!res.ok) throw new Error(`${url} answered ${res.status}`)
      return await res.json()
    } catch (e) {
      if (i >= tries) throw e
      await new Promise((r) => setTimeout(r, 1000 * i))
    }
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

const compact = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9+]/g, '')
/** "007/165" → "7", "061/SV-P" → "61", "16" → "16", "SP1" → "sp1": the part that matches TCGdex's localId. */
export const numberKey = (n) => {
  const head = String(n).split('/')[0].trim().toLowerCase()
  return /^\d+$/.test(head) ? String(Number(head)) : head
}
/** "Squirtle - 007/165 (Master Ball Pattern)" → "Squirtle (Master Ball Pattern)": the number is shown apart. */
export const baseName = (name) => name.replace(/\s+-\s+[^\s()]*\d[^\s()]*(?=\s*(\(|$))/, '').trim()
const extended = (p) => Object.fromEntries((p.extendedData || []).map((e) => [e.name, e.value]))

/** Pokémon names from PokéAPI: Japanese → English ("ゼニガメ" → "Squirtle") and English → Pokédex number.
    Empty when PokéAPI can't be reached. */
async function speciesNames() {
  try {
    const res = await fetch(SPECIES_NAMES, { headers: HEADERS })
    if (!res.ok) throw new Error(`answered ${res.status}`)
    const byId = new Map()
    for (const line of (await res.text()).split('\n').slice(1)) {
      const [id, lang, name] = line.split(',')
      if (!name) continue
      const e = byId.get(id) || { ja: [] }
      if (lang === '9') e.en = name
      if (lang === '1' || lang === '11') e.ja.push(name)
      byId.set(id, e)
    }
    const toEnglish = new Map()
    const dexOf = new Map()
    for (const [id, e] of byId) {
      if (!e.en) continue
      e.ja.forEach((n) => toEnglish.set(n, e.en))
      const key = nameKey(e.en)
      dexOf.set(key, Number(id))
      if (/[♀♂]/.test(e.en)) dexOf.set(`${key.slice(0, -1)} ${key.slice(-1)}`, Number(id)) // "nidoran f" too
    }
    return { toEnglish, dexOf }
  } catch (e) {
    console.warn(`  PokéAPI's names unavailable (${e.message}): unnumbered vintage cards stay unpaired, no Pokédex numbers`)
    return { toEnglish: new Map(), dexOf: new Map() }
  }
}

/** Lower case, plain letters: "Farfetch’d" → "farfetch'd", "Flabébé" → "flabebe", "Nidoran♀" → "nidoranf". */
const nameKey = (name) =>
  name.toLowerCase().replace(/[’‘`]/g, "'").replace(/♀/g, 'f').replace(/♂/g, 'm').normalize('NFD').replace(/[̀-ͯ]/g, '')

/** TCGplayer's "Card Type" as TCGdex puts it: category, and the energy type (Pokémon) or trainer type. */
export function kindOf(cardType, hasHp) {
  const t = String(cardType || '')
  if (/^Trainer/.test(t)) {
    const sub = t.split(' - ')[1] || ''
    return ['Trainer', sub === 'Pokémon Tool' ? 'Tool' : sub]
  }
  if (/Energy$|^Special$/.test(t)) return ['Energy', '']
  if (hasHp || t) return ['Pokemon', t.split(';')[0]]
  return ['', '']
}

/** The Pokédex number in an English card name ("Ash's Squirtle", "Dark Wartortle", "Mewtwo ex"): the longest
    Pokémon name in it as whole words, 0 when there is none. */
export function dexIdOf(name, dexOf) {
  const words = nameKey(name).replace(/[^a-z0-9.':-]+/g, ' ').split(' ').filter(Boolean)
  let best = 0
  let bestLen = 0
  for (let i = 0; i < words.length; i++)
    for (let j = i + 1; j <= Math.min(words.length, i + 3); j++) {
      const phrase = words.slice(i, j).join(' ').replace(/'s$/, '')
      const id = dexOf.get(phrase)
      if (id && phrase.length > bestLen) [best, bestLen] = [id, phrase.length]
    }
  return best
}

/** Group code candidates: "SV2a: Pokemon Card 151" → "SV2a", plus the abbreviation. */
function codesOf(group) {
  const m = /^([^\s:]+(?: [^\s:]+)?):/.exec(group.name)
  return { prefix: m?.[1], abbreviation: group.abbreviation || undefined }
}

/** TCGdex set id → groupId: exact code first (case matters: "SM1+" vs "sm1+"), then ignoring case. */
function linkSets(tcgdexSets, groups, hand) {
  const links = new Map()
  const unlinked = []
  const byCode = (code, exact) => {
    const hits = (key) => groups.filter((g) => {
      const c = codesOf(g)[key]
      return c && (exact ? c.replace(/\s/g, '') === code : compact(c) === compact(code))
    })
    for (const key of ['prefix', 'abbreviation']) {
      const h = hits(key)
      if (h.length === 1) return h[0]
      if (h.length > 1) return null
    }
    return undefined
  }
  for (const s of tcgdexSets) {
    if (Object.hasOwn(hand, s.id)) {
      if (hand[s.id] != null) links.set(s.id, Number(hand[s.id]))
      continue
    }
    const g = byCode(s.id, true) ?? byCode(s.id, false)
    if (g) links.set(s.id, g.groupId)
    else unlinked.push(s)
  }
  return { links, unlinked }
}

async function main() {
  const hand = Object.fromEntries(Object.entries((await readJson(HAND_LINKS)) || {}).filter(([k]) => !k.startsWith('_')))

  console.log('Fetching TCGplayer\'s Japanese groups from TCGCSV …')
  const groups = (await getJsonRetry(`${TCGCSV}/groups`)).results
  const products = (await pool(groups, 8, (g) => getJsonRetry(`${TCGCSV}/${g.groupId}/products`).then((r) => r.results || []))).flat()
  console.log(`  ${groups.length} groups, ${products.length} products`)

  console.log('Fetching TCGdex\'s Japanese sets and cards …')
  const tcgdexSets = await getJsonRetry(`${TCGDEX}/sets`)
  const tcgdexCards = await getJsonRetry(`${TCGDEX}/cards`)

  const { links, unlinked } = linkSets(tcgdexSets, groups, hand)
  const setOfGroup = new Map([...links].map(([setId, groupId]) => [groupId, setId]))

  // TCGdex's cards per set, by number. A brief's id is "<setId>-<localId>".
  const tcgdexByNumber = new Map()
  const tcgdexBySet = new Map()
  for (const c of tcgdexCards) {
    const setId = c.id.slice(0, c.id.length - String(c.localId).length - 1)
    tcgdexByNumber.set(`${setId}|${numberKey(c.localId)}`, c)
    tcgdexBySet.set(setId, [...(tcgdexBySet.get(setId) || []), c])
  }

  // Singles only (sealed products have no number, HP or type), one card per group + number.
  const cards = new Map()
  for (const p of products) {
    const ext = extended(p)
    if (!ext.Number && !ext.HP && !ext.CardType) continue
    const key = ext.Number ? `${p.groupId}|${numberKey(ext.Number)}` : `p${p.productId}`
    const have = cards.get(key)
    const plain = (x) => !/\(/.test(x.p.name)
    const entry = { p, number: ext.Number || '', rarity: ext.Rarity && ext.Rarity !== 'None' ? ext.Rarity : '', kind: kindOf(ext.CardType, !!ext.HP) }
    if (!have || (plain(entry) && !plain(have)) || (plain(entry) === plain(have) && p.name.length < have.p.name.length)) cards.set(key, entry)
  }

  const art = {}
  const totals = new Map()
  const twinned = new Set() // TCGdex card ids that have their TCGplayer product
  const paired = new Set() // TCGplayer products that are a TCGdex card
  const pair = (twin, p) => {
    twinned.add(twin.id)
    paired.add(p.productId)
    if (!twin.image) art[twin.id] = p.productId
  }
  // 1. By number, in linked sets.
  for (const { p, number } of cards.values()) {
    const denom = /\/\s*(\d+)$/.exec(number)?.[1]
    if (denom) {
      const t = totals.get(p.groupId) || new Map()
      t.set(denom, (t.get(denom) || 0) + 1)
      totals.set(p.groupId, t)
    }
    const setId = setOfGroup.get(p.groupId)
    const twin = setId && number ? tcgdexByNumber.get(`${setId}|${numberKey(number)}`) : undefined
    if (twin && !twinned.has(twin.id)) pair(twin, p)
  }
  // 2. Vintage sets where TCGplayer has no numbers: by Pokémon name, when the name is there once on each side.
  const unnumbered = [...cards.values()].filter(({ p, number }) => !number && setOfGroup.has(p.groupId))
  const { toEnglish, dexOf } = await speciesNames()
  if (unnumbered.length) {
    const once = (list, nameOf) => {
      const m = new Map()
      for (const x of list) {
        const n = nameOf(x)
        if (n) m.set(n, m.has(n) ? null : x)
      }
      return m
    }
    const byGroup = new Map()
    for (const e of unnumbered) byGroup.set(e.p.groupId, [...(byGroup.get(e.p.groupId) || []), e])
    for (const [groupId, list] of byGroup) {
      const setId = setOfGroup.get(groupId)
      const ours = once((tcgdexBySet.get(setId) || []).filter((c) => !twinned.has(c.id)), (c) => toEnglish.get(c.name)?.toLowerCase())
      const theirs = once(list, (e) => baseName(e.p.name).toLowerCase())
      for (const [name, e] of theirs) {
        const twin = ours.get(name)
        if (e && twin) pair(twin, e.p)
      }
    }
  }
  const linkedCards = paired.size
  const rows = [...cards.values()]
    .filter(({ p }) => !paired.has(p.productId))
    .map(({ p, number, rarity, kind }) => {
      const name = baseName(p.name)
      return [p.productId, name, p.groupId, number, rarity, kind[0], kind[1], kind[0] === 'Pokemon' ? dexIdOf(name, dexOf) : 0]
    })
  rows.sort((a, b) => a[2] - b[2] || a[3].localeCompare(b[3], undefined, { numeric: true }) || a[0] - b[0])

  const usedGroups = new Set(rows.map((r) => r[2]))
  const groupsOut = groups
    .filter((g) => usedGroups.has(g.groupId) || setOfGroup.has(g.groupId))
    .map((g) => {
      const t = totals.get(g.groupId)
      const official = t ? Number([...t].sort((a, b) => b[1] - a[1])[0][0]) : null
      return [g.groupId, g.name, String(g.publishedOn || '').slice(0, 10), setOfGroup.get(g.groupId) ?? null, official]
    })

  const version = new Date().toISOString()
  await writeJson(path.join(ROOT, 'ja', 'cards.json'), {
    version,
    source: 'TCGplayer via https://tcgcsv.com (category 85) + https://api.tcgdex.net/v2/ja',
    fields: ['productId', 'name', 'groupId', 'number', 'rarity', 'category', 'type', 'dexId'],
    rows,
    groupFields: ['groupId', 'name', 'publishedOn', 'tcgdexSetId', 'official'],
    groups: groupsOut,
    art,
  })
  const stats = { groups: groups.length, linkedSets: links.size, tcgdexSets: tcgdexSets.length, rows: rows.length, linkedCards, art: Object.keys(art).length, updatedAt: version }
  const manifestPath = path.join(ROOT, 'manifest.json')
  const manifest = (await readJson(manifestPath)) || { version: 1, days: [] }
  manifest.japaneseVersion = version
  manifest.japanese = stats
  await writeJson(manifestPath, manifest, true)

  console.log(`TCGdex Japanese sets linked to a TCGplayer group: ${links.size} of ${tcgdexSets.length}`)
  console.log(`Cards only TCGplayer has: ${rows.length}; cards both have: ${linkedCards} (${stats.art} lend TCGdex a picture)`)
  if (unlinked.length) {
    console.log(`Not linked (add them to mapping/ja-sets.json, a groupId or null; TCGplayer's copies show next to TCGdex's until then):`)
    for (const s of unlinked) console.log(`  ${s.id}  ${s.name}`)
  }
  console.log('Wrote ja/cards.json')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e)
    process.exit(1)
  })
}
