// Shared helpers for the Card Watch data jobs. Node 20+, no dependencies.
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import path from 'node:path'

export const ROOT = process.cwd()
export const TIME_ZONE = 'Europe/Brussels'

// Cardmarket's public downloads for Pokémon (game 6). Overridable for testing.
const BASE = process.env.CM_BASE || 'https://downloads.s3.cardmarket.com/productCatalog'
export const URLS = {
  guide: `${BASE}/priceGuide/price_guide_6.json`,
  singles: `${BASE}/productList/products_singles_6.json`,
  nonsingles: `${BASE}/productList/products_nonsingles_6.json`,
}

export async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return fallback
    throw new Error(`${p} is not valid JSON: ${e.message}`)
  }
}

export async function writeJson(p, data, pretty = false) {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, pretty ? JSON.stringify(data, null, 2) + '\n' : JSON.stringify(data))
}

export async function head(url) {
  const res = await fetch(url, { method: 'HEAD' })
  if (!res.ok) throw new Error(`${url} answered HEAD ${res.status}`)
  return res.headers.get('etag')
}

export async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return res.json()
}

// "2026-10-14T02:53:25+0200" -> "2026-10-14" in Belgian time.
export function brusselsDay(createdAt) {
  const iso = String(createdAt).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error(`Can't read the price guide date "${createdAt}"`)
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export function isoTime(createdAt) {
  const d = new Date(String(createdAt).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// Files are grouped by Cardmarket expansion (one set = one small file), so the app only
// downloads the sets it needs. Products without an expansion share 50 overflow files.
export function bucketOf(idProduct, idExpansion) {
  return idExpansion != null ? `e${idExpansion}` : `x${idProduct % 50}`
}

// idProduct -> idExpansion, from catalog/products.json.
export async function loadExpansionIndex() {
  const cat = await readJson(path.join(ROOT, 'catalog', 'products.json'))
  const idx = new Map()
  if (cat) {
    const iId = cat.fields.indexOf('idProduct'), iExp = cat.fields.indexOf('idExpansion')
    for (const r of cat.rows) idx.set(r[iId], r[iExp])
  }
  return idx
}

export async function emptyDir(dir) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
}

export async function listJson(dir) {
  try {
    return (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}
