// 单元测试：支付宝账单的收支方向判定
// 用法: node scripts/test-alipay-direction.mjs（不碰真实账本，纯函数测试）
// 覆盖三个曾经的坑：
//  ① 「不计收支」+ 真实消费分类（小荷包余额付款的食堂/交通）以前被当 transfer 丢掉
//  ② 「支出/收入」+ 账户存取（小荷包/余额宝存取）以前被算成真实收支，月度报表虚高
//  ③ 交易关闭的行不能入账
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.PENNYWISE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dir-test-'))
const { parseAlipayRows } = await import('../server/importer.js')

const header = ['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支', '金额',
  '收/付款方式', '交易状态', '交易订单号', '商家订单号', '备注', '']
const row = (time, cat, peer, goods, inout, amt, status, txn) =>
  [time, cat, peer, '', goods, inout, String(amt), '小荷包', status, txn, '', '', '']

const rows = [
  header,
  row('2026-11-16 12:03:11', '餐饮美食', '厦门理工第一食堂', '午餐', '不计收支', 12.5, '交易成功', 'T1'),
  row('2026-11-15 08:40:00', '交通出行', '厦门地铁', '乘车码', '不计收支', 4, '交易成功', 'T2'),
  row('2026-11-13 20:11:02', '账户存取', '支付宝小荷包(生活费)', '转出到生活费', '支出', 200, '交易成功', 'T3'),
  row('2026-11-13 20:11:01', '账户存取', '支付宝小荷包(总金)', '从总金转入', '收入', 200, '交易成功', 'T4'),
  row('2026-11-12 09:00:00', '信用借还', '花呗', '还款', '不计收支', 88.8, '交易成功', 'T5'),
  row('2026-11-10 21:30:00', '转账红包', '老妈', '收到红包', '收入', 12, '交易成功', 'T6'),
  row('2026-11-09 19:00:00', '餐饮美食', '奶茶店', '奶茶（已退款）', '不计收支', 15, '交易关闭', 'T7'),
  row('2026-11-08 10:00:00', '日用百货', '超市', '纸巾', '支出', 23.4, '交易成功', 'T8'),
]

const { rows: out, error } = parseAlipayRows(rows)
let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name} ${detail}`) }
}
const dirOf = (txn) => out.find((r) => r.ext_id === 'ali-' + txn)?.direction

check('解析无错误', !error, error || '')
check('总共 7 条入账（交易关闭的 T7 被跳过）', out.length === 7, `实际 ${out.length}`)
check('① 不计收支 + 餐饮美食 → expense（真实消费不再丢）', dirOf('T1') === 'expense', dirOf('T1'))
check('① 不计收支 + 交通出行 → expense', dirOf('T2') === 'expense', dirOf('T2'))
check('② 支出 + 账户存取 → transfer（小荷包转出不算支出）', dirOf('T3') === 'transfer', dirOf('T3'))
check('② 收入 + 账户存取 → transfer（小荷包转入不算收入）', dirOf('T4') === 'transfer', dirOf('T4'))
check('信用借还 → transfer（还花呗不算支出）', dirOf('T5') === 'transfer', dirOf('T5'))
check('收入 + 转账红包 → income（收红包仍算收入）', dirOf('T6') === 'income', dirOf('T6'))
check('③ 交易关闭 → 不入账', dirOf('T7') === undefined)
check('普通支出仍为 expense', dirOf('T8') === 'expense', dirOf('T8'))
const expense = out.filter((r) => r.direction === 'expense').reduce((s, r) => s + r.amount, 0)
check('支出合计 = 12.5 + 4 + 23.4 = 39.9', Math.abs(expense - 39.9) < 0.001, String(expense))

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
