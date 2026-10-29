// One-time check (round 2): exact format of presale / general sale data and
// Korean names on Korean NOL product pages. Writes site/probe2.txt.
import fs from "node:fs"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
const out = []
const log = (...a) => {
  const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
  out.push(s)
  console.log(s)
}
const cut = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").slice(0, n)

async function get(url, headers = {}) {
  const t = Date.now()
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, ...headers }, redirect: "follow", signal: AbortSignal.timeout(20000) })
    return { status: r.status, url: r.url, text: await r.text(), ms: Date.now() - t }
  } catch (e) {
    return { status: 0, url, text: "", ms: Date.now() - t, err: String(e) }
  }
}

// The page embeds its data as escaped JSON; undo one level of escaping
const unesc = (s) => s.replace(/\\\\/g, "\u0000").replace(/\\"/g, '"').replace(/\u0000/g, "\\")

// Value after "key": — balanced for arrays/objects, else a string/number
function valueOf(t, key, from = 0) {
  const k = t.indexOf(`"${key}":`, from)
  if (k === -1) return null
  let i = k + key.length + 3
  while (t[i] === " ") i++
  const open = t[i]
  if (open === "[" || open === "{") {
    const close = open === "[" ? "]" : "}"
    let depth = 0, inStr = false
    for (let j = i; j < t.length && j < i + 20000; j++) {
      const c = t[j]
      if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === open) depth++
      else if (c === close && --depth === 0) return t.slice(i, j + 1)
    }
    return t.slice(i, i + 500)
  }
  if (open === '"') { const e = t.indexOf('"', i + 1); return t.slice(i, e + 1) }
  return t.slice(i, i + 30).split(/[,}\]]/)[0]
}

function allValues(t, key, max = 5) {
  const vals = []; let from = 0
  while (vals.length < max) {
    const k = t.indexOf(`"${key}":`, from)
    if (k === -1) break
    vals.push(cut(valueOf(t, key, k), 160)); from = k + 1
  }
  return [...new Set(vals)]
}

async function main() {
  log("# Probe 2", new Date().toISOString())

  // Products whose ticket open is still ahead, from all genres
  const now = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ")
  const picks = []
  for (const g of ["CONCERT", "MUSICAL", "SPORTS", "EXHIBIT"]) {
    for (let p = 0; p < 5; p++) {
      const r = await get(`https://world.nol.com/api/ent-channel-out/v1/goods/list?languageType=KO&includeNonPartnerGoods=true&goodsStatus=Y,D&genreType=${g}&page=${p}&size=100`, { accept: "application/json" })
      let d; try { d = JSON.parse(r.text).data } catch { break }
      for (const c of d.content) if ((c.bookingOpenTime || "") > now) picks.push({ code: c.goodsCode, listName: c.goodsName, open: c.bookingOpenTime, globalType: c.globalType })
      if (p >= d.totalPages - 1) break
    }
  }
  log("upcoming opens:", picks.length)

  // Korean NOL product page for each (up to 30)
  let shown = 0, withPresale = 0, totalMs = 0, totalLen = 0, n = 0
  log("\n## Pages")
  for (const c of picks.slice(0, 30)) {
    const r = await get(`https://nol.yanolja.com/ticket/products/${c.code}`)
    totalMs += r.ms; totalLen += r.text.length; n++
    const t = unesc(r.text)
    const presales = valueOf(t, "presales")
    const has = presales && presales !== "[]"
    if (has) withPresale++
    log(`- ${c.code} ${r.status} ${r.ms}ms | list: ${cut(c.listName, 50)} | world: ${c.globalType || "-"}`)
    log(`  goodsName: ${allValues(t, "goodsName", 3).join(" / ")}`)
    log(`  placeName: ${allValues(t, "placeName", 3).join(" / ")}`)
    log(`  bookingOpenTime=${valueOf(t, "bookingOpenTime")} ticketOpenType=${valueOf(t, "ticketOpenType")} ticketOpenTypeName=${valueOf(t, "ticketOpenTypeName")} ticketOtherOpenName=${valueOf(t, "ticketOtherOpenName")} ticketOpenDate=${valueOf(t, "ticketOpenDate")}`)
    if (has && shown < 4) { log(`  presales RAW: ${cut(presales, 1500)}`); shown++ }
    else log(`  presales: ${cut(presales, 200)}`)
  }
  log(`\npages: ${n}, with presales: ${withPresale}, avg ${Math.round(totalMs / Math.max(n, 1))}ms, avg ${Math.round(totalLen / Math.max(n, 1) / 1024)}KB`)

  // A product already on sale with no upcoming open (to see what stays after opening)
  log("\n## On-sale product")
  const r = await get("https://nol.yanolja.com/ticket/products/26013946")
  const t = unesc(r.text)
  log(`- 26013946 ${r.status} goodsName: ${allValues(t, "goodsName", 3).join(" / ")} | placeName: ${allValues(t, "placeName", 2).join(" / ")}`)
  log(`  bookingOpenTime=${valueOf(t, "bookingOpenTime")} ticketOpenType=${valueOf(t, "ticketOpenType")} ticketOtherOpenName=${valueOf(t, "ticketOtherOpenName")} ticketOpenDate=${valueOf(t, "ticketOpenDate")}`)
  log(`  presales: ${cut(valueOf(t, "presales"), 800)}`)

  // Current Korean name cache in the repository
  log("\n## Repository data")
  try {
    const names = JSON.parse(fs.readFileSync("data/names-ko.json", "utf8"))
    log("names-ko.json entries:", Object.keys(names).length)
  } catch (e) { log("names-ko.json:", String(e).slice(0, 100)) }
  try {
    const ev = JSON.parse(fs.readFileSync("site/events.json", "utf8"))
    const w = ev.events.filter((e) => e.world)
    log("events.json updatedAt:", ev.updatedAt, "events:", ev.events.length, "world:", w.length, "world with Korean name different from NOL World name:", w.filter((e) => e.nameKo !== e.name).length)
  } catch (e) { log("events.json:", String(e).slice(0, 100)) }
}

try { await main() } catch (e) { log("ERR", String(e && e.stack || e)) }
const report = out.join("\n")
fs.mkdirSync("site", { recursive: true })
fs.writeFileSync("site/probe2.txt", report)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + report.slice(0, 60000) + "\n```\n")
