#!/usr/bin/env node
// Weekly job: builds mapping/cards.json, which links TCGdex card codes (like "neo1-6") to
// Cardmarket product ids (like 274406), from TCGdex's open card database.
//
//   node scripts/build-mapping.mjs <path to a checkout of tcgdex/cards-database>
//
// The workflow does a small sparse checkout of just its data/ folder first.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, readJson, writeJson, bucketOf, loadExpansionIndex } from './lib.mjs'
import { parseCardFile, primaryProduct } from './mapping-lib.mjs'

const SRC = process.argv[2]
if (!SRC) {
  console.error('Usage: node scripts/build-mapping.mjs <tcgdex cards-database checkout>')
  process.exit(1)
}

async function dirs(p) { return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name) }
async function tsFiles(p) { return (await readdir(p, { withFileTypes: true })).filter(d => d.isFile() && d.name.endsWith('.ts')).map(d => d.name) }

async function main() {
  const data = path.join(SRC, 'data')                 // English/international sets (data-asia is Japanese and others)
  const expansionOf = await loadExpansionIndex()
  const cards = {}, variants = {}, sets = {}
  const stats = { sets: 0, cards: 0, mapped: 0, unknownToCatalogue: 0, noSetId: 0 }

  for (const serie of await dirs(data)) {
    const serieDir = path.join(data, serie)
    for (const setName of await dirs(serieDir)) {
      const setFile = path.join(serieDir, setName + '.ts')
      let setText
      try { setText = await readFile(setFile, 'utf8') } catch { continue }
      const setId = (/\bid\s*:\s*["']([^"']+)["']/.exec(setText) || [])[1]
      if (!setId) { stats.noSetId++; continue }
      stats.sets++
      const exp = /thirdParty\s*:\s*\{[^{}]*?cardmarket\s*:\s*(\d+)/.exec(setText)
      if (exp) sets[setId] = Number(exp[1])

      const setDir = path.join(serieDir, setName)
      for (const f of await tsFiles(setDir)) {
        stats.cards++
        const localId = f.slice(0, -3)
        const parsed = parseCardFile(await readFile(path.join(setDir, f), 'utf8'))
        const product = primaryProduct(parsed)
        if (product == null) continue
        const cardId = `${setId}-${localId}`
        cards[cardId] = [product, bucketOf(product, expansionOf.get(product))]
        stats.mapped++
        if (expansionOf.size && !expansionOf.has(product)) stats.unknownToCatalogue++
        const distinct = new Set(parsed.variants.map(v => v.id))
        if (distinct.size > 1 || (parsed.cardLevel != null && parsed.variants.some(v => v.id !== parsed.cardLevel))) {
          variants[cardId] = Object.fromEntries(parsed.variants.map(v => [[v.type, ...v.stamps].join('+'), v.id]))
        }
      }
    }
  }

  const version = new Date().toISOString()
  await writeJson(path.join(ROOT, 'mapping', 'cards.json'), {
    version,
    catalogVersion: expansionOf.size ? ((await readJson(path.join(ROOT, 'manifest.json')))?.catalog?.updatedAt ?? null) : null,
    source: 'https://github.com/tcgdex/cards-database',
    fields: ['idProduct', 'file'],
    cards,
    variants,
    sets,
  })

  const manifest = (await readJson(path.join(ROOT, 'manifest.json'))) || { version: 1, days: [] }
  manifest.mappingVersion = version
  manifest.mapping = { ...stats, updatedAt: version }
  await writeJson(path.join(ROOT, 'manifest.json'), manifest, true)

  console.log(`Sets: ${stats.sets}, cards: ${stats.cards}, linked to Cardmarket: ${stats.mapped} (${Math.round(stats.mapped / stats.cards * 100)}%)`)
  if (stats.unknownToCatalogue) console.log(`  ${stats.unknownToCatalogue} linked products aren't in the current catalogue`)
  if (stats.noSetId) console.log(`  ${stats.noSetId} set files without an id were skipped`)
}

main().catch(err => {
  console.error('FAILED:', err.stack || err.message)
  process.exit(1)
})
