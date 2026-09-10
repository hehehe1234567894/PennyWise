import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import express from 'express'
import { env, writeEnv, DATA_DIR, PUBLIC_DIR } from './env.js'
import { db, getCategories, normalizeCategory, ruleFor, upsertRule, nowIso, validTs, getTx, currentMonth, newUid, currentRev, nextRev, bumpTx, txToSync } from './db.js'
import { parseImage, llmConfig, visionConfig, getModelStatus, noteModelResult } from './llm.js'
import { mailConfig, importBills, importBillRows, parseWechatCsv, parseAlipayCsv, parseBankCsv } from './importer.js'
import { mailerConfig, serverChanKey, summarizeMonth, buildReportText, buildReportHtml, sendMonthlyReport, generateReportNarrative } from './reporter.js'
import { analyzeBillForAlternatives } from './recommend.js'
import { auditMonth, buildAuditCsv } from './audit.js'
import { classifyPreview, classifyPending } from './classify.js'
import { qualityCheck } from './quality.js'
import { queryRows, buildCsv, buildXlsx, summarize, buildExportHtml, htmlToPdf, monthlyExpenseTrend, budgetExecution, channelLabel, findBrowser, applyExcludes, normalizeRules, ruleMatches, listMerchants, getExportPrefs, saveExportPrefs, ruleLabel } from './export.js'
import { detectImage, saveImage, autoConfirmFrom, captureTextCore, captureImageCore } from './capture-core.js'
import { DIRECTIONS, ACCOUNTS, DEFAULT_CATEGORIES } from './categories.js'
import { pushEvent, recentEvents, onEvent } from './notify.js'

const PORT = Number(env('PORT', '8720')) || 8720
const AUTH_TOKEN = env('AUTH_TOKEN', '')

// 自动入账阈值：解析置信度 ≥ 阈值 → 直接入账，无需确认；1 = 全部手动确认
function autoConfirmAt() {
  return autoConfirmFrom(env('AUTO_CONFIRM', '0.9'))
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '16mb' }))

// ---- 幽灵模式活动心跳：记录最近一次 HTTP 请求时间（ghost.ps1 据此判断何时可自动停服） ----
let lastActivitySaved = 0
app.use((req, res, next) => {
  if (req.path !== '/api/events') { // SSE 长连接单独用活动连接数判断
    const t = Date.now()
    if (t - lastActivitySaved > 60000) { // 节流：每分钟最多落盘一次
      lastActivitySaved = t
      try { fs.writeFileSync(path.join(DATA_DIR, 'last-activity.txt'), String(t)) } catch { /* 忽略 */ }
    }
  }
  next()
})

// ---- 安全响应头 ----
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'DENY')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src *; object-src 'none'; base-uri 'self'")
  next()
})

// ---- 安全边界：CORS 白名单（仅服务器自身地址）+ 跨站请求拦截 ----
function ownHosts() {
  const set = new Set()
  set.add('localhost:' + PORT)
  set.add('127.0.0.1:' + PORT)
  try { set.add(os.hostname().toLowerCase() + ':' + PORT) } catch { /* 忽略 */ }
  const { lan, tailscale } = scanInterfaces()
  for (const x of [...lan, ...tailscale]) set.add(x.ip + ':' + PORT)
  const ts = env('TAILSCALE_NAME', '').replace(/\/+$/, '').replace(/^https?:\/\//, '')
  if (ts) { set.add(ts); set.add(ts + ':' + PORT) }
  return set
}
let hostsCache = { at: 0, set: new Set() }
function originAllowed(origin, host) {
  const now = Date.now()
  if (now - hostsCache.at > 30000) hostsCache = { at: now, set: ownHosts() }
  let o = ''
  try { o = new URL(origin).host } catch { return false }
  return o === host || hostsCache.set.has(o)
}

app.use((req, res, next) => {
  // 浏览器发起的跨站请求一律拒绝（防恶意网页读写本机服务）
  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ ok: false, code: 'forbidden', error: '禁止跨站访问' })
  }
  const origin = req.get('origin')
  if (origin) {
    if (originAllowed(origin, req.get('host') || '')) {
      res.set('Access-Control-Allow-Origin', origin)
      res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
      res.set('Access-Control-Allow-Headers', 'Content-Type,X-Auth-Token')
      res.set('Access-Control-Max-Age', '86400')
    } else {
      // 不回显 ACAO（浏览器不可读），非预检请求直接拒绝
      if (req.method !== 'OPTIONS') {
        return res.status(403).json({ ok: false, code: 'forbidden', error: '来源不允许' })
      }
    }
  }
  if (req.method === 'OPTIONS') {
    return res.get('Access-Control-Allow-Origin') ? res.sendStatus(204) : res.sendStatus(403)
  }
  next()
})

// 简单限流：每 IP 每分钟最多 120 次 API 请求
const rlMap = new Map()
app.use('/api', (req, res, next) => {
  const ip = req.ip || 'x'
  const now = Date.now()
  const cur = rlMap.get(ip)
  if (!cur || now - cur.t0 > 60000) rlMap.set(ip, { t0: now, n: 1 })
  else {
    cur.n++
    if (cur.n > 120) return res.status(429).json({ ok: false, code: 'rate_limited', error: '请求过于频繁，请稍后再试' })
  }
  if (rlMap.size > 2000) rlMap.clear()
  next()
})

// ---- 鉴权：/api 下公开端点除外，其余一律要求 X-Auth-Token（本机/远程一视同仁，无验证不可进入） ----
const PUBLIC_API = ['/qr', '/events', '/health', '/connect-info'] // /health 公开：桌面启动器/看门狗用它做无凭据探活；/connect-info 供锁定屏与配对页无凭据读取连接方式（内容本就是给用户看的二维码/地址）
function tokenOk(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}
app.use('/api', (req, res, next) => {
  if (!AUTH_TOKEN) return next()
  if (PUBLIC_API.includes(req.path)) return next()
  if (req.get('x-auth-token') && tokenOk(req.get('x-auth-token'), AUTH_TOKEN)) return next()
  // 下载类接口（导出 Excel/CSV/PDF）走浏览器原生下载，无法自定义 header，故同时接受 query 令牌
  if (req.query && typeof req.query.t === 'string' && req.query.t && tokenOk(req.query.t, AUTH_TOKEN)) return next()
  return res.status(401).json({ ok: false, code: 'auth', error: '访问令牌无效，请验证后再进入' })
})

const fail = (res, status, code, error) => res.status(status).json({ ok: false, code, error })

// ---- 基本信息 ----
app.get('/api/health', (req, res) => {
  const v = visionConfig()
  res.json({
    ok: true, time: nowIso(),
    hasLLM: llmConfig().enabled, model: llmConfig().model,
    hasVision: v.enabled, visionModel: v.model, visionModels: v.models,
    autoConfirm: autoConfirmAt(),
    modelStatus: getModelStatus(),
    billImport: { ...billStatus, enabled: billStatus.enabled || mailConfig().billsEnabled },
  })
})

// 扫描本机网卡：区分局域网与 Tailscale（100.x 前缀或网卡名）
function scanInterfaces() {
  const nets = os.networkInterfaces()
  const lan = []
  const tailscale = []
  for (const iface of Object.keys(nets)) {
    for (const n of nets[iface] || []) {
      if (n.family !== 'IPv4' || n.internal) continue
      const isTs = iface.toLowerCase().includes('tailscale') || n.address.startsWith('100.')
      if (isTs) tailscale.push({ ip: n.address, iface })
      else lan.push({ ip: n.address, iface })
    }
  }
  return { lan, tailscale }
}

// 可达性自报：手机端"连接检测"据此探测哪个地址可用（需令牌）
app.get('/api/reachability', (req, res) => {
  const { lan, tailscale } = scanInterfaces()
  res.json({
    ok: true,
    port: PORT,
    hostname: os.hostname(),
    lan,
    tailscale,
    tsName: env('TAILSCALE_NAME', '').replace(/\/+$/, ''),
    time: nowIso(),
  })
})

// 手机配对信息（含令牌）：需令牌，用于生成"扫码即连"二维码
app.get('/api/connect-info', (req, res) => {
  const { lan, tailscale } = scanInterfaces()
  res.json({
    ok: true,
    data: {
      token: AUTH_TOKEN,
      port: PORT,
      lan,
      tailscale,
      tsName: env('TAILSCALE_NAME', '').replace(/\/+$/, ''),
    },
  })
})

// 二维码渲染（公开）：把任意短文本画成 SVG
app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '')
  if (!text || text.length > 800) return fail(res, 400, 'bad_request', 'text 为空或过长')
  const width = Math.min(Math.max(Number(req.query.size) || 220, 100), 600)
  try {
    const QRCode = (await import('qrcode')).default // 懒加载：二维码只在配对扫码时用得到
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width, errorCorrectionLevel: 'M' })
    res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'no-store').send(svg)
  } catch (e) {
    fail(res, 500, 'server_error', '二维码生成失败')
  }
})

// 网页设置：修改配置并立即生效（无需重启）
app.post('/api/settings', (req, res) => {
  const b = req.body || {}
  const changes = {}
  if (b.llm_api_key !== undefined) {
    const key = String(b.llm_api_key).trim().slice(0, 200)
    writeEnv('LLM_API_KEY', key)
    noteModelResult('text', true) // 用户更新了 Key：清除欠费/无效提示，等下一次调用重新判定
    changes.llmConfigured = Boolean(key)
  }
  if (b.auto_confirm !== undefined) {
    const v = Number(b.auto_confirm)
    if (!Number.isFinite(v) || v < 0 || v > 1) return fail(res, 400, 'bad_request', 'auto_confirm 需在 0~1 之间')
    writeEnv('AUTO_CONFIRM', String(v))
    changes.autoConfirm = v
  }
  res.json({ ok: true, data: changes })
})
app.get('/api/config', (req, res) => {
  res.json({ ok: true, tokenRequired: Boolean(AUTH_TOKEN), hasLLM: llmConfig().enabled })
})

// ---- 分类 ----
app.get('/api/categories', (req, res) => res.json({ ok: true, data: getCategories() }))

app.post('/api/categories', (req, res) => {
  const { name, kind } = req.body || {}
  const n = typeof name === 'string' ? name.trim().slice(0, 20) : ''
  const k = kind === 'income' ? 'income' : 'expense'
  if (!n) return fail(res, 400, 'bad_request', '分类名不能为空')
  db.prepare('INSERT OR IGNORE INTO categories (name, kind) VALUES (?, ?)').run(n, k)
  res.json({ ok: true, data: getCategories() })
})

app.delete('/api/categories/:name', (req, res) => {
  const n = String(req.params.name || '').trim().slice(0, 20)
  if (!n) return fail(res, 400, 'bad_request', '分类名不能为空')
  const defaults = [...DEFAULT_CATEGORIES.expense, ...DEFAULT_CATEGORIES.income]
  if (defaults.includes(n)) return fail(res, 400, 'bad_request', '默认分类不能删除')
  db.prepare('DELETE FROM categories WHERE name = ?').run(n)
  res.json({ ok: true, data: getCategories() })
})

// [已停用 v26.9.9] 文字记账（粘贴交易通知 → LLM 解析）：当前只走微信/支付宝账单通道。
// 恢复方式：整段取消注释即可（captureTextCore 的 import 未动）。
/*
app.post('/api/capture', async (req, res) => {
  const { text, ts, client_id: cid } = req.body || {}
  if (typeof text !== 'string' || !text.trim()) return fail(res, 400, 'bad_request', 'text 不能为空')
  const clientId = cid ? String(cid).slice(0, 64) : null

  // 幂等：离线队列重试时不会重复入库
  if (clientId) {
    const exist = db.prepare('SELECT * FROM transactions WHERE client_id = ?').get(clientId)
    if (exist) return res.json({ ok: true, data: { transaction: exist, parse: { code: 'duplicate' } } })
  }

  const r = await captureTextCore(text, clientId, 'text', autoConfirmAt())
  res.status(201).json({ ok: true, data: r })
})
*/

// ---- 账单导入（微信/支付宝/银行 CSV，邮箱自动收取或手动上传） ----
const liveEvents = new EventEmitter()
const billStatus = { enabled: false, lastRun: null, imported: 0, skipped: 0, merged: 0, reviewedPairs: 0, categorized: 0, passwords: 0, error: '', errors: [] }
async function runBillImport() {
  billStatus.enabled = mailConfig().billsEnabled
  try {
    const r = await importBills(mailConfig())
    billStatus.lastRun = nowIso()
    // 幽灵模式防抖：记录每次导入尝试时间（成功与否都算），启动补扫据此跳过 6 小时内的重复扫描
    try { db.prepare("INSERT INTO meta (k, v) VALUES ('last_import_attempt', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(Date.now())) } catch { /* 忽略 */ }
    billStatus.imported = r.imported
    billStatus.skipped = r.skipped
    billStatus.merged = r.merged || 0
    billStatus.reviewedPairs = r.reviewedPairs || 0
    billStatus.deterministic = r.deterministic || 0
    billStatus.categorized = r.categorized || 0
    billStatus.passwords = r.passwords || 0
    billStatus.error = r.error || ''
    billStatus.errors = Array.isArray(r.errors) ? r.errors.slice(0, 20) : []
    // 记录最近一次成功收到账单的时间（月报用它判断是否需要提醒）
    if (!r.error && r.files > 0) {
      db.prepare("INSERT INTO meta (k, v) VALUES ('last_bill_import', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(nowIso())
      const errNote = (r.errors || []).length ? `；⚠ ${r.errors.length} 处失败（解析/下载/解压），见邮箱账单页` : ''
      // 有实质变化 或 有失败需要知晓 → 都提示（失败也必须有红点，不再静默）
      if ((r.imported || 0) > 0 || (r.merged || 0) > 0 || (r.errors || []).length > 0) {
        // 通知已打开的网页：月度账单处理完成，刷新账本
        liveEvents.emit('bills', { imported: r.imported || 0, skipped: r.skipped || 0, files: r.files, errors: (r.errors || []).length })
        // 事件中心：顶栏红点 + 邮箱动态（账单邮件处理完成）
        pushEvent('bill', '账单邮件处理完成', `收到 ${r.files} 封账单邮件：新增 ${r.imported || 0} 笔，合并重复 ${(r.merged || 0) + (r.deterministic || 0)} 笔（其中程序直并 ${r.deterministic || 0} 笔），跳过 ${r.skipped || 0} 笔${r.mergeError ? `；⚠ 合并审核失败(${r.mergeError})，新增可能含重复` : ''}${errNote}`)
      }
    }
    return r
  } catch (e) {
    billStatus.lastRun = nowIso()
    try { db.prepare("INSERT INTO meta (k, v) VALUES ('last_import_attempt', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(Date.now())) } catch { /* 忽略 */ }
    billStatus.error = String(e?.message || e).slice(0, 200)
    billStatus.errors = []
    return { imported: 0, skipped: 0, passwords: 0, error: billStatus.error }
  }
}
app.post('/api/import-bills', async (req, res) => {
  if (!mailConfig().billsEnabled) return fail(res, 400, 'not_configured', '未配置账单邮件导入（.env 里的 MAIL_USER/MAIL_PASS 与 AUTO_IMPORT=1），见 README')
  res.json({ ok: true, data: await runBillImport() })
})
app.post('/api/import-bills/file', express.raw({ type: () => true, limit: '20mb' }), async (req, res) => {
  const kind = String(req.query.kind || '')
  let parsed
  if (kind === 'alipay') parsed = parseAlipayCsv(req.body)
  else if (kind === 'bank') parsed = parseBankCsv(req.body)
  else parsed = parseWechatCsv(req.body.toString('utf8'))
  if (parsed.error) return fail(res, 400, 'parse_error', parsed.error)
  res.json({ ok: true, data: await importBillRows(parsed.rows) })
})

// ---- 实时事件流：月度账单处理完成后推送事件，网页据此刷新账本（其他邮件不推送） ----
// EventSource 无法带自定义请求头，令牌走查询参数 ?t=
app.get('/api/events', (req, res) => {
  if (!AUTH_TOKEN || !req.query.t || !tokenOk(String(req.query.t), AUTH_TOKEN)) {
    return res.status(401).json({ ok: false, code: 'auth', error: '访问令牌无效' })
  }
  res.set('Content-Type', 'text/event-stream')
  res.set('Cache-Control', 'no-store')
  res.set('Connection', 'keep-alive')
  res.write('retry: 15000\n\n')
  const onBills = (d) => { try { res.write(`event: bills\ndata: ${JSON.stringify(d)}\n\n`) } catch { /* 连接已断 */ } }
  liveEvents.on('bills', onBills)
  // 事件中心：邮件回信/自动入账/月报等实时推给网页（toast + 邮箱动态刷新）
  const onNotify = (ev) => { try { res.write(`event: notify\ndata: ${JSON.stringify(ev)}\n\n`) } catch { /* 连接已断 */ } }
  const offNotify = onEvent(onNotify)
  const hb = setInterval(() => { try { res.write(': hb\n\n') } catch { /* 忽略 */ } }, 25000)
  req.on('close', () => { clearInterval(hb); liveEvents.off('bills', onBills); offNotify() })
})

// ---- 事件中心拉取：邮箱助手动态（托盘不经过这里，直接读 data/notify.json） ----
app.get('/api/notify', (req, res) => {
  const after = Number(req.query.after) || 0
  res.json({ ok: true, ...recentEvents(after, 30) })
})

// ---- 预算（借鉴 Firefly/Actual：月度分类限额 + 进度跟踪） ----
// ---- 理财健康度：50/30/20 法则 + 先存后花日可花 + 信封预算总览 ----
const FIN_NEEDS = new Set(['餐饮', '交通', '日用品', '医疗', '通讯', '生活缴费', '住宿'])
const FIN_WANTS = new Set(['购物', '娱乐', '运动', '人情', '学习'])
app.get('/api/finance', (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : currentMonth()
  const s = summarizeMonth(month)
  let needs = 0, wants = 0
  for (const c of s.byCategory || []) {
    if (FIN_NEEDS.has(c.name)) needs += Number(c.total) || 0
    else if (FIN_WANTS.has(c.name)) wants += Number(c.total) || 0
  }
  const expense = Number(s.expense) || 0
  const income = Number(s.income) || 0
  const other = Math.max(0, expense - needs - wants) // 未分类等
  const pctOfIncome = (v) => income > 0 ? Math.round((v / income) * 100) : null
  const savings = income - expense
  const savingsRate = income > 0 ? Math.round((savings / income) * 100) : null
  // 先存后花：本月剩余每天可花 =（收入×80% − 已花）÷ 剩余天数（含今天），负数取 0
  const now = new Date()
  const isCurrent = month === currentMonth()
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
  const daysLeft = isCurrent ? daysInMonth - now.getDate() + 1 : daysInMonth
  const safeToday = isCurrent && income > 0 && daysLeft > 0
    ? Math.max(0, Math.floor(((income * 0.8 - expense) / daysLeft) * 100) / 100)
    : null
  const budgetTotal = Number(db.prepare('SELECT COALESCE(SUM(limit_amount), 0) AS lim FROM budgets WHERE month = ?').get(month)?.lim) || 0
  res.json({ ok: true, data: {
    month,
    needs: { total: Math.round(needs * 100) / 100, pct: pctOfIncome(needs), target: 50 },
    wants: { total: Math.round(wants * 100) / 100, pct: pctOfIncome(wants), target: 30 },
    other: { total: Math.round(other * 100) / 100, pct: pctOfIncome(other) },
    savings: { total: Math.round(savings * 100) / 100, rate: savingsRate, target: 20 },
    income: Math.round(income * 100) / 100, expense: Math.round(expense * 100) / 100,
    safeToday, daysLeft, budgetTotal,
  } })
})

app.get('/api/budgets', (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : currentMonth()
  const rows = db.prepare(`
    SELECT b.category, b.limit_amount AS lim, COALESCE(SUM(t.amount), 0) AS spent
    FROM budgets b LEFT JOIN transactions t
      ON t.category = b.category AND t.direction = 'expense' AND t.status = 'confirmed'
      AND t.ts LIKE ? AND t.amount IS NOT NULL
    WHERE b.month = ?
    GROUP BY b.category, b.limit_amount ORDER BY b.category
  `).all(month + '%', month)
    .map((r) => ({ category: r.category, limit: Number(r.lim), spent: Math.round(Number(r.spent) * 100) / 100 }))
  res.json({ ok: true, data: { month, list: rows } })
})

app.put('/api/budgets', (req, res) => {
  const { month, category, limit } = req.body || {}
  const m = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) ? month : currentMonth()
  const cat = typeof category === 'string' ? category.trim().slice(0, 20) : ''
  const lim = Number(limit)
  if (!cat) return fail(res, 400, 'bad_request', '分类不能为空')
  if (!Number.isFinite(lim) || lim <= 0) return fail(res, 400, 'bad_request', '限额必须为正数')
  db.prepare('INSERT INTO budgets (month, category, limit_amount, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(month, category) DO UPDATE SET limit_amount = excluded.limit_amount, updated_at = excluded.updated_at')
    .run(m, cat, Math.round(lim * 100) / 100, nowIso())
  res.json({ ok: true, data: { month: m, category: cat, limit: Math.round(lim * 100) / 100 } })
})

app.delete('/api/budgets', (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : currentMonth()
  const category = String(req.query.category || '').trim()
  if (!category) return fail(res, 400, 'bad_request', '分类不能为空')
  db.prepare('DELETE FROM budgets WHERE month = ? AND category = ?').run(month, category)
  res.json({ ok: true, data: { deleted: true } })
})

// ---- 月度报告（邮箱 / Server酱 微信推送） ----
// lite=1：跳过 LLM 叙述与平替推荐（冒烟测试/快速预览用），只构建纯文本汇总
app.get('/api/report/preview', async (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : currentMonth()
  const s = summarizeMonth(month)
  if (req.query.lite === '1') {
    const text = buildReportText(s, '', [])
    return res.json({ ok: true, data: { text, html: '', narrative: '', alts: [], channels: { email: mailerConfig().enabled, serverchan: Boolean(serverChanKey()) } } })
  }
  const narrative = await generateReportNarrative(s)
  const alts = await analyzeBillForAlternatives(month)
  if (alts.length) saveAltRec(month, alts)
  res.json({ ok: true, data: { text: buildReportText(s, narrative, alts), html: buildReportHtml(s, narrative, alts), narrative, alts, channels: { email: mailerConfig().enabled, serverchan: Boolean(serverChanKey()) } } })
})

app.post('/api/report', async (req, res) => {
  const month = typeof req.body?.month === 'string' && /^\d{4}-\d{2}$/.test(req.body.month) ? req.body.month : currentMonth()
  if (!mailerConfig().enabled && !serverChanKey()) {
    return fail(res, 400, 'not_configured', '未配置任何发送渠道（SMTP_* 或 SERVERCHAN_KEY），见 README「月报提醒」')
  }
  const r = await sendMonthlyReport(month)
  pushEvent('report', '月报已发送', `${month} 月度汇总已送达（${(r.channels || []).join('、') || '无渠道'}）`)
  res.json({ ok: true, data: { month, channels: r.channels } })
})

// ---- 平替与优质推荐（网页统计栏展示；结果缓存到 meta，force=1 强制重新分析） ----
const altRecKey = (m) => `alt_rec_${m}`
function cachedAltRec(m) {
  try {
    const v = db.prepare('SELECT v FROM meta WHERE k = ?').get(altRecKey(m))?.v
    return v ? JSON.parse(v) : null
  } catch { return null }
}
function saveAltRec(m, items) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(altRecKey(m), JSON.stringify(items || []))
}
app.get('/api/recommend', async (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : currentMonth()
  if (req.query.force !== '1') {
    const cached = cachedAltRec(month)
    if (cached) return res.json({ ok: true, data: { month, items: cached, cached: true } })
  }
  try {
    const items = await analyzeBillForAlternatives(month)
    if (items.length) saveAltRec(month, items)
    res.json({ ok: true, data: { month, items, cached: false } })
  } catch (e) {
    fail(res, 500, 'server_error', '推荐生成失败：' + String(e?.message || e).slice(0, 100))
  }
})

// 每月 1 日 REPORT_HOUR 点自动发送上月报告（用 meta 表防重复）
async function checkMonthlyReport() {
  const d = new Date()
  if (d.getDate() !== Number(env('REPORT_DAY', '1')) || d.getHours() !== Number(env('REPORT_HOUR', '9'))) return
  if (!mailerConfig().enabled && !serverChanKey()) return
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const key = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
  const sent = db.prepare("SELECT v FROM meta WHERE k = 'last_report_month'").get()?.v
  if (sent === key) return
  await sendMonthlyReport(key)
  db.prepare("INSERT INTO meta (k, v) VALUES ('last_report_month', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key)
  pushEvent('report', '月报已自动发送', `${key} 月度汇总已送达你的邮箱/微信`)
}

// [已停用 v26.9.9] 图片记账（支付截图 → 视觉模型解析）：当前只走微信/支付宝账单通道。
// 恢复方式：整段取消注释即可（captureImageCore / detectImage 的 import 未动）。
// 注：/api/image/:name 保留——账本里历史记录仍要能显示已存的截图。
/*
app.post('/api/capture-image', express.raw({ type: (req) => !req.is('application/json'), limit: '16mb' }), async (req, res) => {
  let buf = null
  let mime = 'image/jpeg'
  let clientId = null
  if (req.is('application/json')) {
    let j
    try { j = JSON.parse(req.body.toString('utf8')) } catch { return fail(res, 400, 'bad_request', 'JSON 解析失败') }
    const b64 = String(j.image_base64 || j.image || '').replace(/^data:[^;]+;base64,/, '')
    buf = Buffer.from(b64, 'base64')
    mime = String(j.mime || 'image/jpeg')
    clientId = j.client_id ? String(j.client_id).slice(0, 64) : null
  } else {
    buf = req.body
    mime = (req.get('content-type') || '').split(';')[0].trim()
    clientId = req.query.client_id ? String(req.query.client_id).slice(0, 64) : null
  }
  const real = detectImage(buf)
  if (!real) return fail(res, 400, 'bad_request', '不支持的图片格式（支持 JPG/PNG/GIF/BMP/WebP）')
  mime = real

  if (clientId) {
    const exist = db.prepare('SELECT * FROM transactions WHERE client_id = ?').get(clientId)
    if (exist) return res.json({ ok: true, data: { transaction: exist, parse: { code: 'duplicate' } } })
  }

  const { transaction, parse } = await captureImageCore(buf, mime, clientId, 'image', autoConfirmAt())
  res.status(201).json({ ok: true, data: { transaction, parse } })
})
*/

// 已保存的截图（随机文件名即访问凭证；配合 token 鉴权场景外的 <img> 使用）
app.get('/api/image/:name', (req, res) => {
  const name = String(req.params.name || '').replace(/[^a-zA-Z0-9._-]/g, '')
  const imageRoot = path.resolve(DATA_DIR, 'images')
  const resolved = path.resolve(imageRoot, name)
  // 防路径穿越：解析后必须仍在图片目录内
  if (!name || !resolved.startsWith(imageRoot + path.sep) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return fail(res, 404, 'not_found', '图片不存在')
  }
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' }[path.extname(name).toLowerCase()] || 'image/jpeg'
  res.set('Cache-Control', 'private, max-age=31536000').set('Content-Type', mime).send(fs.readFileSync(resolved))
})

// ---- 手动创建（直接确认入账） ----
app.post('/api/transactions', (req, res) => {
  const b = req.body || {}
  const amount = Number(b.amount)
  if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, 'bad_request', '金额必须为正数')
  const direction = DIRECTIONS.includes(b.direction) ? b.direction : 'expense'
  const merchant = typeof b.merchant === 'string' ? b.merchant.trim().slice(0, 120) : ''
  const goodsName = typeof b.goods_name === 'string' ? b.goods_name.trim().slice(0, 120) : ''
  const category = direction === 'expense' ? normalizeCategory(b.category) || '其他' : null
  const account = ACCOUNTS.includes(b.account) ? b.account : 'other'
  const ts = validTs(b.ts) || nowIso()
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : ''
  const info = db.prepare(`
    INSERT INTO transactions (uid, ts, created_at, amount, currency, direction, merchant, goods_name, category, account, raw_text, source, status, note, edited, rev, updated_at)
    VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, NULL, 'manual', 'confirmed', ?, 0, ?, ?)
  `).run(newUid(), ts, nowIso(), Math.round(amount * 100) / 100, direction, merchant, goodsName, category, account, note, nextRev(), nowIso())
  if (merchant && category) upsertRule(merchant, category)
  res.status(201).json({ ok: true, data: getTx(info.lastInsertRowid) })
})

// ---- 确认待处理记录（可带修改） ----
app.post('/api/transactions/:id/confirm', (req, res) => {
  const tx = getTx(req.params.id)
  if (!tx) return fail(res, 404, 'not_found', '记录不存在')
  const o = req.body?.overrides || {}
  const amount = o.amount !== undefined ? Number(o.amount) : tx.amount
  if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, 'bad_request', '金额必须为正数')
  const direction = DIRECTIONS.includes(o.direction ?? tx.direction) ? (o.direction ?? tx.direction) : tx.direction
  const merchant = o.merchant !== undefined ? String(o.merchant).trim().slice(0, 120) : (tx.merchant || '')
  const goodsName = o.goods_name !== undefined ? String(o.goods_name).trim().slice(0, 120) : (tx.goods_name || '')
  const category = direction === 'expense' ? normalizeCategory(o.category ?? tx.category) || '其他' : null
  const account = ACCOUNTS.includes(o.account ?? tx.account) ? (o.account ?? tx.account) : tx.account
  const ts = validTs(o.ts) || tx.ts
  const note = o.note !== undefined ? String(o.note).trim().slice(0, 200) : (tx.note || '')
  db.prepare(`
    UPDATE transactions SET ts = ?, amount = ?, direction = ?, merchant = ?, goods_name = ?, category = ?, account = ?, note = ?, status = 'confirmed', edited = edited + 1
    WHERE id = ?
  `).run(ts, Math.round(amount * 100) / 100, direction, merchant, goodsName, category, account, note, tx.id)
  bumpTx(tx.id)
  if (merchant && category) upsertRule(merchant, category)
  res.json({ ok: true, data: getTx(tx.id) })
})

// ---- 编辑 / 删除 ----
app.patch('/api/transactions/:id', (req, res) => {
  const tx = getTx(req.params.id)
  if (!tx) return fail(res, 404, 'not_found', '记录不存在')
  const b = req.body || {}
  const patch = {}
  if (b.amount !== undefined) {
    const a = Number(b.amount)
    if (!Number.isFinite(a) || a <= 0) return fail(res, 400, 'bad_request', '金额必须为正数')
    patch.amount = Math.round(a * 100) / 100
  }
  if (b.direction !== undefined) patch.direction = DIRECTIONS.includes(b.direction) ? b.direction : tx.direction
  if (b.merchant !== undefined) patch.merchant = String(b.merchant).trim().slice(0, 120)
  if (b.goods_name !== undefined) patch.goods_name = String(b.goods_name).trim().slice(0, 120)
  if (b.category !== undefined) {
    patch.category = (patch.direction ?? tx.direction) === 'expense' ? normalizeCategory(b.category) || '其他' : null
  }
  if (b.account !== undefined) patch.account = ACCOUNTS.includes(b.account) ? b.account : tx.account
  if (b.ts !== undefined) patch.ts = validTs(b.ts) || tx.ts
  if (b.note !== undefined) patch.note = String(b.note).trim().slice(0, 200)
  if (b.status !== undefined && ['pending', 'confirmed'].includes(b.status)) patch.status = b.status
  if (Object.keys(patch).length === 0) return fail(res, 400, 'bad_request', '没有可更新的字段')
  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE transactions SET ${sets}, edited = edited + 1 WHERE id = ?`).run(...Object.values(patch), tx.id)
  bumpTx(tx.id)
  res.json({ ok: true, data: getTx(tx.id) })
})

app.delete('/api/transactions/:id', (req, res) => {
  const tx = getTx(req.params.id)
  if (!tx) return fail(res, 404, 'not_found', '记录不存在')
  // 删除 → 墓碑（供同步传播删除）+ 清除行
  db.prepare('INSERT INTO tombstones (uid, rev, updated_at) VALUES (?, ?, ?)').run(tx.uid || newUid(), nextRev(), nowIso())
  db.prepare('DELETE FROM transactions WHERE id = ?').run(tx.id)
  res.json({ ok: true, data: { deleted: tx.id } })
})

// ---- 双向同步：增量拉取 ----
app.get('/api/sync', (req, res) => {
  const since = Math.max(Number(req.query.since) || 0, 0)
  const cur = currentRev()
  const rows = db.prepare('SELECT * FROM transactions WHERE rev > ?').all(since)
  const changes = rows.map((r) => ({ uid: r.uid, type: 'put', rev: r.rev, data: txToSync(r) }))
  const tombs = db.prepare('SELECT * FROM tombstones WHERE rev > ?').all(since)
  for (const t of tombs) changes.push({ uid: t.uid, type: 'del', rev: t.rev, updated_at: t.updated_at })
  changes.sort((a, b) => a.rev - b.rev)
  res.json({ ok: true, data: { rev: cur, changes } })
})

// 客户端提交的字段清洗（与手动创建同规）
function sanitizeTxData(raw) {
  if (!raw || typeof raw !== 'object') return null
  const amount = raw.amount == null ? null : Number(raw.amount)
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) return null
  const direction = DIRECTIONS.includes(raw.direction) ? raw.direction : 'expense'
  const status = ['pending', 'confirmed'].includes(raw.status) ? raw.status : 'confirmed'
  const ts = validTs(raw.ts) || nowIso()
  const cat = direction === 'expense' ? (typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim().slice(0, 20) : '其他') : null
  return {
    ts,
    amount: amount === null ? null : Math.round(amount * 100) / 100,
    direction,
    merchant: typeof raw.merchant === 'string' ? raw.merchant.trim().slice(0, 120) : '',
    goods_name: typeof raw.goods_name === 'string' ? raw.goods_name.trim().slice(0, 120) : '',
    category: cat,
    account: ACCOUNTS.includes(raw.account) ? raw.account : 'other',
    raw_text: typeof raw.raw_text === 'string' ? raw.raw_text.slice(0, 4000) : '',
    raw_image: typeof raw.raw_image === 'string' ? raw.raw_image.slice(0, 200) : null,
    image_base64: typeof raw.image_base64 === 'string' ? raw.image_base64.slice(0, 12 * 1024 * 1024) : null,
    source: ['text', 'image', 'manual'].includes(raw.source) ? raw.source : 'manual',
    status,
    confidence: raw.confidence == null ? null : Math.min(1, Math.max(0, Number(raw.confidence) || 0)),
    note: typeof raw.note === 'string' ? raw.note.trim().slice(0, 200) : '',
    client_id: typeof raw.client_id === 'string' ? raw.client_id.slice(0, 64) : null,
    created_at: validTs(raw.created_at) || nowIso(),
  }
}

// 应用单条客户端变更（冲突按 updated_at 裁决：服务器更新则跳过）
async function applyChange(c) {
  if (!c || typeof c.uid !== 'string' || !c.uid || c.uid.length > 80) throw new Error('bad uid')
  const existing = db.prepare('SELECT * FROM transactions WHERE uid = ?').get(c.uid)
  const incomingTs = String(c.updated_at || '')
  const now = nowIso()

  if (c.type === 'del') {
    if (existing) {
      if ((existing.updated_at || '') > incomingTs) return // 服务器版本更新，保留
      db.prepare('INSERT INTO tombstones (uid, rev, updated_at) VALUES (?, ?, ?)').run(c.uid, nextRev(), now)
      db.prepare('DELETE FROM transactions WHERE uid = ?').run(c.uid)
    }
    return
  }

  const d = sanitizeTxData(c.data)
  if (!d) throw new Error('bad data')

  // 离线采集的截图：先落盘，再跑视觉解析补全字段
  if (d.image_base64 && !d.raw_image) {
    const buf = Buffer.from(d.image_base64, 'base64')
    const mime = detectImage(buf)
    if (mime) {
      d.raw_image = saveImage(buf, mime)
      const vr = await parseImage(buf, mime)
      if (vr.ok) {
        const v = vr.data
        d.ts = v.ts || d.ts
        if (v.amount != null) d.amount = v.amount
        if (v.merchant) d.merchant = v.merchant
        if (v.goods_name) d.goods_name = v.goods_name
        if (v.category && d.direction === 'expense') d.category = v.category
        d.account = v.account
        d.raw_text = v.raw_text || d.raw_text
        d.confidence = v.confidence
        // 同步补识别的截图：置信度达标同样自动入账
        if (d.amount != null && d.confidence != null && d.confidence >= autoConfirmAt()) d.status = 'confirmed'
      }
    }
  }

  if (existing) {
    if ((existing.updated_at || '') > incomingTs) return // 服务器版本更新，跳过
    const rev = nextRev()
    db.prepare(`
      UPDATE transactions SET ts=?, amount=?, direction=?, merchant=?, goods_name=?, category=?, account=?, raw_text=?, raw_image=?, source=?, status=?, confidence=?, note=?, client_id=?, edited=edited+1, rev=?, updated_at=?
      WHERE uid=?
    `).run(d.ts, d.amount, d.direction, d.merchant, d.goods_name, d.category, d.account, d.raw_text, d.raw_image, d.source, d.status, d.confidence, d.note, d.client_id, rev, now, c.uid)
    if (d.merchant && d.category) upsertRule(d.merchant, d.category)
    return
  }

  // 新增：client_id 幂等（同一采集重试不重复）
  if (d.client_id) {
    const byClient = db.prepare('SELECT * FROM transactions WHERE client_id = ? AND uid != ?').get(d.client_id, c.uid)
    if (byClient) return
  }
  const rev = nextRev()
  db.prepare(`
    INSERT INTO transactions (uid, client_id, ts, created_at, amount, currency, direction, merchant, goods_name, category, account, raw_text, raw_image, source, status, confidence, note, edited, rev, updated_at)
    VALUES (?,?,?,?,?,'CNY',?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(c.uid, d.client_id, d.ts, d.created_at, d.amount, d.direction, d.merchant, d.goods_name, d.category, d.account, d.raw_text, d.raw_image, d.source, d.status, d.confidence, d.note, 0, rev, now)
  if (d.merchant && d.category) upsertRule(d.merchant, d.category)
}

// ---- 双向同步：推送本地变更 ----
app.post('/api/sync', async (req, res) => {
  const b = req.body || {}
  const changes = Array.isArray(b.changes) ? b.changes.slice(0, 200) : []
  const applied = []
  const skipped = []
  for (const c of changes) {
    try { await applyChange(c); applied.push(c.uid) } catch (e) { skipped.push(c.uid) }
  }
  res.json({ ok: true, data: { rev: currentRev(), applied, skipped } })
})

// ---- 列表 ----
app.get('/api/transactions', (req, res) => {
  const { status, month, q, limit, offset, order } = req.query
  const cond = []
  const params = []
  if (status === 'pending' || status === 'confirmed') { cond.push('status = ?'); params.push(status) }
  if (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)) { cond.push('ts LIKE ?'); params.push(month + '%') }
  if (typeof q === 'string' && q.trim()) {
    cond.push('(merchant LIKE ? OR raw_text LIKE ? OR note LIKE ?)')
    const like = `%${q.trim()}%`
    params.push(like, like, like)
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : ''
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const off = Math.max(Number(offset) || 0, 0)
  const ord = order === 'asc' ? 'ASC' : 'DESC'
  const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions ${where}`).get(...params).n
  const items = db.prepare(`SELECT * FROM transactions ${where} ORDER BY ts ${ord}, id ${ord} LIMIT ? OFFSET ?`).all(...params, lim, off)
  res.json({ ok: true, data: { items, total, limit: lim, offset: off } })
})

// ---- 月度汇总 ----
app.get('/api/summary', (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : currentMonth()
  const like = month + '%'
  const base = "FROM transactions WHERE ts LIKE ? AND status = 'confirmed' AND amount IS NOT NULL"
  const sum = (extra) => Number(db.prepare(`SELECT SUM(amount) AS s ${base} ${extra}`).get(like)?.s ?? 0)
  const expense = sum("AND direction = 'expense'")
  const income = sum("AND direction = 'income'")
  const refund = sum("AND direction = 'refund'")
  const transfer = sum("AND direction = 'transfer'")
  const byCategory = db.prepare(`
    SELECT category AS name, SUM(amount) AS total, COUNT(*) AS n ${base} AND direction = 'expense'
    GROUP BY category ORDER BY total DESC
  `).all(like).map((r) => ({ name: r.name, total: Number(r.total), n: Number(r.n) }))
  const count = Number(db.prepare(`SELECT COUNT(*) AS n ${base}`).get(like)?.n ?? 0)
  const pendingCount = Number(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending'").get()?.n ?? 0)
  res.json({
    ok: true,
    data: { month, expense, income, refund, transfer, balance: income + refund - expense, count, byCategory, pendingCount },
  })
})

// ---- 账单核验（原始账单行 vs 账本逐行比对 + 强模型终审；报告可下载 CSV） ----
const validMonth = (v) => (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) ? v : currentMonth())
app.get('/api/audit', async (req, res) => {
  try { res.json({ ok: true, data: await auditMonth(validMonth(req.query.month)) }) }
  catch (e) { fail(res, 500, 'audit_error', String(e?.message || e).slice(0, 200)) }
})
app.get('/api/audit/export', async (req, res) => {
  try {
    const month = validMonth(req.query.month)
    const data = await auditMonth(month)
    res.set('Content-Type', 'text/csv; charset=utf-8')
    res.set('Content-Disposition', `attachment; filename="pennywise-audit-${month}.csv"`)
    res.set('Cache-Control', 'no-store')
    res.send('\uFEFF' + buildAuditCsv(data))
  } catch (e) { fail(res, 500, 'audit_error', String(e?.message || e).slice(0, 200)) }
})

// ---- AI 批量分类：未分类支出分批交给 LLM 推理，输出结构化分类并写回（GET 预览不计费） ----
const optMonth = (v) => (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) ? v : '')
app.get('/api/classify', (req, res) => {
  res.json({ ok: true, data: classifyPreview(optMonth(req.query.month)) })
})
app.post('/api/classify', async (req, res) => {
  try {
    const b = req.body || {}
    const data = await classifyPending({ month: optMonth(b.month), apply: b.apply !== false })
    res.json({ ok: true, data })
  } catch (e) { fail(res, 500, 'classify_error', String(e?.message || e).slice(0, 200)) }
})

// ---- 数据质量体检：先程序合并预处理（apply），再可选 LLM 复核剩余异常（只给意见不改账） ----
// month 缺省 = 全量体检；llm=1 / {llm:true} 才调用模型复核（默认纯程序，秒回零 token）
app.get('/api/quality', async (req, res) => {
  try { res.json({ ok: true, data: await qualityCheck({ month: optMonth(req.query.month), apply: false, llm: req.query.llm === '1' }) }) }
  catch (e) { fail(res, 500, 'quality_error', String(e?.message || e).slice(0, 200)) }
})
app.post('/api/quality', async (req, res) => {
  try {
    const b = req.body || {}
    const data = await qualityCheck({ month: optMonth(b.month), apply: b.apply === true, llm: b.llm === true })
    res.json({ ok: true, data })
  } catch (e) { fail(res, 500, 'quality_error', String(e?.message || e).slice(0, 200)) }
})

// ---- 账单导出：总账单 / 微信 / 支付宝 / 按分类 + 精美分析 PDF ----
// 统一筛选参数：month=YYYY-MM 或 from/to=YYYY-MM-DD；channel=all|wechat|alipay|bank|cash|other；category=分类名
// 排除规则：默认取已保存的导出偏好；noexclude=1 可本次临时跳过（不影响已存偏好）
const optDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '')
function exportFilter(q = {}) {
  const month = optMonth(q.month)
  // 有月份就用月份；否则用自定义区间
  return {
    month,
    from: month ? '' : optDate(q.from),
    to: month ? '' : optDate(q.to),
    channel: typeof q.channel === 'string' && q.channel ? q.channel : 'all',
    category: typeof q.category === 'string' ? q.category.trim() : '',
  }
}
// 取本次导出要应用的排除规则：显式传 rules=JSON 优先，否则用已存偏好；支持 noexclude=1 跳过
function exportExcludes(q = {}) {
  if (q.noexclude === '1' || q.noexclude === 'true') return []
  if (typeof q.rules === 'string' && q.rules) {
    try { return normalizeRules(JSON.parse(q.rules)) } catch { /* 解析失败则退回偏好 */ }
  }
  const prefs = getExportPrefs()
  return prefs.excludeOn ? prefs.excludeRules : []
}
// 查询 + 应用排除规则，返回 { rows, excluded, rules }
function queryRowsFiltered(q = {}) {
  const f = exportFilter(q)
  const raw = queryRows(f)
  const rules = exportExcludes(q)
  const { kept, excluded } = applyExcludes(raw, rules)
  return { f, rows: kept, excluded, rules }
}
function rangeLabelOf(f) {
  if (f.month) return f.month.replace('-', '年') + '月'
  if (f.from || f.to) return `${f.from || '最早'} ~ ${f.to || '今天'}`
  return '全部时间'
}
// 下载用的文件名（ASCII 安全 + 中文名双轨，浏览器优先取 filename*）
function attachName(res, base, ext) {
  const ascii = base.replace(/[^\w.-]/g, '_')
  res.set('Content-Disposition', `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(base + '.' + ext)}`)
}

// 导出预览：给前端显示"将导出多少笔、合计多少"（同时告知剔除了多少）
app.get('/api/export/preview', (req, res) => {
  try {
    const { f, rows, excluded, rules } = queryRowsFiltered(req.query)
    const exSum = excluded.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0)
    res.json({
      ok: true,
      data: {
        ...summarize(rows, { rangeLabel: rangeLabelOf(f) }),
        rangeLabel: rangeLabelOf(f),
        hasPdf: Boolean(findBrowser()),
        exclude: { count: excluded.length, amount: exSum, rules: rules.length, labels: rules.map(ruleLabel) },
        rawCount: rows.length + excluded.length,
      },
    })
  } catch (e) { fail(res, 500, 'export_error', String(e?.message || e).slice(0, 200)) }
})

// 账单下载：format=xlsx|csv
app.get('/api/export/bills', async (req, res) => {
  try {
    const { f, rows, excluded, rules } = queryRowsFiltered(req.query)
    if (!rows.length) return fail(res, 404, 'empty', '该筛选条件下没有记录')
    const fmt = req.query.format === 'csv' ? 'csv' : 'xlsx'
    const base = `PennyWise账单_${rangeLabelOf(f)}_${f.channel === 'all' ? '全部渠道' : channelLabel(f.channel)}${f.category ? '_' + f.category : ''}${excluded.length ? '_已剔除' + excluded.length + '笔' : ''}`
    res.set('Cache-Control', 'no-store')
    if (fmt === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8')
      attachName(res, base, 'csv')
      return res.send('\uFEFF' + buildCsv(rows))
    }
    const buf = await buildXlsx(rows, {
      rangeLabel: rangeLabelOf(f),
      channelLabel: f.channel === 'all' ? '全部' : channelLabel(f.channel),
      category: f.category,
      excluded, excludeRules: rules,
    })
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    attachName(res, base, 'xlsx')
    res.send(buf)
  } catch (e) { fail(res, 500, 'export_error', String(e?.message || e).slice(0, 200)) }
})

// 导出 HTML 预览（浏览器里直接看，也是 PDF 的渲染源）
app.get('/api/export/report.html', async (req, res) => {
  try {
    const { html } = await buildExportReport(req.query)
    res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').send(html)
  } catch (e) { fail(res, 500, 'export_error', String(e?.message || e).slice(0, 200)) }
})

// 生成分析报告（含可选 AI 分析）：blocks=charts,ai,budget,detail（默认全开）
// 排除规则通过 blocks 之外的 excludes / noexclude 控制，同样作用于报告统计口径
async function buildExportReport(q = {}) {
  const { f, rows, excluded, rules } = queryRowsFiltered(q)
  if (!rows.length) { const e = new Error('该筛选条件下没有记录'); e.code = 'empty'; throw e }
  // blocks 若显式传了（逗号分隔或 1/0 单块），按需解析；否则默认四块全开
  const on = (k) => q[k] === undefined ? true : (q[k] === '1' || q[k] === 'true')
  const blocks = { charts: on('charts'), ai: on('ai'), budget: on('budget'), detail: on('detail') }
  const rangeLabel = rangeLabelOf(f)
  const meta = {
    rangeLabel,
    channelLabel: f.channel === 'all' ? '全部' : channelLabel(f.channel),
    category: f.category || '全部',
    excluded, excludeRules: rules,
  }

  let narrative = ''
  let alts = []
  // AI 文字分析：复用月报的叙述生成（仅在勾选时调用；60 秒超时，失败不影响导出）
  if (blocks.ai) {
    try {
      const s = summarize(rows, meta)
      // 按分类聚合（generateReportNarrative 需要 byCategory）
      const catMap = new Map()
      for (const r of rows) {
        if (r.direction !== 'expense') continue
        const k = r.category || '未分类'
        const o = catMap.get(k) || { name: k, total: 0, n: 0 }
        o.total += Math.abs(Number(r.amount) || 0); o.n += 1
        catMap.set(k, o)
      }
      const exp = rows.filter((r) => r.direction === 'expense')
      const sFull = {
        ...s,
        month: f.month || rangeLabel.replace(/[^\d-]/g, '') || '自定义区间',
        balance: s.net,
        byCategory: [...catMap.values()].sort((a, b) => b.total - a.total),
        topExpenses: [...exp].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 5),
        incomes: rows.filter((r) => r.direction === 'income').slice(0, 5),
        budgets: f.month ? budgetExecution(f.month) : [],
        prevExpense: 0, diffPct: null, pendingCount: 0,
      }
      narrative = await Promise.race([
        generateReportNarrative(sFull),
        new Promise((r) => setTimeout(() => r(''), 60000)),
      ])
    } catch (e) { narrative = '' }
  }
  // 省钱/升级建议：复用 recommend 模块（内部会联网比价，较慢，仅在显式勾选且指定月份时调用）
  if (blocks.budget && f.month && (q.suggest === '1' || q.suggest === 'true')) {
    try {
      alts = await Promise.race([
        analyzeBillForAlternatives(f.month).then((r) => r || []),
        new Promise((r) => setTimeout(() => r([]), 60000)), // 最多等 60 秒，超时则不附建议（不拖垮导出）
      ])
    } catch { alts = [] }
  }
  const budgets = blocks.budget && f.month ? budgetExecution(f.month) : []
  // 趋势基于「剔除后」的行计算，保证图表与统计口径一致
  const trendMap = new Map()
  for (const r of rows) {
    if (r.direction !== 'expense') continue
    const m = String(r.ts).slice(0, 7)
    trendMap.set(m, (trendMap.get(m) || 0) + Math.abs(Number(r.amount) || 0))
  }
  const trend = [...trendMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, expense]) => ({ month, expense }))
  const html = buildExportHtml({ rows, meta, blocks, narrative, alts, budgets, trend })
  const base = `PennyWise分析报告_${rangeLabel}${excluded.length ? '_已剔除' + excluded.length + '笔' : ''}`
  return { html, base, rows, excluded }
}

// ---- 导出偏好：排除规则 + 上次筛选，读写都走这个接口 ----
app.get('/api/export/prefs', (req, res) => {
  try { res.json({ ok: true, data: getExportPrefs() }) }
  catch (e) { fail(res, 500, 'prefs_error', String(e?.message || e).slice(0, 200)) }
})
app.post('/api/export/prefs', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    res.json({ ok: true, data: saveExportPrefs(body) })
  } catch (e) { fail(res, 500, 'prefs_error', String(e?.message || e).slice(0, 200)) }
})

// 商家清单：给排除规则的商家输入做候选提示
app.get('/api/export/merchants', (req, res) => {
  try {
    res.json({ ok: true, data: listMerchants({ q: req.query.q, limit: Number(req.query.limit) || 300 }) })
  } catch (e) { fail(res, 500, 'export_error', String(e?.message || e).slice(0, 200)) }
})

// 试算：给一组候选规则，返回各自命中多少笔、多少钱（前端编辑规则时实时反馈）
app.post('/api/export/test-exclude', (req, res) => {
  try {
    const rules = normalizeRules(req.body?.rules)
    const f = exportFilter(req.body || {})
    const raw = queryRows(f)
    const result = rules.map((r) => {
      const hit = raw.filter((row) => ruleMatches(r, row))
      return {
        id: r.id, label: ruleLabel(r), count: hit.length,
        amount: hit.reduce((s, x) => s + Math.abs(Number(x.amount) || 0), 0),
        sample: hit.slice(0, 3).map((x) => ({ ts: String(x.ts).slice(0, 10), merchant: x.merchant, amount: x.amount })),
      }
    })
    const keptN = raw.length - raw.filter((row) => rules.some((r) => ruleMatches(r, row))).length
    res.json({ ok: true, data: { total: raw.length, keptN, rules: result } })
  } catch (e) { fail(res, 500, 'export_error', String(e?.message || e).slice(0, 200)) }
})

// 精美分析 PDF 下载
app.get('/api/export/report.pdf', async (req, res) => {
  try {
    const { html, base } = await buildExportReport(req.query)
    const pdf = await htmlToPdf(html)
    res.set('Content-Type', 'application/pdf').set('Cache-Control', 'no-store')
    attachName(res, base, 'pdf')
    res.send(pdf)
  } catch (e) {
    if (e?.code === 'empty') return fail(res, 404, 'empty', String(e.message))
    fail(res, 500, 'export_error', String(e?.message || e).slice(0, 200))
  }
})

// ---- 商家维度月度汇总（钱花在哪个商家；含上月环比） ----
app.get('/api/merchants', (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : currentMonth()
  const prevMonth = (() => {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(y, m - 2, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })()
  const q = (m) => db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(merchant), ''), '（未记商户）') AS name, SUM(amount) AS total, COUNT(*) AS n
    FROM transactions WHERE ts LIKE ? AND status = 'confirmed' AND amount IS NOT NULL AND direction = 'expense'
    GROUP BY name ORDER BY total DESC LIMIT 60
  `).all(m + '%').map((r) => ({ name: r.name, total: Number(r.total), n: Number(r.n) }))
  const cur = q(month)
  const prev = q(prevMonth)
  const prevMap = new Map(prev.map((r) => [r.name, r]))
  res.json({
    ok: true,
    data: {
      month,
      prevMonth,
      merchants: cur.map((r) => ({ ...r, prev: prevMap.get(r.name)?.total || 0, prevN: prevMap.get(r.name)?.n || 0 })),
      curTotal: cur.reduce((a, b) => a + b.total, 0),
      prevTotal: prev.reduce((a, b) => a + b.total, 0),
    },
  })
})

// 分享入口兜底（无 Service Worker 的浏览器直接回到首页）
app.post('/share', (req, res) => res.redirect(303, '/'))

// ---- 静态 PWA ----
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }))

// ---- 统一错误处理 ----
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  fail(res, 500, 'server_error', String(err?.message || err).slice(0, 300))
})

const server = app.listen(PORT, '0.0.0.0', () => {
  // 就绪后再降到低于正常优先级：启动阶段保持 Normal 优先抢 CPU（冷启动更快），
  // 起完退到后台——45 天邮件重扫、LLM 解析等突发负载永远不抢前台应用的 CPU
  try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* 忽略 */ }
  try { fs.writeFileSync(path.join(DATA_DIR, 'server.pid'), String(process.pid)) } catch {}
  // 账单邮件自动导入：启动 15 秒首次执行，此后每 12 小时一次（只读白名单发件人）。
  // 防抖：导入会重扫近 45 天邮件（下载+解析+LLM），距上次尝试不足 6 小时的重启跳过补扫，
  // 否则"看门狗误判→重启→再扫一遍"的重启风暴会反复烧 CPU 和 LLM 调用。
  if (mailConfig().billsEnabled) {
    const lastAttempt = Number(db.prepare("SELECT v FROM meta WHERE k = 'last_import_attempt'").get()?.v || 0)
    if (Date.now() - lastAttempt > 6 * 3600 * 1000) {
      setTimeout(() => { runBillImport().catch(() => {}) }, 15000)
    }
    setInterval(() => { runBillImport().catch(() => {}) }, 12 * 3600 * 1000)
  }
  // 月度报告：每 30 分钟检查一次是否到发送时刻
  setInterval(() => { checkMonthlyReport().catch(() => {}) }, 30 * 60 * 1000)
  console.log('')
  console.log('  PennyWise 已启动')
  console.log(`  本机访问:   http://localhost:${PORT}`)
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  局域网访问: http://${n.address}:${PORT}`)
    }
  }
  console.log(`  手机接入:   推荐 Tailscale 获取 HTTPS（Windows 上执行: tailscale serve --bg ${PORT}），详见 README.md`)
  if (!AUTH_TOKEN) console.log('  ⚠ 未配置 AUTH_TOKEN，任何能访问此端口的人都能读写账本，请编辑 .env 设置')
  if (!llmConfig().enabled) console.log('  ⚠ 未配置 LLM_API_KEY，采集将进入手动确认模式，详见 README.md')
  console.log('')
})
// 端口被占（看门狗重复拉起 / 手动双开）→ 立即退出，绝不留"无端口僵尸"拖垮系统
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用（可能已有 PennyWise 在运行），本进程退出`)
    process.exit(1)
  }
  console.error('server error:', e)
})
