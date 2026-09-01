import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from './env.js'

import { DEFAULT_CATEGORIES } from './categories.js'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'pennywise.db'))

db.exec('PRAGMA journal_mode = WAL;')
db.exec(`
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,
  ts TEXT NOT NULL,
  created_at TEXT NOT NULL,
  amount REAL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  direction TEXT NOT NULL DEFAULT 'expense',
  merchant TEXT NOT NULL DEFAULT '',
  category TEXT,
  account TEXT NOT NULL DEFAULT 'other',
  raw_text TEXT,
  raw_image TEXT,
  source TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'pending',
  confidence REAL,
  note TEXT NOT NULL DEFAULT '',
  edited INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_client ON transactions(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_ts ON transactions(ts);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE TABLE IF NOT EXISTS rules (
  merchant TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'expense'
);
CREATE TABLE IF NOT EXISTS budgets (
  month TEXT NOT NULL,
  category TEXT NOT NULL,
  limit_amount REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (month, category)
);
`)

// 播种默认分类
const seed = db.prepare('INSERT OR IGNORE INTO categories (name, kind) VALUES (?, ?)')
for (const kind of Object.keys(DEFAULT_CATEGORIES)) {
  for (const name of DEFAULT_CATEGORIES[kind]) seed.run(name, kind)
}

// 轻量迁移：goods_name 列（v2 视觉解析的商品名）
const cols = db.prepare('PRAGMA table_info(transactions)').all().map((r) => r.name)
if (!cols.includes('goods_name')) {
  db.exec("ALTER TABLE transactions ADD COLUMN goods_name TEXT NOT NULL DEFAULT ''")
}

// v3 双向同步：uid（全局唯一）/ updated_at（冲突裁决）/ rev（增量拉取）/ 墓碑与全局版本号
if (!cols.includes('uid')) db.exec('ALTER TABLE transactions ADD COLUMN uid TEXT')
if (!cols.includes('updated_at')) db.exec("ALTER TABLE transactions ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
if (!cols.includes('rev')) db.exec('ALTER TABLE transactions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0')
// v4 账单导入：外部交易单号去重（微信交易单号/支付宝交易号）
if (!cols.includes('ext_id')) db.exec('ALTER TABLE transactions ADD COLUMN ext_id TEXT')
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_uid ON transactions(uid) WHERE uid IS NOT NULL AND uid != '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_ext ON transactions(ext_id) WHERE ext_id IS NOT NULL AND ext_id != '';
CREATE TABLE IF NOT EXISTS tombstones (uid TEXT PRIMARY KEY, rev INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`)
// v5 账单核验：留存原始账单行（导入时的"呈堂证供"），供事后对账核验
db.exec(`
CREATE TABLE IF NOT EXISTS bill_rows (
  ext_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  amount REAL NOT NULL,
  direction TEXT NOT NULL,
  merchant TEXT NOT NULL DEFAULT '',
  goods_name TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'inserted',   -- merged / inserted
  match_tx_id INTEGER,                        -- 合并时挂到的账本记录 id
  match_tx_uid TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_ts ON bill_rows(ts);
`)
// 回填历史数据：分配 uid 与 rev，让存量账本可同步
let rev = Number(db.prepare("SELECT v FROM meta WHERE k='rev'").get()?.v ?? 0)
const orphans = db.prepare("SELECT id, ts FROM transactions WHERE uid IS NULL OR uid = '' OR rev = 0").all()
const backfill = db.prepare('UPDATE transactions SET uid = ?, updated_at = ?, rev = ? WHERE id = ?')
for (const r of orphans) {
  rev += 1
  backfill.run(crypto.randomUUID(), r.ts || new Date().toISOString(), rev, r.id)
}
if (rev > 0) db.prepare("INSERT INTO meta (k, v) VALUES ('rev', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(rev))

export function newUid() { return crypto.randomUUID() }
export function currentRev() { return Number(db.prepare("SELECT v FROM meta WHERE k='rev'").get()?.v ?? 0) }
export function nextRev() {
  const n = currentRev() + 1
  db.prepare("INSERT INTO meta (k, v) VALUES ('rev', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(n))
  return n
}
export function bumpTx(id) {
  const rev2 = nextRev()
  db.prepare('UPDATE transactions SET rev = ?, updated_at = ? WHERE id = ?').run(rev2, nowIso(), id)
  return rev2
}
// 同步用字段白名单（不暴露服务器内部 id/rev）
export function txToSync(r) {
  return {
    ts: r.ts, amount: r.amount, currency: r.currency, direction: r.direction,
    merchant: r.merchant, goods_name: r.goods_name, category: r.category,
    account: r.account, raw_text: r.raw_text, raw_image: r.raw_image,
    source: r.source, status: r.status, confidence: r.confidence, note: r.note,
    client_id: r.client_id, created_at: r.created_at, updated_at: r.updated_at,
  }
}

export function getCategories() {
  const rows = db.prepare('SELECT name, kind FROM categories ORDER BY rowid').all()
  const out = { expense: [], income: [] }
  for (const r of rows) {
    const k = r.kind === 'income' ? 'income' : 'expense'
    if (!out[k].includes(r.name)) out[k].push(r.name)
  }
  for (const k of Object.keys(DEFAULT_CATEGORIES)) {
    for (const n of DEFAULT_CATEGORIES[k]) if (!out[k].includes(n)) out[k].push(n)
  }
  return out
}

export function normalizeCategory(cat, direction = 'expense') {
  const list = getCategories()[direction === 'income' ? 'income' : 'expense']
  const c = typeof cat === 'string' ? cat.trim() : ''
  if (!c) return null
  if (list.includes(c)) return c
  return list.includes('其他') ? '其他' : (list[0] || '其他')
}

export function ruleFor(merchant) {
  if (!merchant) return null
  return db.prepare('SELECT category, hits FROM rules WHERE merchant = ?').get(merchant) ?? null
}

export function upsertRule(merchant, category) {
  if (!merchant || !category) return
  db.prepare(`
    INSERT INTO rules (merchant, category, hits) VALUES (?, ?, 1)
    ON CONFLICT(merchant) DO UPDATE SET category = excluded.category, hits = hits + 1
  `).run(merchant, category)
}

export function nowIso() {
  return new Date().toISOString()
}

export function validTs(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null
  const d = Date.parse(v)
  return Number.isNaN(d) ? null : new Date(d).toISOString()
}

export function getTx(id) {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(id))
}

export function currentMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
