// Price history files, shared by the daily job (update-prices.mjs) and rebuild-history.mjs.
//
//   history/<YYYY-MM>/<file>.json  daily: {fields, p: {idProduct: [[day, ...values], …]}}
//                                  a point is written only when one of the values changed; it holds
//                                  until the next point. A point with no values means the product left
//                                  the price guide. Trailing nulls are left out of each point.
//   weekly/<YYYY-MM>/<file>.json   months older than DAILY_DAYS, rolled up into four "weeks" per month
//                                  (days 1–7, 8–14, 15–21, 22–end): {fields, p: {idProduct: [[startDay, ...values], …]}}
//                                  with the mean of every field plus the lowest and highest trend of that week.
//                                  Also change-only: a week holds until the next point.
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, readJson, writeJson, listJson, bucketOf } from './lib.mjs'

export const LATEST_FIELDS = ['low', 'trend', 'avg', 'avg1', 'avg7', 'avg30', 'low-holo', 'trend-holo', 'avg-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']
export const HISTORY_FIELDS = LATEST_FIELDS
export const HISTORY_VERSION = 2
export const WEEKLY_FIELDS = [...LATEST_FIELDS, 'trend-min', 'trend-max']
/** Days kept as daily points; older months are rolled up into weeks. */
export const DAILY_DAYS = 90

const P = (...p) => path.join(ROOT, ...p)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const cents = (v) => Math.round(v * 100) / 100

/** The guide's fields of one product, in HISTORY_FIELDS order. */
export const valuesOf = (g) => HISTORY_FIELDS.map(f => num(g[f]))

/** [day, ...values] without trailing nulls. */
export function packPoint(day, vals) {
  let n = vals.length
  while (n > 0 && vals[n - 1] == null) n--
  return [day, ...vals.slice(0, n)]
}

/** Values of a point, padded to n fields. */
export function unpackPoint(point, n) {
  const out = point.slice(1, n + 1)
  while (out.length < n) out.push(null)
  return out
}

const sameValues = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

/** A month file written with other fields (the first files kept only trend and trend-holo) is
    converted to HISTORY_FIELDS; fields it didn't have become null. */
export function upgradeMonth(file) {
  if (file.fields && sameValues(file.fields, HISTORY_FIELDS)) return file
  const from = file.fields || ['trend', 'trend-holo']
  const idx = HISTORY_FIELDS.map(f => from.indexOf(f))
  const p = {}
  for (const [id, series] of Object.entries(file.p)) {
    p[id] = series.map(pt => {
      const old = unpackPoint(pt, from.length)
      return packPoint(pt[0], idx.map(i => (i < 0 ? null : old[i])))
    })
  }
  return { fields: HISTORY_FIELDS, p }
}

/** Reads every daily file of a month (upgraded to the current fields). */
export async function readMonth(month) {
  const dir = P('history', month)
  const files = new Map()
  for (const f of await listJson(dir)) files.set(f.slice(0, -5), upgradeMonth(await readJson(path.join(dir, f))))
  return files
}

export async function writeMonth(month, files) {
  for (const [b, file] of files) await writeJson(P('history', month, `${b}.json`), file)
}

/** Adds one day to a month's files. today: Map idProduct -> values (HISTORY_FIELDS order).
    Running the same day again replaces it. Products missing from today's guide get an empty point. */
export function recordDay(files, day, today, expansionOf) {
  const n = HISTORY_FIELDS.length
  const fileFor = (b) => {
    if (!files.has(b)) files.set(b, { fields: HISTORY_FIELDS, p: {} })
    return files.get(b)
  }
  const record = (file, id, vals) => {
    const series = (file.p[id] ||= [])
    if (series.length && series[series.length - 1][0] === day) series.pop()   // re-run of the same day
    const prev = series[series.length - 1]
    if (!prev || !sameValues(unpackPoint(prev, n), vals)) series.push(packPoint(day, vals))
    if (!series.length) delete file.p[id]
  }
  const seen = new Set()
  for (const [id, vals] of today) {
    record(fileFor(bucketOf(id, expansionOf.get(id))), id, vals)
    seen.add(String(id))
  }
  const empty = HISTORY_FIELDS.map(() => null)
  for (const file of files.values()) {
    for (const id of Object.keys(file.p)) {
      if (seen.has(id)) continue
      const series = file.p[id]
      const last = series[series.length - 1]
      if (last && last[0] <= day && last.length > 1) record(file, id, empty)
    }
  }
}

/* ---- weekly roll-up ---- */

const weekOf = (day) => Math.min(3, Math.floor((Number(day.slice(8, 10)) - 1) / 7))
const weekStart = (month, w) => `${month}-${String(1 + w * 7).padStart(2, '0')}`

/** Rolls one product's daily points over the recorded days of a month into up to four weeks. */
export function rollupSeries(series, days, month) {
  const n = HISTORY_FIELDS.length
  const iTrend = HISTORY_FIELDS.indexOf('trend')
  const weeks = [0, 1, 2, 3].map(() => ({ sum: Array(n).fill(0), cnt: Array(n).fill(0), min: null, max: null }))
  let i = -1
  for (const d of days) {
    while (i + 1 < series.length && series[i + 1][0] <= d) i++
    if (i < 0) continue                                     // the product didn't exist yet
    const vals = unpackPoint(series[i], n)
    const w = weeks[weekOf(d)]
    vals.forEach((v, k) => { if (v != null) { w.sum[k] += v; w.cnt[k]++ } })
    const t = vals[iTrend]
    if (t != null) {
      w.min = w.min == null ? t : Math.min(w.min, t)
      w.max = w.max == null ? t : Math.max(w.max, t)
    }
  }
  // Like daily points, a week is only written when it differs from the week before (it holds until the
  // next point); the month's first week is always written so a month file can be read on its own.
  const recorded = new Set(days.map(weekOf))                // weeks with at least one recorded day
  const out = []
  let prev = null
  weeks.forEach((w, k) => {
    let vals
    if (w.cnt.some(c => c > 0)) {
      const means = w.sum.map((s, f) => (w.cnt[f] ? cents(s / w.cnt[f]) : null))
      vals = [...means, w.min, w.max]
    } else if (recorded.has(k) && prev && prev.some(v => v != null)) {
      vals = prev.map(() => null)                           // left the price guide: an empty point, like daily
    } else return
    if (!out.length && vals.every(v => v == null)) return
    if (prev && sameValues(prev, vals)) return
    out.push(packPoint(weekStart(month, k), vals))
    prev = vals
  })
  return out
}

/** Rolls a daily month into weekly/<month>/ and deletes history/<month>/. days: its recorded days. */
export async function rollupMonth(month, days) {
  const files = await readMonth(month)
  for (const [b, file] of files) {
    const p = {}
    for (const [id, series] of Object.entries(file.p)) {
      const weeks = rollupSeries(series, days, month)
      if (weeks.length) p[id] = weeks
    }
    await writeJson(P('weekly', month, `${b}.json`), { fields: WEEKLY_FIELDS, p })
  }
  await rm(P('history', month), { recursive: true, force: true })
}

/** Months whose last calendar day is more than DAILY_DAYS before `today` and that are still daily. */
export function monthsToRollUp(manifest, today) {
  const cut = new Date(`${today}T12:00:00Z`)
  cut.setUTCDate(cut.getUTCDate() - DAILY_DAYS)
  const cutDay = cut.toISOString().slice(0, 10)
  const months = [...new Set((manifest.days || []).map(d => d.slice(0, 7)))]
  return months.filter(m => {
    const [y, mo] = m.split('-').map(Number)
    const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)   // last day of that month
    return last < cutDay && !(manifest.weeklyMonths || []).includes(m)
  })
}

/** Rolls up what is due and keeps the manifest's lists in step. */
export async function rollupDue(manifest, today) {
  for (const month of monthsToRollUp(manifest, today)) {
    const days = manifest.days.filter(d => d.startsWith(month))
    console.log(`  rolling ${month} up into weeks (${days.length} days)`)
    await rollupMonth(month, days)
    manifest.weeklyMonths = [...new Set([...(manifest.weeklyMonths || []), month])].sort()
    manifest.days = manifest.days.filter(d => !d.startsWith(month))
  }
  manifest.weeklyMonths ||= []
  manifest.months = [...new Set((manifest.days || []).map(d => d.slice(0, 7)))]
}

/** Size of history/ and weekly/ per month, in bytes (logged and kept in the manifest). */
export async function historySizes() {
  const sizes = {}
  for (const kind of ['history', 'weekly']) {
    let months = []
    try { months = (await readdir(P(kind))).filter(m => /^\d{4}-\d\d$/.test(m)) } catch {}
    for (const m of months.sort()) {
      let total = 0
      for (const f of await listJson(P(kind, m))) total += (await stat(P(kind, m, f))).size
      sizes[`${kind}/${m}`] = total
    }
  }
  return sizes
}
