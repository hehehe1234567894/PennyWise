import fs from 'node:fs'
import path from 'node:path'
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
