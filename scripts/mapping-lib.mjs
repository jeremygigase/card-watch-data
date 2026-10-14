// Reading TCGdex's card files and keeping mapping/cards.json in step with the catalogue.
import path from 'node:path'
import { ROOT, readJson, writeJson, bucketOf } from './lib.mjs'

const MAPPING = path.join(ROOT, 'mapping', 'cards.json')

/* Find the end of the bracket that opens at text[start] ('[' or '{'), skipping strings. */
function matchBracket(text, start) {
  const open = text[start], close = open === '[' ? ']' : '}'
  let depth = 0, quote = null
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === open) depth++
    else if (c === close && --depth === 0) return i
  }
  return -1
}

const CM_ID = /thirdParty\s*:\s*\{[^{}]*?cardmarket\s*:\s*(\d+)/g

/* Card-level and per-variant Cardmarket product ids from one TCGdex card file. */
export function parseCardFile(text) {
  let variantsText = ''
  let outside = text
  const m = /\bvariants(?:_detailed)?\s*:\s*\[/.exec(text)
  if (m) {
    const start = m.index + m[0].length - 1
    const end = matchBracket(text, start)
    if (end > start) {
      variantsText = text.slice(start, end + 1)
      outside = text.slice(0, start) + text.slice(end + 1)
    }
  }
  const cardLevel = [...outside.matchAll(CM_ID)].map(x => Number(x[1]))

  const variants = []
  if (variantsText) {
    // Walk the top-level objects of the variants array.
    for (let i = 1; i < variantsText.length; i++) {
      if (variantsText[i] !== '{') continue
      const end = matchBracket(variantsText, i)
      if (end < 0) break
      const obj = variantsText.slice(i, end + 1)
      const id = /cardmarket\s*:\s*(\d+)/.exec(obj)
      if (id) {
        const type = (/type\s*:\s*["']([^"']+)["']/.exec(obj) || [])[1] || 'normal'
        const stamps = [...(((/stamp\s*:\s*\[([^\]]*)\]/.exec(obj) || [])[1] || '').matchAll(/["']([^"']+)["']/g))].map(s => s[1])
        variants.push({ type, stamps, id: Number(id[1]) })
      }
      i = end
    }
  }
  return { cardLevel: cardLevel[0] ?? null, variants }
}

/* The product the app follows for a card: the card-level id, else the plain (unstamped) variant. */
export function primaryProduct({ cardLevel, variants }) {
  if (cardLevel != null) return cardLevel
  const plain = variants.filter(v => !v.stamps.length)
  for (const t of ['normal', 'holo', 'reverse']) {
    const v = plain.find(x => x.type === t)
    if (v) return v.id
  }
  return (plain[0] || variants[0] || {}).id ?? null
}

export async function rebucketMapping(expansionOf, catalogVersion) {
  const map = await readJson(MAPPING)
  if (!map) return null
  if (catalogVersion && map.catalogVersion === catalogVersion) return null   // already in step
  for (const [id, entry] of Object.entries(map.cards)) entry[1] = bucketOf(entry[0], expansionOf.get(entry[0]))
  map.version = new Date().toISOString()
  map.catalogVersion = catalogVersion || null
  await writeJson(MAPPING, map)
  console.log('  updated set hints in mapping/cards.json')
  return map.version            // the caller stores it in manifest.mappingVersion
}
