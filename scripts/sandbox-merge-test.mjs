// ================= 沙箱合并测试：隔离数据目录，模块级直跑完整链路 =================
// 用法：node scripts/sandbox-merge-test.mjs [--llm]
//   默认纯程序流程（零 token）：种子手记 → 邮件导入(确定性直并) → 程序体检修复 → 账单核验
//   --llm：最后追加一次 AI 批量分类（诊断模型链报错用）
// 断言全部通过则退出码 0，任一失败退出码 1。
import fs from 'node:fs'
import path from 'node:path'

const DATA = path.join(process.cwd(), 'data', 'test-sandbox2')
const WITH_LLM = process.argv.includes('--llm')

// 1) 准备隔离目录（必须先于 import，env.js/db.js 启动时读取）
fs.rmSync(DATA, { recursive: true, force: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.PENNYWISE_DATA_DIR = DATA.split('\\').join('/')
process.env.AUTH_TOKEN = 'sandbox-tok'

const { db, newUid, nextRev, nowIso, validTs } = await import('../server/db.js')
const { importBills, mailConfig } = await import('../server/importer.js')
const { qualityCheck } = await import('../server/quality.js')
const { auditMonth } = await import('../server/audit.js')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}

// 2) 种子：5 笔"手记"（与 8 月支付宝账单行严格匹配）+ 1 对 60 秒内双击型重复（ts 差 5 秒）
function seed(tx) {
  db.prepare(`
    INSERT INTO transactions (uid, ts, created_at, amount, currency, direction, merchant, goods_name, category, account, raw_text, source, status, confidence, note, edited, rev, updated_at)
    VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, NULL, 'manual', 'confirmed', NULL, ?, 0, ?, ?)
  `).run(newUid(), tx.ts, nowIso(), tx.amount, tx.direction, tx.merchant, tx.goods_name || '', tx.category || null, tx.account || 'other', tx.note || '', nextRev(), nowIso())
}
const seeds = [
  { ts: '2026-08-19T10:13:35.000Z', amount: 78.3, direction: 'expense', merchant: '淘宝闪购', goods_name: '肯德基宅急送(晋江龙池路店)外卖订单', category: '餐饮', account: 'alipay', note: '手记测试' },
  { ts: '2026-08-08T13:09:01.000Z', amount: 69.5, direction: 'expense', merchant: 'jo**店', goods_name: 'John Jeff377美白祛斑精华液', category: '购物', account: 'alipay', note: '手记测试' },
  { ts: '2026-08-20T05:37:28.000Z', amount: 62.94, direction: 'expense', merchant: '深圳市立创电子商务有限公司', category: '购物', account: 'alipay', note: '手记测试' },
  { ts: '2026-08-18T13:10:29.000Z', amount: 39.8, direction: 'expense', merchant: '抖音生活服务商家', category: '餐饮', account: 'alipay', note: '手记测试' },
  { ts: '2026-08-03T12:28:28.000Z', amount: 313.92, direction: 'transfer', merchant: '花呗', goods_name: '花呗主动还款-2026年08月账单', account: 'alipay', note: '手记测试' },
  { ts: '2026-08-05T08:00:00.000Z', amount: 66.6, direction: 'expense', merchant: '测试双击重复A', category: '其他', note: '' },
  { ts: '2026-08-05T08:00:05.000Z', amount: 66.6, direction: 'expense', merchant: '测试双击重复A', category: '其他', note: '' },
]
for (const s of seeds) seed(s)
console.log(`\n【种子】已写入 ${seeds.length} 笔手记（5 笔待与账单合并 + 1 对 60 秒双击重复）`)

// 3) 邮件导入（真实 IMAP 拉取 → 解压 → 确定性直并 → LLM 审核模糊对 → 入库）
console.log('\n【邮件导入】真实拉取 163 邮箱账单…')
const t0 = Date.now()
const r = await importBills(mailConfig())
console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s：`, JSON.stringify({
  files: r.files, passwords: r.passwords, imported: r.imported, merged: r.merged,
  deterministic: r.deterministic, reviewedPairs: r.reviewedPairs, categorized: r.categorized, mergeError: r.mergeError || '',
}, null, 0))
ok(r.imported === 55, '新增 55 笔（60 行账单 - 5 笔直并）', `实际 ${r.imported}`)
ok(r.deterministic === 5, '程序确定性直并 5 笔（零 token）', `实际 ${r.deterministic}`)
ok(!r.mergeError, '无合并审核错误', r.mergeError || '')
ok(r.categorized >= 0, '导入期分类完成数', `实际 ${r.categorized}`)

// 4) 合并结果落库验证：手记应挂上账单单号，且不应有手记残留未合并
const mergedManual = db.prepare("SELECT COUNT(*) n FROM transactions WHERE note = '手记测试' AND ext_id LIKE 'ali-%'").get().n
ok(mergedManual === 5, '5 笔手记全部被合并并挂上账单单号', `实际 ${mergedManual}`)
const unmergedManual = db.prepare("SELECT COUNT(*) n FROM transactions WHERE note = '手记测试' AND (ext_id IS NULL OR ext_id = '')").get().n
ok(unmergedManual === 0, '无手记残留未合并', `残留 ${unmergedManual}`)
const billRows = db.prepare('SELECT outcome, COUNT(*) n FROM bill_rows GROUP BY outcome').all()
const inserted = billRows.find((b) => b.outcome === 'inserted')?.n || 0
const mergedRows = billRows.find((b) => b.outcome === 'merged')?.n || 0
ok(inserted === 55 && mergedRows === 5, `bill_rows 存证 inserted=55 / merged=5`, `实际 ${inserted}/${mergedRows}`)

// 5) 程序体检 + 修复（llm=0，必须秒回零 token）
console.log('\n【数据体检 · 纯程序】检查 + 安全修复…')
const t1 = Date.now()
const q = await qualityCheck({ apply: true, llm: false })
const qaMs = Date.now() - t1
ok(qaMs < 3000, `纯程序体检秒回（${qaMs}ms，无 LLM 调用）`)
ok(q.summary.dupExact === 0 && q.fixed.merged >= 1, `60 秒双击型重复被自动合并（fixed.merged=${q.fixed.merged}）`)
const remainA = db.prepare("SELECT COUNT(*) n FROM transactions WHERE merchant = '测试双击重复A'").get().n
ok(remainA === 1, '双击重复对修复后只剩 1 条', `实际 ${remainA}`)
ok(q.summary.missing === 0 && q.summary.formatErrors === 0 && q.summary.inconsistent === 0, '缺失/格式/不一致全部为 0')
console.log(`  体检摘要:`, JSON.stringify(q.summary), `| 修复:`, JSON.stringify(q.fixed))

// 6) 账单核验（bill_rows vs 账本，程序比对；账单文件里含 3 条 7/31 的真实交易，属 7 月，不进 8 月核验）
console.log('\n【账单核验】2026-08…')
const a = await auditMonth('2026-08')
const augRows = db.prepare("SELECT COUNT(*) n FROM bill_rows WHERE ts LIKE '2026-08%'").get().n
ok(a.summary.billRows === augRows, `8 月账单行 ${augRows} 条全部参与核验`, `实际 ${a.summary.billRows}`)
ok(a.summary.missing === 0 && a.summary.mismatch === 0, '无缺失、无金额/方向不符')
ok(a.summary.ok === augRows, `核验通过 ${augRows} 条（疑似重复对 ${a.summary.dupPairs} 对为逐日充值等正常情况，交人工/模型复核）`, `实际 ${a.summary.ok}`)

// 7) 可选：AI 批量分类（诊断模型链）
if (WITH_LLM) {
  console.log('\n【AI 批量分类】（--llm 已启用）…')
  const { classifyPending } = await import('../server/classify.js')
  const c = await classifyPending({ apply: true })
  console.log(`  scanned=${c.scanned} uniq=${c.uniq} batches=${c.batches} categorized=${c.categorized} updated=${c.updated} rules=${c.rules}`)
  if (c.errors.length) console.log('  ⚠ 模型链错误明细:', c.errors)
}

console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`)
process.exit(fail ? 1 : 0)
