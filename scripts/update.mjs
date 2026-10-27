// Reads the NOL ticket lists and writes site/events.json for the calendar.
// Runs daily in GitHub Actions (see .github/workflows/update.yml).
//
// One pass with NOL World's filter (globalType=EN) gives the products sold on
// NOL World with their NOL World names; one pass without it gives every NOL
// product. Korean names and venues come from the domestic NOL product data and
// are cached in data/names-ko.json so only new products are looked up each day.
//
// If any list fails, the script exits with an error before writing anything, so
// the site keeps the previous day's data.
import fs from "node:fs"

const API = "https://world.nol.com/api/ent-channel-out/v1/goods/list"
const DOMESTIC = "https://api-ticketfront.interpark.com/v1/goods"
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

async function fetchKorean(code) {
  try {
    const res = await fetch(`${DOMESTIC}/${code}/summary`, {
      headers: { accept: "application/json", referer: "https://tickets.interpark.com/", "user-agent": UA },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const d = (await res.json())?.data
    if (!d?.goodsName) return null
    return [String(d.goodsName).trim(), String(d.placeName ?? "").trim()]
  } catch {
    return null
  }
}

async function updateNames(codes, cache) {
  const now = Date.now()
  const due = codes.filter((c) => !cache[c] || now - cache[c][2] > NAME_TTL)
  let i = 0, ok = 0
  async function worker() {
    while (i < due.length) {
      const code = due[i++]
      const r = await fetchKorean(code)
      if (r) { cache[code] = [r[0], r[1], Date.now()]; ok++ }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
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
  return {
    id: g.goodsCode,
    genre: chipOf(g, genre),
    start: g.playStartDate,
    end: g.playEndDate < g.playStartDate ? g.playStartDate : g.playEndDate,
    open: openOf(g),
    nameKo: names[g.goodsCode]?.[0] || g.goodsName.trim(),
    venueKo: names[g.goodsCode]?.[1] || (g.placeName ?? "").trim(),
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
  const codes = [...new Set(results.flat().map((g) => g.goodsCode).filter(Boolean))]
  const lookup = await updateNames(codes, names)
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
    `Korean names checked ${lookup.updated}/${lookup.due} in ${Math.round((Date.now() - started) / 1000)}s`,
    JSON.stringify(counts),
  )
}

main().catch((err) => {
  console.error("NOL refresh failed, keeping previous data:", err)
  process.exit(1)
})
