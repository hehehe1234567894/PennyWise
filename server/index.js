import os from 'node:os'
import express from 'express'
import { env, PUBLIC_DIR } from './env.js'
import { db, getCategories, normalizeCategory, ruleFor, upsertRule, nowIso, validTs, getTx, currentMonth } from './db.js'
import { parseCapture, llmConfig } from './llm.js'
import { DIRECTIONS, ACCOUNTS } from './categories.js'

const PORT = Number(env('PORT', '8720')) || 8720
const AUTH_TOKEN = env('AUTH_TOKEN', '')

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))

// ---- 鉴权：/api 下除 config/health 外都要求 X-Auth-Token ----
app.use('/api', (req, res, next) => {
  if (!AUTH_TOKEN) return next()
  if (req.path === '/config' || req.path === '/health') return next()
  if (req.get('x-auth-token') === AUTH_TOKEN) return next()
  return res.status(401).json({ ok: false, code: 'auth', error: '访问令牌无效，请在设置中填写 AUTH_TOKEN' })
})

const fail = (res, status, code, error) => res.status(status).json({ ok: false, code, error })

// ---- 基本信息 ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: nowIso(), hasLLM: llmConfig().enabled, model: llmConfig().model })
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

// ---- 手动创建（直接确认入账） ----
app.post('/api/transactions', (req, res) => {
  const b = req.body || {}
  const amount = Number(b.amount)
  if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, 'bad_request', '金额必须为正数')
  const direction = DIRECTIONS.includes(b.direction) ? b.direction : 'expense'
  const merchant = typeof b.merchant === 'string' ? b.merchant.trim().slice(0, 120) : ''
  const category = direction === 'expense' ? normalizeCategory(b.category) || '其他' : null
  const account = ACCOUNTS.includes(b.account) ? b.account : 'other'
  const ts = validTs(b.ts) || nowIso()
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : ''
  const info = db.prepare(`
    INSERT INTO transactions (ts, created_at, amount, currency, direction, merchant, category, account, raw_text, source, status, note, edited)
    VALUES (?, ?, ?, 'CNY', ?, ?, ?, ?, NULL, 'manual', 'confirmed', ?, 0)
  `).run(ts, nowIso(), Math.round(amount * 100) / 100, direction, merchant, category, account, note)
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
  const category = direction === 'expense' ? normalizeCategory(o.category ?? tx.category) || '其他' : null
  const account = ACCOUNTS.includes(o.account ?? tx.account) ? (o.account ?? tx.account) : tx.account
  const ts = validTs(o.ts) || tx.ts
  const note = o.note !== undefined ? String(o.note).trim().slice(0, 200) : (tx.note || '')
  db.prepare(`
    UPDATE transactions SET ts = ?, amount = ?, direction = ?, merchant = ?, category = ?, account = ?, note = ?, status = 'confirmed', edited = edited + 1
    WHERE id = ?
  `).run(ts, Math.round(amount * 100) / 100, direction, merchant, category, account, note, tx.id)
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
