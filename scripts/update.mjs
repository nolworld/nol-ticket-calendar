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

// Presale rounds: [{ label, start, end|null }]
function salesOf(t) {
  const sales = []
  const presales = value(t, "presales")
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
  if (!sales.length && value(t, "ticketOpenType") === 3) {
    const start = minute(value(t, "ticketOpenDate"))
    const label = String(value(t, "ticketOtherOpenName") ?? "").trim() || "선예매"
    if (start) sales.push({ label, start, end: null })
  }
  const seen = new Set()
  return sales
    .filter((x) => { const k = x.label + x.start; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => a.start.localeCompare(b.start))
}

async function fetchProduct(code) {
  try {
    const res = await fetch(PRODUCT_PAGE + code, {
      headers: { "user-agent": PAGE_UA, "accept-language": "ko-KR,ko;q=0.9" },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const t = unesc(await res.text())
    const name = value(t, "goodsName")
    if (typeof name !== "string" || !name.trim()) return null
    const venue = value(t, "placeName")
    return { n: name.trim(), v: typeof venue === "string" ? venue.trim() : "", s: salesOf(t) }
  } catch {
    return null
  }
}

// Reads product pages that are due and updates the cache in place
async function updateProducts(goods, cache) {
  const now = Date.now()
  const recent = new Date(now + 9 * 3600e3 - 2 * 864e5).toISOString().slice(0, 16).replace("T", " ") // KST, 2 days ago
  const byCode = new Map()
  for (const g of goods) if (g.goodsCode && !byCode.has(g.goodsCode)) byCode.set(g.goodsCode, g)
  const due = [...byCode.values()].filter((g) => {
    const c = cache[g.goodsCode]
    if (!c || Array.isArray(c) || !c.t) return true
    if (now - c.t > NAME_TTL) return true
    // ticket open (general or presale) still ahead or just passed: re-check every day
    const opens = [g.bookingOpenTime ?? "", ...(c.s ?? []).map((x) => x.start)]
    return opens.some((o) => o >= recent) && now - c.t > 12 * 3600e3
  }).map((g) => g.goodsCode)
  let i = 0, ok = 0
  async function worker() {
    while (i < due.length) {
      const code = due[i++]
      const r = await fetchProduct(code)
      if (r) { cache[code] = { ...r, t: Date.now() }; ok++ }
      await new Promise((res) => setTimeout(res, 150))
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  return { due: due.length, updated: ok }
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

function baseEvent(g, genre, names) {
  const c = names[g.goodsCode] && !Array.isArray(names[g.goodsCode]) ? names[g.goodsCode] : null
  return {
    id: g.goodsCode,
    genre: chipOf(g, genre),
    start: g.playStartDate,
    end: g.playEndDate < g.playStartDate ? g.playStartDate : g.playEndDate,
    open: openOf(g),
    nameKo: c?.n || g.goodsName.trim(),
    venueKo: c?.v || (g.placeName ?? "").trim(),
    sales: c?.s?.length ? c.s : undefined,
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
  const lookup = await updateProducts(all, names)
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
      byId.set(g.goodsCode, baseEvent(g, job.genre, names))
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
      if (!e) { e = baseEvent(g, job.genre, names); byId.set(g.goodsCode, e); counts.all[job.genre]++ }
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

  const data = { updatedAt: new Date().toISOString(), source: "https://world.nol.com/en/ticket", counts, events }
  fs.mkdirSync("site", { recursive: true })
  fs.mkdirSync("data", { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(data))
  fs.writeFileSync(NAMES, JSON.stringify(names, null, 0))
  console.log(
    `Updated ${events.length} NOL products (${events.filter((e) => e.world).length} on NOL World);`,
    `product pages read ${lookup.updated}/${lookup.due} in ${Math.round((Date.now() - started) / 1000)}s`,
    JSON.stringify(counts),
  )
}

main().catch((err) => {
  console.error("NOL refresh failed, keeping previous data:", err)
  process.exit(1)
})
