// 用法: node --test scripts/test-alipay-direction.mjs（使用临时账本）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dir-test-'))
process.env.PENNYWISE_DATA_DIR = tmp
process.env.PENNYWISE_ENV_FILE = path.join(tmp, '.env')
process.env.BILL_LLM_MERGE = '0'
process.env.BILL_LLM_CATEGORIZE = '0'
const { db } = await import('../server/db.js')
const { importBillFile, parseAlipayRows } = await import('../server/importer.js')
after(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const header = ['交易时间', '交易分类', '交易对方', '商品说明', '收/支', '金额', '交易状态', '交易订单号']
const time = '2026-11-16 12:03:11'
const row = (category, inOut, status = '交易成功') =>
  [time, category, '测试商家', '测试商品', inOut, '12.50', status, 'T1']

const cases = [
  ['餐饮美食', '不计收支', 'expense'],
  ['交通出行', '不计收支', 'expense'],
  ['账户存取', '支出', 'transfer'],
  ['账户存取', '收入', 'transfer'],
  ['信用借还', '不计收支', 'transfer'],
  ['退款', '收入', 'transfer'],
  ['转账红包', '收入', 'income'],
  ['转账红包', '不计收支', 'transfer'],
  ['日用百货', '支出', 'expense'],
  ['未知分类', '不计收支', 'transfer'],
  ['', '不计收支', 'transfer'],
  ['餐饮美食', '', 'transfer'],
  ['餐饮美食', '未知方向', 'transfer'],
]

for (const [category, inOut, expected] of cases) {
  test(`${category || '空分类'} / ${inOut || '空方向'} → ${expected}`, () => {
    const { rows, error } = parseAlipayRows([header, row(category, inOut)])
    assert.equal(error, undefined)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].direction, expected)
  })
}

test('交易关闭、失败或取消时跳过该行', () => {
  const invalid = ['交易关闭', '交易失败', '交易取消'].map(status => row('餐饮美食', '不计收支', status))
  assert.deepEqual(parseAlipayRows([header, ...invalid]).rows, [])
})

test('缺少交易分类的旧版电子回单保留原有收支判定', () => {
  const legacyHeader = ['交易号', '付款时间', '交易对方', '商品名称', '金额（元）', '收/支', '交易状态']
  const legacyRows = ['收入', '支出', '不计收支'].map((inOut, index) =>
    ['L' + index, time, '测试商家', '测试商品', '2.00', inOut, '交易成功'])
  assert.deepEqual(
    parseAlipayRows([legacyHeader, ...legacyRows]).rows.map(r => r.direction),
    ['income', 'expense', 'transfer'],
  )
})

test('上传支付宝 CSV 后，实际写入的方向正确，重复上传不重复入账', async () => {
  const rows = [
    header,
    [time, '餐饮美食', '测试餐厅', '午餐', '不计收支', '12.50', '交易成功', 'CSV1'],
    [time, '账户存取', '小荷包', '存入', '支出', '200.00', '交易成功', 'CSV2'],
    [time, '转账红包', '测试对方', '红包', '不计收支', '30.00', '交易成功', 'CSV3'],
  ]
  const csv = Buffer.from(rows.map(r => r.join(',')).join('\n'), 'utf8')
  const first = await importBillFile('支付宝账单.csv', csv)
  assert.equal(first.error, undefined)
  assert.equal(first.imported, 3)
  const saved = db.prepare('SELECT direction, amount, raw_text FROM transactions ORDER BY ext_id').all()
  assert.deepEqual(
    saved.map(r => [r.direction, r.amount]),
    [['expense', 12.5], ['transfer', 200], ['transfer', 30]],
  )
  assert.ok(saved[0].raw_text.endsWith(' | 餐饮美食'))
  const repeated = await importBillFile('支付宝账单.csv', csv)
  assert.equal(repeated.imported, 0)
  assert.equal(repeated.skipped, 3)
})
