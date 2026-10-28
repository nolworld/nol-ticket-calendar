name: Probe ticket open

on:
  workflow_dispatch:   # run once from the Actions tab

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: update-calendar
  cancel-in-progress: false

jobs:
  probe:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Check presale and general sale data
        run: node scripts/probe-open.mjs

      - uses: actions/configure-pages@v5

      - uses: actions/upload-pages-artifact@v3
        with:
          path: site

      - id: deploy
        uses: actions/deploy-pages@v4
// One-time check: where can presale / general sale schedules be read from?
// Writes a plain-text report to site/probe.txt (published with the site) and
// to the Actions run summary. Safe to delete after the check.
import fs from "node:fs"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
const out = []
const log = (...a) => {
  const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
  out.push(s)
  console.log(s)
}
const cut = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").slice(0, n)

async function get(url, headers = {}, enc) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, ...headers }, redirect: "follow", signal: AbortSignal.timeout(15000) })
    const buf = new Uint8Array(await r.arrayBuffer())
    let text
    try { text = new TextDecoder(enc || "utf-8").decode(buf) } catch { text = new TextDecoder().decode(buf) }
    return { status: r.status, url: r.url, ct: r.headers.get("content-type") || "", text }
  } catch (e) {
    return { status: 0, url, ct: "", text: "", err: String(e) }
  }
}

// keys in raw HTML / JSON that look like booking schedule fields
function scheduleFields(text) {
  const t = text.replace(/\\"/g, '"')
  const re = /"([A-Za-z]*(?:[Oo]pen|[Pp]re[Ss]ale|[Pp]resale|[Bb]ooking|[Ss]ale[A-Z]|[Ff]an[Cc]lub|[Rr]ound)[A-Za-z]*)"\s*:\s*("[^"]{0,120}"|-?[\d.]+|null|true|false|\[|\{)/g
  const seen = new Map()
  for (const m of t.matchAll(re)) {
    if (!seen.has(m[1])) seen.set(m[1], m[2])
    if (seen.size > 60) break
  }
  return [...seen.entries()].map(([k, v]) => `${k}=${cut(v, 120)}`)
}

function textOf(html) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ")
}

async function main() {
  log("# Probe", new Date().toISOString())

  // A. Products whose ticket open is still ahead (most likely to have presale info)
  const now = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ")
  const picks = []
  for (const g of ["CONCERT", "MUSICAL"]) {
    for (let p = 0; p < 5 && picks.length < 6; p++) {
      const r = await get(`https://world.nol.com/api/ent-channel-out/v1/goods/list?languageType=KO&includeNonPartnerGoods=true&goodsStatus=Y,D&genreType=${g}&page=${p}&size=100`, { accept: "application/json" })
      let d; try { d = JSON.parse(r.text).data } catch { log("A list fail", g, r.status); break }
      for (const c of d.content) if ((c.bookingOpenTime || "") > now && picks.length < 6) picks.push(c)
      if (p >= d.totalPages - 1) break
    }
  }
  log("\n## A. upcoming opens", picks.length)
  for (const c of picks) log("-", c.goodsCode, cut(c.goodsName, 60), "| open", c.bookingOpenTime, "| list keys:", scheduleFields(JSON.stringify(c)).join(", "))
  const codes = picks.slice(0, 4).map((c) => c.goodsCode)

  // B. Domestic product summary: every key + schedule-like fields
  log("\n## B. interpark summary")
  for (const code of codes) {
    const r = await get(`https://api-ticketfront.interpark.com/v1/goods/${code}/summary`, { accept: "application/json", referer: "https://tickets.interpark.com/" })
    let d; try { d = JSON.parse(r.text).data } catch {}
    log("-", code, r.status, d ? "keys: " + Object.keys(d).join(",") : cut(r.text, 150))
    if (d) log("  fields:", scheduleFields(JSON.stringify(d)).join(" ; "))
  }
  // other per-product endpoints that may hold sale rounds
  for (const path of ["booking-notice", "notice", "sales-info", "presale", "playSeq", "detail"]) {
    const r = await get(`https://api-ticketfront.interpark.com/v1/goods/${codes[0]}/${path}`, { accept: "application/json", referer: "https://tickets.interpark.com/" })
    log("  try", path, r.status, cut(r.text, 200))
  }

  // C/D. Product pages (NOL World + domestic NOL)
  for (const [label, base] of [["C. world.nol.com page", "https://world.nol.com/en/ticket/products/"], ["D. nol.yanolja.com page", "https://nol.yanolja.com/ticket/products/"], ["D2. tickets.interpark.com page", "https://tickets.interpark.com/goods/"]]) {
    log("\n## " + label)
    for (const code of codes.slice(0, 2)) {
      const r = await get(base + code)
      log("-", code, r.status, r.url, "len", r.text.length)
      log("  fields:", scheduleFields(r.text).join(" ; "))
      const t = textOf(r.text)
      const i = t.search(/선예매|일반예매|티켓\s*오픈|Pre-?sale|General (sale|booking)|Ticket Open/i)
      if (i > -1) log("  text:", cut(t.slice(Math.max(0, i - 80), i + 320), 400))
    }
  }

  // E. Ticket open notice board (new site): API discovery
  log("\n## E. tickets.interpark.com/contents/notice")
  const np = await get("https://tickets.interpark.com/contents/notice")
  log("-", np.status, np.url, "len", np.text.length, "fields:", scheduleFields(np.text).slice(0, 25).join(" ; "))
  const srcs = [...new Set([...np.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))]
  const hits = new Set()
  for (const s of [np.text, ...(await Promise.all(srcs.slice(0, 40).map(async (u) => (await get(u.startsWith("http") ? u : "https://tickets.interpark.com" + u)).text)))]) {
    for (const m of s.matchAll(/["'`]((?:https?:\/\/[a-z0-9.-]+)?\/[A-Za-z0-9_\-/{}$.]*(?:notice|Notice|open|Open)[A-Za-z0-9_\-/{}$.?=&]*)["'`]/g)) hits.add(m[1])
  }
  const cands = [...hits].filter((h) => !/\.(png|jpg|svg|css)$/.test(h)).slice(0, 40)
  log("  candidates:", cands.join(" | "))
  const tried = new Set()
  for (const c of cands) {
    if (c.includes("${") || c.includes("{")) continue
    for (const host of c.startsWith("http") ? [""] : ["https://api-ticketfront.interpark.com", "https://tickets.interpark.com"]) {
      const u = host + c
      if (tried.has(u) || tried.size >= 14) continue
      tried.add(u)
      const r = await get(u, { accept: "application/json", referer: "https://tickets.interpark.com/contents/notice" })
      if (r.status === 200 && /json/.test(r.ct)) log("  OK", u, cut(r.text, 700))
      else log("  ", r.status, u)
    }
  }

  // F. Classic notice board (webzine)
  log("\n## F. ticket.interpark.com webzine notice list")
  const lst = await get("https://ticket.interpark.com/webzine/paper/TPNoticeList.asp", {}, "euc-kr")
  const links = [...new Set([...lst.text.matchAll(/TPNoticeView\.asp\?[^"'\s>]+/g)].map((m) => m[0].replace(/&amp;/g, "&")))]
  log("-", lst.status, lst.url, "len", lst.text.length, "links", links.length)
  log("  list text:", cut(textOf(lst.text).replace(/.*?(오픈|공지)/, "$1"), 700))
  for (const l of links.slice(0, 2)) {
    const v = await get("https://ticket.interpark.com/webzine/paper/" + l, {}, "euc-kr")
    const t = textOf(v.text)
    const i = t.search(/선예매|일반예매|티켓\s*오픈|오픈\s*일시/)
    log("- view", l, v.status, "goods links:", [...new Set([...v.text.matchAll(/(?:GoodsCode=|goods\/|products\/)(\d{8})/gi)].map((m) => m[1]))].slice(0, 5).join(","))
    log("  text:", cut(t.slice(Math.max(0, i - 100), i + 900), 1000))
  }
}

try { await main() } catch (e) { log("ERR", String(e && e.stack || e)) }
const report = out.join("\n")
fs.mkdirSync("site", { recursive: true })
fs.writeFileSync("site/probe.txt", report)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + report.slice(0, 60000) + "\n```\n")
