// Links TCGdex cards to Cardmarket products by the order of the Cardmarket catalogue.
//
// Why: TCGdex sometimes gives two printings of the same card (for example the holo #5 and the
// non-holo #22 Dark Dragonite in Team Rocket) the same Cardmarket id. Cardmarket itself has a
// separate product for each, with the same name. Within an expansion, Cardmarket created its
// products in card-number order, so walking both lists in order tells them apart.
//
// How, per Cardmarket expansion:
//   1. "order": line up the TCGdex cards (sorted by number) with the expansion's products
//      (sorted by idProduct), pairing only cards and products whose names fit, keeping the order
//      (longest common subsequence). Products that don't fit the order (added later, misprints,
//      stamped versions) are left over.
//   2. "name": a card still without a product gets one when exactly one left-over product fits
//      its name, and that product fits no other card.
//   3. "tcgdex" (done by the caller, over all sets at once): otherwise TCGdex's own link is kept,
//      unless that product already belongs to another card that it fits better.
// A name "fits" when the base names are equal and the attack/ability names Cardmarket puts in
// brackets belong to that card.

/* Lowercase letters and digits only: "Mr. Mime" -> "mrmime", "Nidoran♂" -> "nidoran",
   "Shelgon δ" -> "shelgondelta", "Mudkip ☆" -> "mudkipstar". */
export function norm(s) {
  return String(s ?? '').replace(/δ/g, ' delta ').replace(/[☆★]/g, ' star ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/* "Dark Charizard [Nail Flick | Continuous Fireball]" ->
     { names: Set { "darkcharizard" }, tokens: ["nailflick", "continuousfireball"] }
   names are the ways the card's own name can be read from the product name:
   "Nidoran [M] [Horn Hazard]" -> nidoran, nidoranm · "Luxray [GL] LV.X [Bright Look | …]" -> luxray, luxraygllvx
   "Darkrai Lv.38 [Reach Over | …]" -> darkrai · "Professor's Research - Professor Willow" -> also professorsresearch */
const LEVEL = /\s*\bLv\.\s*\d+\b/gi
export function parseProductName(name) {
  // "Shelgon δ Delta Species [...]" is "Shelgon δ" in TCGdex; "Mudkip Gold Star" is "Mudkip Star".
  name = name.replace(/\s*\bDelta Species\b/g, '').replace(/\bGold Star\b/g, 'Star')
  const groups = [...name.matchAll(/\[([^\]]*)\]/g)]
  const tokens = []
  const labels = []   // short bracket labels as written: "[V]", "[!]" (Unown letters)
  for (const m of groups) for (const t of m[1].split('|')) {
    if (norm(t)) tokens.push(norm(t))
    if (t.trim().length <= 2) labels.push(t.trim().toLowerCase())
  }
  const first = name.indexOf('[')
  const base = norm((first < 0 ? name : name.slice(0, first)).replace(LEVEL, ''))
  const names = new Set([base])
  for (const t of tokens) names.add(base + t)
  // Everything except the last bracket group (the attacks), without "Lv.38".
  const last = groups.length ? groups[groups.length - 1] : null
  names.add(norm((last ? name.slice(0, last.index) + name.slice(last.index + last[0].length) : name).replace(LEVEL, '')))
  if (name.includes(' - ')) names.add(norm(name.split(' - ')[0]))
  if (/^Basic .*Energy/.test(name)) names.add(norm(name.replace(/^Basic /, '')))   // "Basic Grass Energy" = "Grass Energy"
  names.delete('')
  return { base, tokens, labels, names }
}

/* Card numbers: plain numbers first in numeric order, then prefixed ones ("H1", "SV001", "RC5") per prefix. */
export function numberKey(localId) {
  const m = /^(\D*)(\d+)(.*)$/.exec(localId)
  if (!m) return [1, localId.toLowerCase(), 0, '']
  return [m[1] ? 1 : 0, m[1].toLowerCase(), Number(m[2]), m[3].toLowerCase()]
}
export function compareNumbers(a, b) {
  const x = numberKey(a), y = numberKey(b)
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/* cards: [{ id, localId, name, moves: [names], group? }], products: [{ idProduct, name }] (one expansion).
   Returns { links: Map(cardId -> { idProduct, how }), leftover: [products not linked] }. */
export function matchExpansion(cards, products) {
  // Cards from several TCGdex sets can share one expansion (a set plus its Trainer Gallery, both halves
  // of a trainer kit); each keeps its own block, in the order given by c.group.
  cards = [...cards].sort((a, b) => (a.group ?? 0) - (b.group ?? 0) || compareNumbers(a.localId, b.localId))
  products = [...products].sort((a, b) => a.idProduct - b.idProduct)

  const moveWords = new Set(), letterIds = new Set()
  const C = cards.map(c => {
    const moves = new Set((c.moves || []).map(norm).filter(Boolean))
    moves.forEach(m => moveWords.add(m))
    let lid = c.localId
    try { lid = decodeURIComponent(lid) } catch {}                 // "%3F" -> "?"
    lid = lid.toLowerCase()
    if (/^\D{1,2}$/.test(lid)) letterIds.add(lid)            // "A", "!", "?" (Unown collection)
    return { ...c, n: norm(c.name), moves, lid }
  })
  const P = products.map(p => ({ ...p, ...parseProductName(p.name) }))

  const fits = (c, p) => {
    if (!p.names.has(c.n)) return false
    // "Unown [V]" belongs to card V when the set numbers its cards by letter.
    const letters = p.labels.filter(l => letterIds.has(l))
    if (letters.length && !letters.includes(c.lid)) return false
    if (!c.moves.size) return true
    // Bracket words that are attack/ability names in this set must be this card's.
    return p.tokens.every(t => !moveWords.has(t) || c.moves.has(t))
  }

  // 1. Longest common subsequence of fitting pairs.
  const n = C.length, m = P.length, W = m + 1
  const dp = new Int32Array((n + 1) * W)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const f = fits(C[i - 1], P[j - 1])
      const best = Math.max(dp[(i - 1) * W + j], dp[i * W + j - 1])
      dp[i * W + j] = f ? Math.max(best, dp[(i - 1) * W + j - 1] + 1) : best
    }
  }
  const links = new Map(), usedP = new Set()
  // Walk back from the end. When there's a choice, skip a product rather than a card:
  // extra products (later additions, misprints) usually sit outside the main run.
  for (let i = n, j = m; i > 0 && j > 0;) {
    const here = dp[i * W + j]
    if (here === dp[i * W + j - 1]) j--
    else if (here === dp[(i - 1) * W + j]) i--
    else {
      links.set(C[i - 1].id, { idProduct: P[j - 1].idProduct, how: 'order' })
      usedP.add(P[j - 1].idProduct)
      i--; j--
    }
  }

  // 2. Unique name fit among what's left.
  const freeP = P.filter(p => !usedP.has(p.idProduct))
  const freeC = C.filter(c => !links.has(c.id))
  for (const c of freeC) {
    const cand = freeP.filter(p => !usedP.has(p.idProduct) && fits(c, p))
    if (cand.length !== 1) continue
    const p = cand[0]
    if (freeC.filter(o => o !== c && !links.has(o.id) && fits(o, p)).length) continue
    links.set(c.id, { idProduct: p.idProduct, how: 'name' })
    usedP.add(p.idProduct)
  }

  return { links, leftover: products.filter(p => !usedP.has(p.idProduct)) }
}

/* The card's English name and its attack/ability names, from a TCGdex card .ts file. */
export function parseCardMeta(text, matchBracket) {
  const enOf = block => {
    const s = /\ben\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(block)
    return s ? s[1].replace(/\\(.)/g, '$1') : null
  }
  let name = null
  const nm = /\bname\s*:\s*/.exec(text)
  if (nm) {
    const at = nm.index + nm[0].length
    if (text[at] === '{') name = enOf(text.slice(at, matchBracket(text, at) + 1))
    else { const s = /^"((?:[^"\\]|\\.)*)"/.exec(text.slice(at)); if (s) name = s[1] }
  }
  const moves = []
  for (const key of ['abilities', 'attacks']) {
    const k = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(text)
    if (!k) continue
    const start = k.index + k[0].length - 1
    const block = text.slice(start, matchBracket(text, start) + 1)
    for (const mm of block.matchAll(/\bname\s*:\s*\{([^{}]*)\}/g)) { const e = enOf(mm[1]); if (e) moves.push(e) }
  }
  return { name, moves }
}

/* Looser check for one card and one product, without the rest of the set: the name fits and,
   when both have attack names, at least one is shared. */
export function productFitsCard(card, productName) {
  const p = parseProductName(productName)
  if (!p.names.has(norm(card.name))) return false
  const moves = new Set((card.moves || []).map(norm).filter(Boolean))
  return !moves.size || !p.tokens.length || p.tokens.some(t => moves.has(t))
}
