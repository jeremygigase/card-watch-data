#!/usr/bin/env node
// Rebuilds history/ (and weekly/ for old months) from Cardmarket's original daily files, the ones the
// daily job uploads to the "archive-YYYY-MM" releases. Use it after the history format changed, or to
// fill a gap:
//
//   gh release download archive-2026-10 -D .cache/archive      # once per month you want back
//   npm run rebuild-history -- .cache/archive
//
// Every month that has files in <dir> is rebuilt from scratch; other months are left alone.
// The current catalogue decides which file (expansion) a product goes to.
import { readdir, readFile, rm } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { ROOT, readJson, writeJson, brusselsDay, loadExpansionIndex } from './lib.mjs'
import { HISTORY_FIELDS, HISTORY_VERSION, WEEKLY_FIELDS, valuesOf, writeMonth, recordDay, rollupDue, historySizes } from './history-lib.mjs'

async function main() {
  const dir = process.argv[2]
  if (!dir) throw new Error('Usage: node scripts/rebuild-history.mjs <folder with price_guide_6-YYYY-MM-DD.json.gz files>')
  const names = (await readdir(dir)).filter(f => /^price_guide_6-\d{4}-\d\d-\d\d\.json(\.gz)?$/.test(f)).sort()
  if (!names.length) throw new Error(`No price_guide_6-<day>.json.gz files in ${dir}`)

  const expansionOf = await loadExpansionIndex()
  if (!expansionOf.size) throw new Error('catalog/products.json is missing. Run the prices job first.')
  const manifest = (await readJson(path.join(ROOT, 'manifest.json'))) || { version: 1, days: [] }

  // Group the archive's days per month (the day comes from the guide itself, like the daily job).
  const byMonth = new Map()
  for (const f of names) {
    const month = f.slice(14, 21)
    if (!byMonth.has(month)) byMonth.set(month, [])
    byMonth.get(month).push(f)
  }

  const rebuiltDays = new Set()
  for (const [month, monthFiles] of byMonth) {
    if ((manifest.weeklyMonths || []).includes(month)) {
      console.log(`${month}: already rolled up into weeks, rebuilding it daily first`)
      await rm(path.join(ROOT, 'weekly', month), { recursive: true, force: true })
      manifest.weeklyMonths = manifest.weeklyMonths.filter(m => m !== month)
    }
    await rm(path.join(ROOT, 'history', month), { recursive: true, force: true })
    const files = new Map()
    for (const f of monthFiles) {
      let raw = await readFile(path.join(dir, f))
      if (f.endsWith('.gz')) raw = gunzipSync(raw)
      const guide = JSON.parse(raw.toString('utf8'))
      const day = brusselsDay(guide.createdAt)
      const today = new Map()
      for (const g of guide.priceGuides || []) if (typeof g.idProduct === 'number') today.set(g.idProduct, valuesOf(g))
      recordDay(files, day, today, expansionOf)
      rebuiltDays.add(day)
      console.log(`  ${day}: ${today.size} products`)
    }
    await writeMonth(month, files)
    console.log(`${month}: ${files.size} files`)
  }

  const keep = (manifest.days || []).filter(d => !byMonth.has(d.slice(0, 7)))
  manifest.days = [...new Set([...keep, ...rebuiltDays])].sort()
  const lastDay = manifest.lastDay && manifest.lastDay > manifest.days.at(-1) ? manifest.lastDay : manifest.days.at(-1)
  await rollupDue(manifest, lastDay)
  manifest.historyFields = HISTORY_FIELDS
  manifest.weeklyFields = WEEKLY_FIELDS
  manifest.historyVersion = HISTORY_VERSION
  manifest.historyBytes = await historySizes()
  manifest.updatedAt = new Date().toISOString()
  await writeJson(path.join(ROOT, 'manifest.json'), manifest, true)
  console.log('Done.')
}

main().catch(err => {
  console.error('FAILED:', err.stack || err.message)
  process.exit(1)
})
