// 集成测试：账单合并（隔离临时数据库 + 真 LLM 审核）
// 用法: node scripts/test-merge.mjs
// 验证：①匹配的账单行合并到既有手记（ext_id 挂上）②同一条已有记录不会被两条账单行挤占（第二条必须新增入库）
// ③全程无数据丢失。不触碰真实账本（PENNYWISE_DATA_DIR 指向临时目录）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-merge-test-'))
process.env.PENNYWISE_DATA_DIR = tmp
process.env.PENNYWISE_ENV_FILE = path.join(root, '.env')
const { db, newUid } = await import('../server/db.js')
const { reconcileAndImport } = await import('../server/importer.js')

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name} ${detail}`) }
}

// 场景：一本手记（AI 助手记的奶茶），账单里来了两行同金额相邻时间的行（应合并 1 条 + 新增 1 条）+ 1 行全新交易
const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()
db.prepare(`INSERT INTO transactions (uid, ext_id, ts, created_at, amount, currency, direction, merchant, goods_name, category, account, raw_text, source, status, confidence, note, edited, rev, updated_at)
  VALUES (?,?,?,?,?,'CNY',?,?,?,?,?,?,'chat','confirmed',0.9,'',0,1,?)`)
  .run(newUid(), null, iso(now - 3600e3), iso(now - 3600e3), 18.5, 'expense', '蜜雪冰城', '珍珠奶茶', '餐饮', 'wechat', '手记：蜜雪冰城 18.5', iso(now - 3600e3))

const rows = [
  { ext_id: 'WX_T1', ts: iso(now - 1800e3), amount: 18.5, direction: 'expense', merchant: '蜜雪冰城', goods_name: '珍珠奶茶', account: 'wechat', raw_text: '账单行1', note: '' },
  { ext_id: 'WX_T2', ts: iso(now - 900e3), amount: 18.5, direction: 'expense', merchant: '蜜雪冰城', goods_name: '珍珠奶茶(第二杯)', account: 'wechat', raw_text: '账单行2', note: '' },
  { ext_id: 'WX_T3', ts: iso(now - 600e3), amount: 66.0, direction: 'expense', merchant: '老王烧烤', goods_name: '烧烤套餐', account: 'alipay', raw_text: '账单行3', note: '' },
]

const before = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n
const rec = await reconcileAndImport(rows)
const after = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n

check('只新增 2 行（合并 1 行不重复入库）', after - before === 2, `Δ=${after - before}`)
check('merged = 1', rec.merged === 1, `merged=${rec.merged}`)
check('imported = 2', rec.imported === 2, `imported=${rec.imported}`)
check('无合并错误', !rec.mergeError, `mergeError=${rec.mergeError || '无'}`)
const manual = db.prepare("SELECT ext_id FROM transactions WHERE source = 'chat'").get()
check('手记被挂上账单单号', !!manual?.ext_id, `ext_id=${manual?.ext_id}`)
const total = db.prepare('SELECT SUM(amount) AS s FROM transactions WHERE direction = \'expense\'').get().s
check('金额无丢失（= 18.5×2 + 66）', Math.abs(total - 103) < 0.01, `sum=${total}`)
const exts = db.prepare('SELECT ext_id, COUNT(*) AS n FROM transactions WHERE ext_id IS NOT NULL GROUP BY ext_id HAVING n > 1').all()
check('账单单号无重复挂载', exts.length === 0, JSON.stringify(exts))

console.log(`\n结果: ${pass} passed, ${fail} failed  (临时库: ${tmp})`)
try { db.close() } catch { /* 已关闭 */ }
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }) } catch (e) { console.log(`提示: 临时目录稍后由系统清理 (${String(e?.message || e).slice(0, 60)})`) }
process.exit(fail ? 1 : 0)
