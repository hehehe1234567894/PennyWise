// 前端加载冒烟：在桩 DOM 环境里真实执行 app.js 的同步加载路径。
// 任何顶层异常（如对 null 元素 addEventListener）都会让加载中断，
// 这正是"界面毫无反应"类 bug 的根源。用法: node scripts/check-frontend.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
const js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8')
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))

function makeEl() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, dataset: {}, files: [],
    style: {}, offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {}, appendChild() {}, insertBefore() {}, click() {}, focus() {},
    querySelector() { return makeEl() }, querySelectorAll() { return [] }, closest() { return null },
  }
}
const els = new Map()
const getEl = (id) => {
  if (!htmlIds.has(id)) return null // 与真实 DOM 一致：不存在的 id 返回 null
  if (!els.has(id)) els.set(id, makeEl())
  return els.get(id)
}
const document = {
  body: makeEl(),
  getElementById: getEl,
  querySelector(sel) {
    if (sel === '[data-close-chat]') return html.includes('data-close-chat') ? makeEl() : null
    return makeEl()
  },
  querySelectorAll() { return [] },
  addEventListener() {},
  createElement() { return makeEl() },
}
const window = {
  addEventListener() {},
  matchMedia() { return { matches: false, addEventListener() {} } },
}
const navigator = { serviceWorker: {} }
const localStorage = { getItem() { return null }, setItem() {}, removeItem() {} }
const sessionStorage = { getItem() { return null }, setItem() {} }
const location = { origin: 'http://127.0.0.1:8720', protocol: 'http:', hash: '', search: '', pathname: '/' }
const history = { replaceState() {} }
const performance = { now() { return 0 } }
const cryptoObj = { randomUUID() { return 'stub' } }
const fetchStub = () => new Promise(() => {}) // 永不完成：只测同步加载路径
const AbortControllerStub = class { constructor() { this.signal = {} } abort() {} }
const indexedDB = {
  open() { return { onupgradeneeded: null, onsuccess: null, onerror: null, result: {} } },
  deleteDatabase() {},
}
const setTimeoutStub = () => 0
const clearTimeoutStub = () => {}
const setIntervalStub = () => 0
const requestAnimationFrameStub = () => 0
const URLCtor = class { constructor() { this.host = ''; this.protocol = 'http:' } }

let failed = false
try {
  const run = new Function(
    'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
    'performance', 'crypto', 'fetch', 'AbortController', 'indexedDB',
    'setTimeout', 'clearTimeout', 'setInterval', 'requestAnimationFrame', 'URL',
    js,
  )
  run(
    window, document, navigator, localStorage, sessionStorage, location, history,
    performance, cryptoObj, fetchStub, AbortControllerStub, indexedDB,
    setTimeoutStub, clearTimeoutStub, setIntervalStub, requestAnimationFrameStub, URLCtor,
  )
  console.log('PASS  app.js loads without synchronous errors')
} catch (e) {
  failed = true
  console.error('FAIL  app.js throws at load:', e.message)
  console.error(String(e.stack || '').split('\n').slice(0, 4).join('\n'))
}

// 交叉检查：app.js 引用的静态元素 id 必须存在于 index.html
const refs = [...js.matchAll(/\$\('([a-zA-Z0-9_-]+)'\)/g)].map((m) => m[1])
const dynamic = new Set(['ed-direction', 'ed-cat-wrap', 'ed-category', 'ed-amount', 'ed-merchant', 'ed-goods',
  'ed-account', 'ed-ts', 'ed-note', 'ed-form', 'ed-raw', 'ed-submit', 'trend-chart', 'set-token', 'set-save',
  'set-status', 'set-llm-save', 'set-llm', 'set-llm-status', 'set-autoconfirm', 'set-auto-status', 'set-reprobe',
  'conn-panel', 'set-import', 'set-import-status', 'set-report', 'set-report-status', 'qr-panel', 'ed-img',
  'rec-block', 'rec-refresh', 'merchant-block', 'm-rows', 'm-more', 'day-chart', 'day-tip', 'bg-fx',
  'btn-audit', 'audit-month', 'audit-status', 'audit-download', 'fin-block'])
const missing = [...new Set(refs)].filter((r) => !htmlIds.has(r) && !dynamic.has(r))
if (missing.length) {
  failed = true
  console.error('FAIL  ids referenced by app.js but missing from index.html:', missing)
} else {
  console.log('PASS  all static element ids referenced by app.js exist in index.html')
}
process.exit(failed ? 1 : 0)
