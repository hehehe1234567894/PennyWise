import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import QRCode from 'qrcode'
import { env, writeEnv, DATA_DIR, PUBLIC_DIR } from './env.js'
import { db, getCategories, normalizeCategory, ruleFor, upsertRule, nowIso, validTs, getTx, currentMonth } from './db.js'
import { parseCapture, parseImage, llmConfig, visionConfig } from './llm.js'
import { DIRECTIONS, ACCOUNTS, DEFAULT_CATEGORIES } from './categories.js'

const PORT = Number(env('PORT', '8720')) || 8720
const AUTH_TOKEN = env('AUTH_TOKEN', '')

const IMAGE_DIR = path.join(DATA_DIR, 'images')
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp' }

function detectImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return null
}

function saveImage(buf, mime) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
  const ext = IMAGE_EXT[mime] || 'jpg'
  const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`
  fs.writeFileSync(path.join(IMAGE_DIR, name), buf)
  return name // 相对文件名；通过 /api/image/:name 访问（随机名即访问凭证）
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '16mb' }))

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
  res.json({ ok: true, time: nowIso(), hasLLM: llmConfig().enabled, model: llmConfig().model, hasVision: visionConfig().enabled, visionModel: visionConfig().model })
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
    changes.llmConfigured = Boolean(key)
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

// ---- 采集：文本 → LLM 解析 → 待确认 ----
app.post('/api/capture', async (req, res) => {
  const { text, ts, client_id: cid } = req.body || {}
  if (typeof text !== 'string' || !text.trim()) return fail(res, 400, 'bad_request', 'text 不能为空')
  const clientId = cid ? String(cid).slice(0, 64) : null

  // 幂等：离线队列重试时不会重复入库
  if (clientId) {
    const exist = db.prepare('SELECT * FROM transactions WHERE client_id = ?').get(clientId)
    if (exist) return res.json({ ok: true, data: { transaction: exist, parse: { code: 'duplicate' } } })
  }

  const raw = text.trim().slice(0, 4000)
  const result = await parseCapture(raw)
  let fields = {
    ts: validTs(ts) || nowIso(), amount: null, direction: 'expense', merchant: '',
    category: null, account: 'other', note: '', confidence: null,
  }
  let parse = { code: 'no_key' }

  if (result.ok) {
    const d = result.data
    parse = { code: 'ok', confidence: d.confidence }
    fields = { ...fields, ts: d.ts || fields.ts, amount: d.amount, direction: d.direction, merchant: d.merchant, category: d.category, account: d.account, note: d.note, confidence: d.confidence }
  } else {
    parse = { code: result.code, error: result.error || '' }
  }

  // 规则记忆：同一商户自动套用历史分类并提高置信度
  if (fields.merchant && fields.direction === 'expense') {
    const rule = ruleFor(fields.merchant)
    if (rule) {
      fields.category = rule.category
      if (typeof parse.confidence === 'number') parse.confidence = Math.min(1, parse.confidence + 0.1)
    }
  }

  const info = db.prepare(`
    INSERT INTO transactions (client_id, ts, created_at, amount, currency, direction, merchant, category, account, raw_text, source, status, confidence, note, edited)
    VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, 'text', 'pending', ?, ?, 0)
  `).run(
    clientId, fields.ts, nowIso(), fields.amount, fields.direction, fields.merchant,
    fields.direction === 'expense' ? (fields.category || '其他') : null,
    fields.account, raw, fields.confidence, fields.note,
  )

  res.status(201).json({ ok: true, data: { transaction: getTx(info.lastInsertRowid), parse } })
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

  const file = saveImage(buf, mime)
  const result = await parseImage(buf, mime)
  let fields = {
    ts: nowIso(), amount: null, direction: 'expense', merchant: '',
    goods_name: '', category: null, account: 'other', note: '', confidence: null,
    raw_text: '', raw_image: file,
  }
  let parse = { code: 'no_key' }
  if (result.ok) {
    const d = result.data
    parse = { code: 'ok', confidence: d.confidence }
    fields = { ...fields, ts: d.ts || fields.ts, amount: d.amount, direction: d.direction, merchant: d.merchant, goods_name: d.goods_name, category: d.category, account: d.account, confidence: d.confidence, raw_text: d.raw_text }
  } else {
    parse = { code: result.code, error: result.error || '' }
  }

  // 规则记忆：同一商户自动套用历史分类
  if (fields.merchant && fields.direction === 'expense') {
    const rule = ruleFor(fields.merchant)
    if (rule) {
      fields.category = rule.category
      if (typeof parse.confidence === 'number') parse.confidence = Math.min(1, parse.confidence + 0.1)
    }
  }

  const info = db.prepare(`
    INSERT INTO transactions (client_id, ts, created_at, amount, currency, direction, merchant, goods_name, category, account, raw_text, raw_image, source, status, confidence, note, edited)
    VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, 'image', 'pending', ?, ?, 0)
  `).run(
    clientId, fields.ts, nowIso(), fields.amount, fields.direction, fields.merchant, fields.goods_name,
    fields.direction === 'expense' ? (fields.category || '其他') : null,
    fields.account, fields.raw_text, fields.raw_image, fields.confidence, fields.note,
  )

  res.status(201).json({ ok: true, data: { transaction: getTx(info.lastInsertRowid), parse } })
})

// 已保存的截图（随机文件名即访问凭证；配合 token 鉴权场景外的 <img> 使用）
app.get('/api/image/:name', (req, res) => {
  const name = String(req.params.name || '').replace(/[^a-zA-Z0-9._-]/g, '')
  const file = path.join(IMAGE_DIR, name)
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
    INSERT INTO transactions (ts, created_at, amount, currency, direction, merchant, goods_name, category, account, raw_text, source, status, note, edited)
    VALUES (?, ?, ?, 'CNY', ?, ?, ?, ?, ?, NULL, 'manual', 'confirmed', ?, 0)
  `).run(ts, nowIso(), Math.round(amount * 100) / 100, direction, merchant, goodsName, category, account, note)
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
  res.json({ ok: true, data: getTx(tx.id) })
})

app.delete('/api/transactions/:id', (req, res) => {
  const tx = getTx(req.params.id)
  if (!tx) return fail(res, 404, 'not_found', '记录不存在')
  db.prepare('DELETE FROM transactions WHERE id = ?').run(tx.id)
  res.json({ ok: true, data: { deleted: tx.id } })
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

// ---- 静态 PWA ----
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }))

// ---- 统一错误处理 ----
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  fail(res, 500, 'server_error', String(err?.message || err).slice(0, 300))
})

app.listen(PORT, '0.0.0.0', () => {
  try { fs.writeFileSync(path.join(DATA_DIR, 'server.pid'), String(process.pid)) } catch {}
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
