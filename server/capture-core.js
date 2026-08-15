import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR } from './env.js'
import { db, ruleFor, nowIso, getTx, newUid, nextRev } from './db.js'
import { parseCapture, parseImage } from './llm.js'

// ================= 采集核心（文本/图片 → 解析 → 规则记忆 → 自动入账） =================
// 供 /api/capture、/api/capture-image、/api/sms、邮箱记账共用

const IMAGE_DIR = path.join(DATA_DIR, 'images')
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp' }

export function detectImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return null
}

export function saveImage(buf, mime) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
  const ext = IMAGE_EXT[mime] || 'jpg'
  const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`
  fs.writeFileSync(path.join(IMAGE_DIR, name), buf)
  return name // 相对文件名；通过 /api/image/:name 访问（随机名即访问凭证）
}

export function autoConfirmFrom(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.9
}

export async function captureTextCore(text, clientId, sourceLabel, threshold) {
  const raw = text.trim().slice(0, 4000)
  const result = await parseCapture(raw)
  let fields = {
    ts: nowIso(), amount: null, direction: 'expense', merchant: '',
    goods_name: '', category: null, account: 'other', note: '', confidence: null,
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

  // 自动入账：解析成功且置信度达标 → 直接确认
  const status = (parse.code === 'ok' && fields.amount != null && fields.confidence != null && fields.confidence >= threshold) ? 'confirmed' : 'pending'

  const info = db.prepare(`
    INSERT INTO transactions (uid, client_id, ts, created_at, amount, currency, direction, merchant, goods_name, category, account, raw_text, raw_image, source, status, confidence, note, edited, rev, updated_at)
    VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    newUid(), clientId, fields.ts, nowIso(), fields.amount, fields.direction, fields.merchant, fields.goods_name,
    fields.direction === 'expense' ? (fields.category || '其他') : null,
    fields.account, raw, null, sourceLabel, status, fields.confidence, fields.note, nextRev(), nowIso(),
  )
  return { transaction: getTx(info.lastInsertRowid), parse }
}

export async function captureImageCore(buf, mime, clientId, sourceLabel, threshold) {
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
    parse = { code: 'ok', confidence: d.confidence, model: result.model || '' }
    fields = { ...fields, ts: d.ts || fields.ts, amount: d.amount, direction: d.direction, merchant: d.merchant, goods_name: d.goods_name, category: d.category, account: d.account, confidence: d.confidence, raw_text: d.raw_text }
  } else {
    parse = { code: result.code, error: result.error || '' }
  }

  if (fields.merchant && fields.direction === 'expense') {
    const rule = ruleFor(fields.merchant)
    if (rule) {
      fields.category = rule.category
      if (typeof parse.confidence === 'number') parse.confidence = Math.min(1, parse.confidence + 0.1)
    }
  }

  const status = (parse.code === 'ok' && fields.amount != null && fields.confidence != null && fields.confidence >= threshold) ? 'confirmed' : 'pending'

  const info = db.prepare(`
    INSERT INTO transactions (uid, client_id, ts, created_at, amount, currency, direction, merchant, goods_name, category, account, raw_text, raw_image, source, status, confidence, note, edited, rev, updated_at)
    VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    newUid(), clientId, fields.ts, nowIso(), fields.amount, fields.direction, fields.merchant, fields.goods_name,
    fields.direction === 'expense' ? (fields.category || '其他') : null,
    fields.account, fields.raw_text, fields.raw_image, sourceLabel, status, fields.confidence, fields.note, nextRev(), nowIso(),
  )
  return { transaction: getTx(info.lastInsertRowid), parse, file }
}
