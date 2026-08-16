import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import QRCode from 'qrcode'
import { env, writeEnv, DATA_DIR, PUBLIC_DIR } from './env.js'
import { db, getCategories, normalizeCategory, ruleFor, upsertRule, nowIso, validTs, getTx, currentMonth, newUid, currentRev, nextRev, bumpTx, txToSync } from './db.js'
import { parseImage, llmConfig, visionConfig, getModelStatus, noteModelResult } from './llm.js'
import { mailConfig, importBills, importBillRows, parseWechatCsv, parseAlipayCsv, parseBankCsv } from './importer.js'
import { pollMailCapture } from './mailin.js'
import { mailerConfig, serverChanKey, summarizeMonth, buildReportText, buildReportHtml, sendMonthlyReport, generateReportNarrative } from './reporter.js'
import { analyzeBillForAlternatives } from './recommend.js'
import { shortcutFile } from './shortcut.js'
import { detectImage, saveImage, autoConfirmFrom, captureTextCore, captureImageCore } from './capture-core.js'
import { DIRECTIONS, ACCOUNTS, DEFAULT_CATEGORIES } from './categories.js'

const PORT = Number(env('PORT', '8720')) || 8720
const AUTH_TOKEN = env('AUTH_TOKEN', '')

// 自动入账阈值：解析置信度 ≥ 阈值 → 直接入账，无需确认；1 = 全部手动确认
function autoConfirmAt() {
  return autoConfirmFrom(env('AUTO_CONFIRM', '0.9'))
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '16mb' }))

// ---- 安全响应头 ----
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'DENY')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src *; object-src 'none'; base-uri 'self'")
  next()
})

// ---- CORS：允许任何来源调用 API（安全性由 AUTH_TOKEN 保证）。
// 手机端"连接检测"需要跨地址探测（如从 Tailscale 域名探测局域网 IP）。
// 必须在鉴权之前挂载，让 OPTIONS 预检直接返回 204。 ----
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.get('origin') || '*')
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type,X-Auth-Token')
  res.set('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ---- 鉴权：/api 下公开端点除外，本机直连（localhost）免令牌，其余要求 X-Auth-Token ----
const isLoop = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
const PUBLIC_API = ['/config', '/health', '/reachability', '/qr']
app.use('/api', (req, res, next) => {
  if (!AUTH_TOKEN) return next()
  if (PUBLIC_API.includes(req.path)) return next()
  // 本机直连（在本机浏览器打开）免令牌：设置/二维码流程零输入
  const xff = (req.get('x-forwarded-for') || '').split(',')[0].trim()
  if (isLoop(req.ip) && (!xff || isLoop(xff))) return next()
  if (req.get('x-auth-token') === AUTH_TOKEN) return next()
  return res.status(401).json({ ok: false, code: 'auth', error: '访问令牌无效，请在设置中填写 AUTH_TOKEN' })
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
    mailCapture: { ...mailCaptureStatus, enabled: mailCaptureStatus.enabled || (mailConfig().imapConfigured && env('MAIL_CAPTURE', '0') === '1') },
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

// 可达性自报：手机端"连接检测"据此探测哪个地址可用（公开，无需 token）
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

// 手机配对信息（含令牌）：仅供本机页面调用，用于生成"扫码即连"二维码
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

// ---- 采集：文本 → LLM 解析 → 待确认（或高置信度自动入账） ----
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

// ---- 银行短信自动记账（iOS 快捷指令「收到短信」自动化调用，0 点击） ----
app.post('/api/sms', express.text({ type: () => true, limit: '50kb' }), async (req, res) => {
  const text = String(req.body || '').trim()
  if (!text) return fail(res, 400, 'bad_request', '短信内容为空')
  const r = await captureTextCore(text, null, 'sms', autoConfirmAt())
  // 解析不出金额的（验证码/通知类短信）静默丢弃，不产生垃圾记录
  if (r.parse.code !== 'ok' || r.transaction.amount == null) {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(r.transaction.id)
    return res.json({ ok: true, data: { skipped: true, reason: '非交易短信' } })
  }
  res.json({ ok: true, data: { skipped: false, transaction: r.transaction } })
})

// ---- 账单导入（微信/支付宝/银行 CSV，邮箱自动收取或手动上传） ----
const billStatus = { enabled: false, lastRun: null, imported: 0, skipped: 0, merged: 0, reviewedPairs: 0, categorized: 0, passwords: 0, error: '' }
async function runBillImport() {
  billStatus.enabled = mailConfig().billsEnabled
  try {
    const r = await importBills(mailConfig())
    billStatus.lastRun = nowIso()
    billStatus.imported = r.imported
    billStatus.skipped = r.skipped
    billStatus.merged = r.merged || 0
    billStatus.reviewedPairs = r.reviewedPairs || 0
    billStatus.categorized = r.categorized || 0
    billStatus.passwords = r.passwords || 0
    billStatus.error = r.error || ''
    // 记录最近一次成功收到账单的时间（月报用它判断是否需要提醒）
    if (!r.error && r.files > 0) {
      db.prepare("INSERT INTO meta (k, v) VALUES ('last_bill_import', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(nowIso())
    }
    return r
  } catch (e) {
    billStatus.lastRun = nowIso()
    billStatus.error = String(e?.message || e).slice(0, 200)
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

// ---- 邮箱沟通 AI Agent（只读"自己发的、主题为 PW"的邮件，自动处理并回信） ----
const mailCaptureStatus = { enabled: false, lastRun: null, processed: 0, error: '' }
async function runMailCapture() {
  mailCaptureStatus.enabled = mailConfig().imapConfigured && env('MAIL_CAPTURE', '0') === '1'
  try {
    const r = await pollMailCapture(mailConfig(), autoConfirmAt())
    mailCaptureStatus.lastRun = nowIso()
    mailCaptureStatus.processed = r.processed
    mailCaptureStatus.error = r.error || ''
    return r
  } catch (e) {
    mailCaptureStatus.lastRun = nowIso()
    mailCaptureStatus.error = String(e?.message || e).slice(0, 200)
    return { processed: 0, error: mailCaptureStatus.error }
  }
}
app.post('/api/mail-capture', async (req, res) => {
  if (!(mailConfig().imapConfigured && env('MAIL_CAPTURE', '0') === '1')) {
    return fail(res, 400, 'not_configured', '未开启邮箱沟通（.env 里 MAIL_CAPTURE=1），见 README')
  }
  res.json({ ok: true, data: await runMailCapture() })
})

// ---- 预算（借鉴 Firefly/Actual：月度分类限额 + 进度跟踪） ----
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
app.get('/api/report/preview', async (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : currentMonth()
  const s = summarizeMonth(month)
  const narrative = await generateReportNarrative(s)
  const alts = await analyzeBillForAlternatives(month)
  res.json({ ok: true, data: { text: buildReportText(s, narrative, alts), html: buildReportHtml(s, narrative, alts), narrative, alts, channels: { email: mailerConfig().enabled, serverchan: Boolean(serverChanKey()) } } })
})

app.post('/api/report', async (req, res) => {
  const month = typeof req.body?.month === 'string' && /^\d{4}-\d{2}$/.test(req.body.month) ? req.body.month : currentMonth()
  if (!mailerConfig().enabled && !serverChanKey()) {
    return fail(res, 400, 'not_configured', '未配置任何发送渠道（SMTP_* 或 SERVERCHAN_KEY），见 README「月报提醒」')
  }
  const r = await sendMonthlyReport(month)
  res.json({ ok: true, data: { month, channels: r.channels } })
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
}

// ---- iOS 快捷指令下载（银行短信自动记账） ----
app.get('/shortcut', (req, res) => {
  const { lan, tailscale } = scanInterfaces()
  const tsName = env('TAILSCALE_NAME', '').replace(/\/+$/, '')
  const base = tsName ? `https://${tsName}` : tailscale[0] ? `http://${tailscale[0].ip}:${PORT}` : lan[0] ? `http://${lan[0].ip}:${PORT}` : `http://localhost:${PORT}`
  const buf = shortcutFile(base, AUTH_TOKEN)
  res.set('Content-Type', 'application/octet-stream')
  res.set('Content-Disposition', 'attachment; filename="PennyWise-SMS.shortcut"')
  res.set('Cache-Control', 'no-store')
  res.send(buf)
})

// ---- 采集：支付截图 → 视觉模型解析 → 待确认 ----
// 支持两种形式：JSON base64（网页端）/ 原始图片字节（iOS 快捷指令等）
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

// 已保存的截图（随机文件名即访问凭证；配合 token 鉴权场景外的 <img> 使用）
app.get('/api/image/:name', (req, res) => {
  const name = String(req.params.name || '').replace(/[^a-zA-Z0-9._-]/g, '')
  const file = path.join(DATA_DIR, 'images', name)
  if (!name || !fs.existsSync(file)) return fail(res, 404, 'not_found', '图片不存在')
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' }[path.extname(name).toLowerCase()] || 'image/jpeg'
  res.set('Cache-Control', 'private, max-age=31536000').set('Content-Type', mime).send(fs.readFileSync(file))
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

// 分享入口兜底（无 Service Worker 的浏览器直接回到首页）
app.post('/share', (req, res) => res.redirect(303, '/'))

// ---- 静态 PWA ----
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }))

// ---- 统一错误处理 ----
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  fail(res, 500, 'server_error', String(err?.message || err).slice(0, 300))
})

app.listen(PORT, '0.0.0.0', () => {
  try { fs.writeFileSync(path.join(DATA_DIR, 'server.pid'), String(process.pid)) } catch {}
  // 账单邮件自动导入：配置后启动 15 秒首次执行，此后每 12 小时一次（只读白名单发件人）
  if (mailConfig().billsEnabled) {
    setTimeout(() => { runBillImport().catch(() => {}) }, 15000)
    setInterval(() => { runBillImport().catch(() => {}) }, 12 * 3600 * 1000)
  }
  // 邮箱沟通 AI Agent：配置后每 3 分钟检查一次"自己发的、主题 PW"的邮件
  if (mailConfig().imapConfigured && env('MAIL_CAPTURE', '0') === '1') {
    setTimeout(() => { runMailCapture().catch(() => {}) }, 10000)
    setInterval(() => { runMailCapture().catch(() => {}) }, 3 * 60 * 1000)
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
