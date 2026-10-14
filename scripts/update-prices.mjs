#!/usr/bin/env node
// Daily job: downloads Cardmarket's Pokémon price guide and product catalogue and updates
//   latest/<set>.json             today's full prices per product, one file per Cardmarket expansion
//   history/<YYYY-MM>/<set>.json  trend prices per product, stored only on days they change
//   catalog/products.json         every Pokémon product: id, name, expansion, category
//   archive/                      today's original file, gzipped (uploaded to a GitHub release, not committed)
//   manifest.json                 what's here: days recorded, last update, field names
//
// Safe to re-run: an unchanged price guide (same ETag) does nothing, and running twice on the
// same day overwrites that day instead of adding it twice. Any download error fails the run.
// Flags: --force  process even when the price guide's ETag hasn't changed.
import { writeFile, mkdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { ROOT, URLS, readJson, writeJson, head, getJson, brusselsDay, isoTime, bucketOf, emptyDir, listJson } from './lib.mjs'
import { rebucketMapping } from './mapping-lib.mjs'

const FORCE = process.argv.includes('--force')
const LATEST_FIELDS = ['low', 'trend', 'avg', 'avg1', 'avg7', 'avg30', 'low-holo', 'trend-holo', 'avg-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']
const HISTORY_FIELDS = ['trend', 'trend-holo']
const P = (...p) => path.join(ROOT, ...p)

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

async function updateCatalog(manifest) {
  const [singlesTag, nonsinglesTag] = await Promise.all([head(URLS.singles), head(URLS.nonsingles)])
  const have = await readJson(P('catalog', 'products.json'))
  if (have && !FORCE && singlesTag && singlesTag === manifest.catalog?.singlesEtag && nonsinglesTag === manifest.catalog?.nonsinglesEtag) {
    console.log('Catalogue unchanged.')
    return false
  }
  console.log('Downloading the product catalogue…')
  const [singles, nonsingles] = await Promise.all([getJson(URLS.singles), getJson(URLS.nonsingles)])
  const rows = [...singles.products, ...nonsingles.products].map(p => [
    p.idProduct, p.name, p.idExpansion ?? null, p.idCategory ?? null, p.categoryName ?? null, p.idMetacard ?? null, p.dateAdded ?? null,
  ])
  rows.sort((a, b) => a[0] - b[0])
  await writeJson(P('catalog', 'products.json'), {
    updatedAt: new Date().toISOString(),
    fields: ['idProduct', 'name', 'idExpansion', 'idCategory', 'categoryName', 'idMetacard', 'dateAdded'],
    count: rows.length,
    rows,
  })
  manifest.catalog = { singlesEtag: singlesTag, nonsinglesEtag: nonsinglesTag, count: rows.length, updatedAt: new Date().toISOString() }
  console.log(`  ${rows.length} products`)
  return true
}

async function main() {
  const manifest = (await readJson(P('manifest.json'))) || { version: 1, days: [] }

  const guideTag = await head(URLS.guide)
  if (!FORCE && guideTag && guideTag === manifest.guideEtag) {
    console.log(`Price guide unchanged (ETag ${guideTag}). Nothing to do.`)
    return
  }

  await updateCatalog(manifest)
  const cat = await readJson(P('catalog', 'products.json'))
  const expansionOf = new Map(cat.rows.map(r => [r[0], r[2]]))

  console.log('Downloading the price guide…')
  const guide = await getJson(URLS.guide)
  if (guide.version !== 1) throw new Error(`Unknown price guide version ${guide.version}. The script needs an update.`)
  if (!Array.isArray(guide.priceGuides) || guide.priceGuides.length < 1000) {
    throw new Error(`The price guide has only ${guide.priceGuides?.length ?? 0} products. Refusing to overwrite good data.`)
  }
  const day = brusselsDay(guide.createdAt)
  const month = day.slice(0, 7)
  console.log(`  ${guide.priceGuides.length} products, prices of ${day}`)

  // Keep the original file, gzipped, for the release archive (the workflow uploads it).
  await mkdir(P('archive'), { recursive: true })
  await writeFile(P('archive', `price_guide_6-${day}.json.gz`), gzipSync(JSON.stringify(guide)))

  // ---- latest: full prices per product, grouped by expansion ----
  const latest = new Map()
  const today = new Map()           // idProduct -> [trend, trend-holo]
  for (const g of guide.priceGuides) {
    const id = g.idProduct
    if (typeof id !== 'number') continue
    const b = bucketOf(id, expansionOf.get(id))
    if (!latest.has(b)) latest.set(b, {})
    latest.get(b)[id] = LATEST_FIELDS.map(f => num(g[f]))
    today.set(id, HISTORY_FIELDS.map(f => num(g[f])))
  }
  await emptyDir(P('latest'))
  for (const [b, rows] of latest) {
    await writeJson(P('latest', `${b}.json`), { day, fields: LATEST_FIELDS, p: rows })
  }
  console.log(`  wrote ${latest.size} latest files`)

  // ---- history: one point per product per change, per month ----
  // Each month file starts with the value on the first recorded day, so a month can be read on its own.
  const monthDir = P('history', month)
  const files = new Map()
  for (const f of await listJson(monthDir)) files.set(f.slice(0, -5), await readJson(path.join(monthDir, f)))
  const fileFor = (b) => {
    if (!files.has(b)) files.set(b, { fields: HISTORY_FIELDS, p: {} })
    return files.get(b)
  }
  const seen = new Set()
  const record = (b, id, vals) => {
    const series = (fileFor(b).p[id] ||= [])
    const last = series[series.length - 1]
    if (last && last[0] === day) {
      series.pop()                                           // re-run on the same day: replace it
      const prev = series[series.length - 1]
      if (!prev || !same(prev.slice(1), vals)) series.push([day, ...vals])
    } else if (!last || !same(last.slice(1), vals)) {
      series.push([day, ...vals])
    }
  }
  for (const [id, vals] of today) {
    record(bucketOf(id, expansionOf.get(id)), id, vals)
    seen.add(String(id))
  }
  // Products that disappeared from the price guide get an empty point, so the app stops showing an old price.
  for (const [b, file] of files) {
    for (const id of Object.keys(file.p)) {
      if (seen.has(id)) continue
      const last = file.p[id][file.p[id].length - 1]
      if (last && last[0] < day && !last.slice(1).every(v => v === null)) record(b, id, HISTORY_FIELDS.map(() => null))
    }
  }
  for (const [b, file] of files) await writeJson(path.join(monthDir, `${b}.json`), file)
  console.log(`  updated ${files.size} history files for ${month}`)

  // Products can move to another expansion when the catalogue changes; keep the mapping's file hints in step.
  const v = await rebucketMapping(expansionOf, manifest.catalog?.updatedAt)
  if (v) manifest.mappingVersion = v

  manifest.guideEtag = guideTag
  manifest.sourceCreatedAt = guide.createdAt
  manifest.sourceTime = isoTime(guide.createdAt)
  manifest.lastDay = day
  manifest.days = [...new Set([...(manifest.days || []), day])].sort()
  manifest.months = [...new Set(manifest.days.map(d => d.slice(0, 7)))]
  manifest.productCount = today.size
  manifest.latestFields = LATEST_FIELDS
  manifest.historyFields = HISTORY_FIELDS
  manifest.updatedAt = new Date().toISOString()
  await writeJson(P('manifest.json'), manifest, true)
  console.log('Done.')
}

main().catch(err => {
  console.error('FAILED:', err.stack || err.message)
  process.exit(1)
})
