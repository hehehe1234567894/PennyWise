// 布局审计：用无头 Edge 真实打开页面（#pw-token 自动解锁），量测各板块位置/尺寸/溢出/错位。
// 依赖：npm install puppeteer-core --no-save（复用本机 Edge，不下载浏览器）
// 用法：node scripts/audit-layout.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
const tok = (env.match(/^AUTH_TOKEN=(.+)$/m) || [])[1]?.trim()
if (!tok) { console.error('no AUTH_TOKEN in .env'); process.exit(1) }
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const AUDIT = `(() => {
  const out = { issues: [] }
  const round = (n) => Math.round(n)
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height), bottom: round(r.bottom), right: round(r.right), display: cs.display, overflowY: cs.overflowY, overflowX: cs.overflowX, scrollH: el.scrollHeight, clientH: el.clientHeight, scrollW: el.scrollWidth, clientW: el.clientWidth }
  }
  const g = (id) => box(document.getElementById(id))
  out.viewport = { w: innerWidth, h: innerHeight }
  out.pageScrollW = document.documentElement.scrollWidth
  if (document.documentElement.scrollWidth > innerWidth + 2) out.issues.push('page horizontal overflow: ' + document.documentElement.scrollWidth + ' > ' + innerWidth)
  out.topbar = g('topbar')
  out.lock = g('lock-screen')
  if (out.lock && out.lock.display !== 'none') out.issues.push('lock-screen still visible (auto-unlock failed)')
  out.capture = g('tab-capture'); out.pending = g('tab-pending')
  if (out.capture && out.capture.display !== 'none') out.issues.push('tab-capture not hidden')
  if (out.pending && out.pending.display !== 'none') out.issues.push('tab-pending not hidden')
  out.list = g('tab-list'); out.stats = g('tab-stats')
  const tabsEl = document.querySelector('.tabs')
  out.tabs = tabsEl ? box(tabsEl) : null
  out.fab = box(document.getElementById('btn-chat'))
  if (out.list && out.stats && out.list.display !== 'none' && out.stats.display !== 'none') {
    if (Math.abs(out.list.h - out.stats.h) > 2) out.issues.push('list/stats height mismatch: ' + out.list.h + ' vs ' + out.stats.h)
    if (Math.abs(out.list.w - out.stats.w) > 2) out.issues.push('list/stats width mismatch: ' + out.list.w + ' vs ' + out.stats.w)
    if (Math.abs(out.list.y - out.stats.y) > 2) out.issues.push('list/stats top mismatch: ' + out.list.y + ' vs ' + out.stats.y)
    if (out.stats.bottom > innerHeight + 2) out.issues.push('stats panel sticks out below screen: ' + out.stats.bottom + ' > ' + innerHeight)
    if (out.list.bottom > innerHeight + 2) out.issues.push('list panel sticks out below screen: ' + out.list.bottom + ' > ' + innerHeight)
  }
  out.listItems = g('list-items')
  out.statsScroll = box(document.querySelector('#tab-stats .panel-scroll'))
  out.statCards = [...document.querySelectorAll('.stat-card')].map(box)
  out.statBlocks = [...document.querySelectorAll('#stats-extra .stat-block')].map(box)
  // 面板头部是否横向溢出（标题+筛选工具挤爆）
  for (const p of ['#tab-list', '#tab-stats']) {
    const head = document.querySelector(p + ' .panel-head')
    if (head && head.scrollWidth > head.clientWidth + 4) out.issues.push(p + ' panel-head overflows: ' + head.scrollWidth + ' > ' + head.clientWidth)
  }
  const offenders = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (el.scrollWidth > el.clientWidth + 4 && getComputedStyle(el).overflowX === 'visible') {
      const id = el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : el.tagName
      offenders.push(id + '(' + el.scrollWidth + '>' + el.clientWidth + ')')
    }
  }
  out.hOverflow = offenders.slice(0, 12)
  if (offenders.length) out.issues.push('horizontal overflow elements: ' + offenders.join(', '))
  // 聊天窗口展开态几何
  out.chatCard = null
  if (!document.getElementById('chat-modal').classList.contains('hidden')) out.chatCard = box(document.getElementById('chat-modal').querySelector('.chat-card'))
  return out
})()`

async function audit(width, height, label, actions) {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width, height })
    await page.goto(`http://127.0.0.1:8720/#pw-token=${encodeURIComponent(tok)}`, { waitUntil: 'load', timeout: 30000 })
    await new Promise((r) => setTimeout(r, 4000))
    let res = await page.evaluate(AUDIT)
    console.log(`===== ${label} =====`)
    console.log(JSON.stringify(res, null, 1))
    if (actions && actions.length) {
      for (const a of actions) {
        await page.evaluate(a.js)
        await new Promise((r) => setTimeout(r, a.wait || 1500))
        res = await page.evaluate(AUDIT)
        console.log(`----- ${label} + ${a.name} -----`)
        console.log(JSON.stringify(res, null, 1))
      }
    }
  } finally {
    await browser.close()
  }
}

await audit(1440, 900, 'desktop 1440x900')
await audit(800, 600, 'desktop 800x600 (small)')
await audit(390, 844, 'mobile 390x844 (list tab)', [
  { name: 'stats tab', js: `document.querySelector('.tab[data-tab="stats"]').click()` },
  { name: 'chat modal open', js: `document.getElementById('btn-chat').click()` },
])
await audit(1280, 900, 'desktop 1280x900 (chat modal)', [
  { name: 'chat modal open', js: `document.getElementById('btn-chat').click()` },
])
