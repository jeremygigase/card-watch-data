// Card art that TCGdex's API doesn't link. TCGdex leaves out `image` for many cards (and `logo` for some sets)
// although its image server has the pictures: Shining Legends and Dragon Majesty sit in folders without the dot
// (en/sm/sm35), recent promos and some Japanese and Chinese sets at the normal address. findArt() looks for them
// and returns their addresses in the form TCGdex's own `image` and `logo` take (no size, no extension).
//
// The image server can't list a folder and takes about 0.6 s per answer, so checking all ~17,000 unlinked cards
// would take half an hour. Instead it checks a few cards per set, and the whole set only when one is there (or
// when an earlier run found pictures in it).

const API = 'https://api.tcgdex.net/v2'
const ASSETS = 'https://assets.tcgdex.net'
export const ART_LANGS = ['en', 'ja', 'zh-tw', 'zh-cn']   // the languages the app offers
const SAMPLE = 6
const PARALLEL = 8

/** The app's code for a TCGdex card or set: "sm3.5-40" in English, "ja:S8b-1" in other languages. */
export const appId = (lang, id) => (lang === 'en' ? id : `${lang}:${id}`)
const langOf = key => /^(ja|zh-tw|zh-cn):/.exec(key)?.[1] ?? 'en'

/** The folders a set's pictures can be in: its id, and the id without dots ("sm3.5" -> "sm35"). */
export const folders = setId => [...new Set([setId, setId.replaceAll('.', '')])]

/** Up to n items spread over the list, the first and last included. */
export function spread(list, n) {
  if (list.length <= n) return list
  return [...new Set(Array.from({ length: n }, (_, i) => list[Math.round(i * (list.length - 1) / (n - 1))]))]
}

/* fn over all items, `limit` at a time; the results keep the items' order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/* TCGdex API JSON; null for a 404. Tries three times on a timeout, a rate limit or a server error. */
async function apiJson(url) {
  let last
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 2000 * attempt))
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (res.status === 404) return null
      if (res.ok) return await res.json()
      last = new Error(`${url} answered ${res.status}`)
    } catch (e) { last = e }
  }
  throw last
}

/* At most n calls running at once, however many sets are being looked at. */
function limiter(n) {
  let active = 0
  const queue = []
  const next = () => { if (active < n && queue.length) { active++; queue.shift()() } }
  return fn => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => { active--; next() }))
    next()
  })
}

/* Whether the image server has a file. A timeout or server error gets one more try, then counts as "no". */
async function exists(url, { stats, limit }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    stats.requests++
    try {
      const res = await limit(() => fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) }))
      if (res.status === 200) return true
      if (res.status === 404) return false
    } catch { /* timeout or network: once more */ }
  }
  stats.unclear++
  return false
}

/* Cards and logo of one set: { art, logos } with what was found or kept from the last run. */
async function setArt(lang, set, ctx) {
  const { previous, stats } = ctx
  const art = {}, logos = {}
  const serie = set.serie?.id
  if (!serie) return { art, logos }
  const base = folder => `${ASSETS}/${lang}/${serie}/${encodeURIComponent(folder)}`
  const cardUrl = (folder, c) => `${base(folder)}/${encodeURIComponent(c.localId)}`

  const unlinked = (set.cards ?? []).filter(c => !c.image)
  if (unlinked.length) {
    stats.sets++
    stats.unlinked += unlinked.length
    const todo = []
    for (const c of unlinked) {
      const id = appId(lang, c.id)
      if (previous.art?.[id]) { art[id] = previous.art[id]; stats.kept++ } else todo.push(c)
    }
    // Sample a few cards per folder; a set with a hit, or with pictures found before, is checked in full.
    const keptFolder = folders(set.id).find(f => Object.values(art).some(u => u.startsWith(base(f) + '/')))
    let folder = keptFolder
    const known = new Map()   // card id -> found in `folder`
    if (todo.length && !folder) {
      for (const f of folders(set.id)) {
        const sample = spread(todo, SAMPLE)
        const hits = await Promise.all(sample.map(c => exists(cardUrl(f, c) + '/low.webp', ctx)))
        if (hits.some(Boolean)) {
          folder = f
          sample.forEach((c, i) => known.set(c.id, hits[i]))
          break
        }
      }
    }
    if (folder) {
      const rest = todo.filter(c => !known.has(c.id))
      const hits = await Promise.all(rest.map(c => exists(cardUrl(folder, c) + '/low.webp', ctx)))
      rest.forEach((c, i) => known.set(c.id, hits[i]))
      for (const c of todo) if (known.get(c.id)) { art[appId(lang, c.id)] = cardUrl(folder, c); stats.found++ }
    }
  }

  if (!set.logo) {
    const key = appId(lang, set.id)
    if (previous.logos?.[key]) logos[key] = previous.logos[key]
    else for (const f of folders(set.id)) {
      // The app shows logos as .png and .webp, so both have to be there.
      if (await exists(`${base(f)}/logo.png`, ctx) && await exists(`${base(f)}/logo.webp`, ctx)) {
        logos[key] = `${base(f)}/logo`
        break
      }
    }
    if (logos[key]) stats.logos++
  }
  return { art, logos }
}

/**
 * Pictures TCGdex has but its API doesn't link: { art: {cardCode: base}, logos: {setCode: base}, stats }.
 * `previous` is the last run's { art, logos } (mapping/cards.json); its entries are kept without checking them
 * again while TCGdex still has no link of its own. If a language can't be read, its previous entries are kept.
 */
export async function findArt(previous = {}, log = console.log) {
  const started = Date.now()
  const stats = { sets: 0, unlinked: 0, found: 0, kept: 0, logos: 0, requests: 0, unclear: 0, seconds: 0 }
  const art = {}, logos = {}
  const ctx = { previous, stats, limit: limiter(PARALLEL) }
  for (const lang of ART_LANGS) {
    const before = { ...stats }
    try {
      const list = (await apiJson(`${API}/${lang}/sets`)) ?? []
      const sets = (await pool(list, PARALLEL, s => apiJson(`${API}/${lang}/sets/${encodeURIComponent(s.id)}`))).filter(Boolean)
      for (const found of await pool(sets, 4 * PARALLEL, set => setArt(lang, set, ctx))) {
        Object.assign(art, found.art)
        Object.assign(logos, found.logos)
      }
      log(`  ${lang}: ${sets.length} sets, ${stats.unlinked - before.unlinked} cards without a picture link, ` +
        `${stats.found - before.found} pictures found, ${stats.kept - before.kept} kept, ${stats.logos - before.logos} logos ` +
        `(${stats.requests - before.requests} image requests)`)
    } catch (e) {
      log(`  ${lang}: couldn't read TCGdex (${e.message}); keeping last run's pictures for it`)
      for (const [k, v] of Object.entries(previous.art ?? {})) if (langOf(k) === lang) art[k] = v
      for (const [k, v] of Object.entries(previous.logos ?? {})) if (langOf(k) === lang) logos[k] = v
    }
  }
  stats.seconds = Math.round((Date.now() - started) / 1000)
  return { art, logos, stats }
}
