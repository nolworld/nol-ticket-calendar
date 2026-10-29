// Reads the NOL ticket lists and writes site/events.json for the calendar.
// Runs daily in GitHub Actions (see .github/workflows/update.yml).
//
// One pass with NOL World's filter (globalType=EN) gives the products sold on
// NOL World with their NOL World names; one pass without it gives every NOL
// product. Korean names, venues and presale schedules come from each product's
// Korean NOL page and are cached in data/names-ko.json, so each day only new
// products, products with a ticket open coming up, and entries older than 7
// days are read again.
//
// If any list fails, the script exits with an error before writing anything, so
// the site keeps the previous day's data.
import fs from "node:fs"

const API = "https://world.nol.com/api/ent-channel-out/v1/goods/list"
const PRODUCT_PAGE = "https://nol.yanolja.com/ticket/products/"
const PAGE_SIZE = 100 // the endpoint rejects anything above 100
const GENRES = ["CONCERT", "MUSICAL", "SPORTS", "EXHIBIT"]
const SCOPES = {
  world: { globalType: "EN", languageType: "EN" },
  all: { languageType: "KO" },
}
const OUT = "site/events.json"
const NAMES = "data/names-ko.json"
const NAME_TTL = 7 * 24 * 60 * 60 * 1000 // re-check a cached Korean name after 7 days
const UA = "Mozilla/5.0 (compatible; nol-ticket-calendar/1.0)"
// Product pages are read the same way they were verified (an ordinary browser request)
const PAGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

// Concert sub-genres -> calendar chip. Anything else is "c" (콘서트).
const CONCERT_SUB = { "03017": "i", "03024": "f", "03006": "m", "03025": "m" }
const SHOW_SUB = /토크|개그|마술|디너쇼|talk|comedy|magic|dinner/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

async function fetchPage(scope, genre, page) {
  const url = new URL(API)
  url.search = new URLSearchParams({
    ...SCOPES[scope],
    includeNonPartnerGoods: "true",
    goodsStatus: "Y,D",
    genreType: genre,
    page: String(page),
    size: String(PAGE_SIZE),
  }).toString()
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "accept-language": "en-US,en;q=0.9",
          referer: `https://world.nol.com/en/ticket/genre/${genre}/products`,
          "user-agent": UA,
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`${scope} ${genre} page ${page}: HTTP ${res.status}`)
      const data = (await res.json())?.data
      if (!data || !Array.isArray(data.content)) throw new Error(`${scope} ${genre} page ${page}: unexpected response shape`)
      return data
    } catch (err) {
      lastError = err
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  throw lastError
}

async function fetchGenre(scope, genre) {
  const items = []
  let total = 0
  for (let page = 0; page < 20; page++) {
    const data = await fetchPage(scope, genre, page)
    total = data.totalElements
    items.push(...data.content)
    if (data.content.length < PAGE_SIZE || page >= data.totalPages - 1) break
  }
  // A partial list would silently drop shows, so treat it as a failed run.
  if (items.length < total) throw new Error(`${scope} ${genre}: got ${items.length} of ${total} products`)
  return items
}

// ---------- Korean NOL product page ----------

// The page embeds its data as escaped JSON; undo one level of escaping
const unesc = (t) => t.replace(/\\\\/g, "\u0000").replace(/\\"/g, '"').replace(/\u0000/g, "\\")

// Raw JSON text of the value after "key": (balanced for arrays/objects)
function rawValue(t, key) {
  const k = t.indexOf(`"${key}":`)
  if (k === -1) return null
  let i = k + key.length + 3
  while (t[i] === " ") i++
  const open = t[i]
  if (open === "[" || open === "{") {
    const close = open === "[" ? "]" : "}"
    let depth = 0, inStr = false
    for (let j = i; j < t.length && j < i + 50000; j++) {
      const c = t[j]
      if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === open) depth++
      else if (c === close && --depth === 0) return t.slice(i, j + 1)
    }
    return null
  }
  if (open === '"') {
    let j = i + 1
    while (j < t.length && t[j] !== '"') j += t[j] === "\\" ? 2 : 1
    return t.slice(i, j + 1)
  }
  return t.slice(i, i + 30).split(/[,}\]]/)[0]
}
function value(t, key) {
  const raw = rawValue(t, key)
  if (raw == null) return null
  try { return JSON.parse(raw) } catch { return null }
}
const minute = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) ? s.replace("T", " ").slice(0, 16) : null)

// JSON object starting at t[s] (balanced, string-aware), or null
function objectAt(t, s) {
  let depth = 0, inStr = false
  for (let j = s; j < t.length && j < s + 200000; j++) {
    const c = t[j]
    if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === "{") depth++
    else if (c === "}" && --depth === 0) return { end: j + 1, text: t.slice(s, j + 1) }
  }
  return null
}

// Fields of the objects on the page whose goodsCode is this product. Pages also
// list related products (other matches, other dates), so the first "goodsName"
// on a page is not always this product's.
function productFields(t, code) {
  const merged = {}
  const needle = `"goodsCode":"${code}"`
  let k = t.indexOf(needle), seen = 0
  while (k !== -1 && seen < 20) {
    seen++
    // innermost object around this occurrence that parses and has the same goodsCode
    let s = k, tries = 0
    while ((s = t.lastIndexOf("{", s - 1)) !== -1 && tries++ < 40 && k - s < 60000) {
      const o = objectAt(t, s)
      if (!o || o.end <= k) continue
      let obj
      try { obj = JSON.parse(o.text) } catch { continue }
      if (obj && obj.goodsCode === code) {
        for (const [key, v] of Object.entries(obj)) if (merged[key] === undefined && v !== null && v !== "") merged[key] = v
        break
      }
    }
    k = t.indexOf(needle, k + needle.length)
  }
  return merged
}

// Presale rounds: [{ label, start, end|null }] from this product's own fields
function salesOf(f) {
  const sales = []
  const presales = f.presales ?? f.preSales
  if (Array.isArray(presales)) {
    for (const p of presales) {
      const start = minute(p?.bookingOpenTime)
      if (!start) continue
      const button = String(p.buttonName ?? "").trim()
      const label = button && button !== "선예매" ? button : String(p.preBookingKindName ?? "").trim() || "선예매"
      sales.push({ label, start, end: minute(p.bookingEndTime) })
    }
  }
  // Some products only announce the presale start (ticket open type 3 = other open)
  if (!sales.length && Number(f.ticketOpenType) === 3) {
    const start = minute(f.ticketOpenDate)
    const label = String(f.ticketOtherOpenName ?? "").trim() || "선예매"
    if (start) sales.push({ label, start, end: null })
  }
  const seen = new Set()
  return sales
    .filter((x) => { const k = x.label + x.start; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => a.start.localeCompare(b.start))
}

// First value of `key` anywhere inside an object (a few levels deep)
function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined
  if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key]
  for (const v of Object.values(obj)) {
    const r = findKey(v, key, depth + 1)
    if (r !== undefined) return r
  }
  return undefined
}

// Show time text as written on NOL, tidied: "금 저녁 7시 30분", "10월30일(금) 19시30분 / 10월31일(토) 16시"
function tidyTime(s) {
  return String(s)
    .split(/\r?\n|<br\s*\/?>/i)
    .map((x) => x.replace(/^[\s\-•·*※]+/, "").replace(/^(공연|관람|경기)\s*(시간|일시)?\s*[:：]\s*/, "").trim())
    .filter(Boolean)
    .join(" / ")
    .replace(/\s+/g, " ")
    .slice(0, 160)
}

// Returns { data } on success, or { status } (HTTP status, or 0 for a network error)
async function fetchProduct(code) {
  try {
    const res = await fetch(PRODUCT_PAGE + code, {
      headers: { "user-agent": PAGE_UA, "accept-language": "ko-KR,ko;q=0.9" },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return { status: res.status }
    const t = unesc(await res.text())
    const f = productFields(t, code)
    const name = f.goodsName
    if (typeof name !== "string" || !name.trim()) return { status: "no-data" }
    // Presale fields may sit in a separate object; fall back to the page-wide value
    // only when the page's first product is this one
    if (f.presales === undefined && f.ticketOpenType === undefined && value(t, "goodsName") === name) {
      for (const key of ["presales", "ticketOpenType", "ticketOpenDate", "ticketOtherOpenName"]) {
        const v = value(t, key)
        if (v !== null && v !== "") f[key] = v
      }
    }
    const venue = f.placeName
    const ps = typeof f.playStartDate === "string" ? f.playStartDate.slice(0, 10) : ""
    // Show time: this product's own fields first; the page-wide value only when the
    // page's first product is this one (pages also list related products)
    let info = findKey(f, "playTimeInfo"), start = findKey(f, "playTime")
    if (info === undefined && start === undefined && value(t, "goodsName") === name) {
      info = value(t, "playTimeInfo") ?? undefined
    }
    const pt = typeof info === "string" && info.trim() ? tidyTime(info)
      : typeof start === "string" && /^\d{1,2}:\d{2}$/.test(start.trim()) ? start.trim() : ""
    const rt = Number(findKey(f, "runningTime")) || 0
    return { data: { n: name.trim(), v: typeof venue === "string" ? venue.trim() : "", s: salesOf(f), ps, pt, rt, k: 4 } }
  } catch {
    return { status: 0 }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_READS = 800             // product pages per run; the rest continue the next day
const READ_BUDGET = 11 * 60e3     // stop reading pages after 11 minutes
const BLOCKED = new Set([403, 429, 503, 0])

// Reads product pages that are due, slowly, and updates the cache in place.
// Order: ticket open coming up (presales matter most) -> NOL World -> the rest.
async function updateProducts(goods, worldCodes, cache) {
  const now = Date.now()
  const recent = new Date(now + 9 * 3600e3 - 2 * 864e5).toISOString().slice(0, 16).replace("T", " ") // KST, 2 days ago
  const byCode = new Map()
  for (const g of goods) if (g.goodsCode && !byCode.has(g.goodsCode)) byCode.set(g.goodsCode, g)
  const rank = (g) => {
    const c = cache[g.goodsCode]
    const opens = [g.bookingOpenTime ?? "", ...((c && c.s) || []).map((x) => x.start)]
    // (old-format entries are re-read too; see "due" below)
    if (opens.some((o) => o >= recent)) return 0
    return worldCodes.has(g.goodsCode) ? 1 : 2
  }
  const due = [...byCode.values()].filter((g) => {
    const c = cache[g.goodsCode]
    if (!c || Array.isArray(c) || !c.t || c.k !== 4) return true // k:4 = product-matched fields, page dates and show times
    if (now - c.t > NAME_TTL) return true
    return rank(g) === 0 && now - c.t > 12 * 3600e3 // open coming up: re-check every day
  }).sort((a, b) => rank(a) - rank(b) || (cache[a.goodsCode]?.k === 4 ? 1 : 0) - (cache[b.goodsCode]?.k === 4 ? 1 : 0))
    .map((g) => g.goodsCode)

  const stats = { due: due.length, read: 0, failed: 0, statuses: {}, stopped: null }
  const queue = due.slice(0, MAX_READS)
  let i = 0, blockedInRow = 0
  async function worker() {
    while (i < queue.length && !stats.stopped) {
      if (Date.now() - now > READ_BUDGET) { stats.stopped = "time"; break }
      const code = queue[i++]
      let r = await fetchProduct(code)
      if (r.status !== undefined && BLOCKED.has(r.status)) {
        await sleep(20_000) // back off once, then retry
        r = await fetchProduct(code)
      }
      if (r.data) {
        cache[code] = { ...r.data, t: Date.now() }
        stats.read++
        blockedInRow = 0
      } else {
        stats.failed++
        stats.statuses[r.status] = (stats.statuses[r.status] || 0) + 1
        if (BLOCKED.has(r.status) && ++blockedInRow >= 4) stats.stopped = "blocked"
      }
      await sleep(600)
    }
  }
  await Promise.all(Array.from({ length: 2 }, worker))
  if (!stats.stopped && due.length > queue.length) stats.stopped = "limit"
  return stats
}

const valid = (g) => !!g.goodsCode && !!g.goodsName && DATE.test(g.playStartDate) && DATE.test(g.playEndDate)

function chipOf(g, genre) {
  if (genre === "MUSICAL") return "mu"
  if (genre === "SPORTS") return "sp"
  if (genre === "EXHIBIT") return "ex"
  if (SHOW_SUB.test(g.subGenreName ?? "")) return "e"
  return CONCERT_SUB[g.subGenreCode ?? ""] ?? "c"
}

function openOf(g) {
  const ot = g.bookingOpenTime ?? ""
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ot) ? ot.slice(0, 16) : null
}

const HANGUL = /[\uAC00-\uD7A3]/

// Page data is used only when it belongs to this product: some series pages
// (e.g. league matches) carry another match's details, so a page whose show
// date differs from the list's is ignored.
function pageData(g, names) {
  const c = names[g.goodsCode]
  if (!c || Array.isArray(c) || c.k !== 4) return null
  if (c.ps && c.ps !== g.playStartDate) return null
  return c
}

function baseEvent(g, genre, names, onWorld) {
  const c = pageData(g, names)
  const listName = g.goodsName.trim()
  return {
    id: g.goodsCode,
    genre: chipOf(g, genre),
    start: g.playStartDate,
    end: g.playEndDate < g.playStartDate ? g.playStartDate : g.playEndDate,
    open: openOf(g),
    // NOL World products: the Korean list carries the NOL World name, so use the page's
    // Korean name. Domestic products: the list name is the Korean name already.
    nameKo: onWorld ? (c?.n || listName) : (HANGUL.test(listName) || !c?.n ? listName : c.n),
    venueKo: c?.v || (g.placeName ?? "").trim(),
    sales: c?.s?.length ? c.s : undefined,
    time: c?.pt || undefined,
    runtime: c?.rt || undefined,
    krUrl: `https://nol.yanolja.com/ticket/products/${g.goodsCode}`,
    world: false,
    name: null,
    venue: null,
    url: null,
  }
}

async function main() {
  const started = Date.now()
  const jobs = GENRES.flatMap((genre) => Object.keys(SCOPES).map((scope) => ({ genre, scope })))
  const results = await Promise.all(jobs.map((j) => fetchGenre(j.scope, j.genre)))

  let names = {}
  try { names = JSON.parse(fs.readFileSync(NAMES, "utf8")) } catch {}
  const all = results.flat()
  const codes = [...new Set(all.map((g) => g.goodsCode).filter(Boolean))]
  const worldCodes = new Set()
  jobs.forEach((job, i) => { if (job.scope === "world") for (const g of results[i]) worldCodes.add(g.goodsCode) })
  const lookup = await updateProducts(all, worldCodes, names)
  const live = new Set(codes)
  for (const code of Object.keys(names)) if (!live.has(code)) delete names[code]

  const byId = new Map()
  const counts = { world: {}, all: {} }
  for (const g of GENRES) { counts.world[g] = 0; counts.all[g] = 0 }

  // Korean NOL list first: every product
  jobs.forEach((job, i) => {
    if (job.scope !== "all") return
    for (const g of results[i]) {
      if (!valid(g) || byId.has(g.goodsCode)) continue
      byId.set(g.goodsCode, baseEvent(g, job.genre, names, worldCodes.has(g.goodsCode)))
      counts.all[job.genre]++
    }
  })
  // NOL World list: mark products sold there and attach their NOL World names
  jobs.forEach((job, i) => {
    if (job.scope !== "world") return
    for (const g of results[i]) {
      if (!valid(g)) continue
      let e = byId.get(g.goodsCode)
      if (e?.world) continue
      if (!e) { e = baseEvent(g, job.genre, names, true); byId.set(g.goodsCode, e); counts.all[job.genre]++ }
      e.world = true
      e.name = g.goodsName.trim()
      e.venue = (g.placeName ?? "").trim()
      e.url = `https://world.nol.com/en/ticket/products/${g.goodsCode}`
      counts.world[job.genre]++
    }
  })

  const events = [...byId.values()]
  if (!events.some((e) => e.world)) throw new Error("NOL World returned no products")
  events.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))

  const cached = codes.filter((c) => names[c] && names[c].k === 4).length
  const pages = { ...lookup, cached, total: codes.length, withPresale: events.filter((e) => e.sales).length }
  const data = { updatedAt: new Date().toISOString(), pages, source: "https://world.nol.com/en/ticket", counts, events }
  fs.mkdirSync("site", { recursive: true })
  fs.mkdirSync("data", { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(data))
  fs.writeFileSync(NAMES, JSON.stringify(names, null, 0))
  console.log(
    `Updated ${events.length} NOL products (${events.filter((e) => e.world).length} on NOL World);`,
    `product pages read ${lookup.read}/${lookup.due} (failed ${lookup.failed} ${JSON.stringify(lookup.statuses)}${lookup.stopped ? ", stopped: " + lookup.stopped : ""}) in ${Math.round((Date.now() - started) / 1000)}s`,
    JSON.stringify(counts),
  )
}

main().catch((err) => {
  console.error("NOL refresh failed, keeping previous data:", err)
  process.exit(1)
})
