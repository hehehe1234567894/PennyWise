import { env } from './env.js'
import { db, ruleFor, nowIso, validTs, newUid, nextRev } from './db.js'
import { ImapFlow } from 'imapflow'

// ================= 账单导入（微信/支付宝 CSV + 邮箱自动收取） =================

export function mailConfig() {
  return {
    enabled: env('AUTO_IMPORT', '0') === '1' && Boolean(env('MAIL_USER')) && Boolean(env('MAIL_PASS')),
    host: env('MAIL_IMAP_HOST', ''),
    port: Number(env('MAIL_IMAP_PORT', '993')) || 993,
    user: env('MAIL_USER', ''),
    pass: env('MAIL_PASS', ''),
    box: env('MAIL_BOX', 'INBOX'),
    fromFilter: env('MAIL_FROM', '微信支付|支付宝|alipay|wechatpay'),
  }
}

// 简易 RFC4180 CSV 解析（支持引号转义），并去掉 BOM
export function parseCsv(text) {
  const t = String(text).replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let inQ = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''))
}

function csvTime(v) {
  const s = String(v || '').trim()
  if (!s) return null
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?$/)
  if (!m) return null
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0))
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString()
}

// 微信支付账单 CSV（UTF-8）：跳过说明头，找"交易时间"表头
export function parseWechatCsv(text) {
  const rows = parseCsv(text)
  const headerIdx = rows.findIndex((r) => r[0] && String(r[0]).trim().startsWith('交易时间'))
  if (headerIdx < 0) return { rows: [], error: '未找到微信账单表头（交易时间）' }
  const h = rows[headerIdx].map((s) => String(s).trim())
  const col = (name) => h.indexOf(name)
  const iTime = col('交易时间'); const iType = col('交易类型'); const iPeer = col('交易对方')
  const iGoods = col('商品'); const iInOut = col('收/支'); const iAmt = col('金额(元)')
  const iPay = col('支付方式'); const iStatus = col('当前状态'); const iTxn = col('交易单号'); const iNote = col('备注')
  if (iTime < 0 || iAmt < 0) return { rows: [], error: '微信账单缺少关键列' }
  const out = []
  for (const r of rows.slice(headerIdx + 1)) {
    const status = String(r[iStatus] || '').trim()
    if (status && !/成功|已入账|已支付|已收钱|已到账/.test(status)) continue
    const amount = Number(String(r[iAmt] || '').replace(/[¥￥,\s]/g, ''))
    if (!Number.isFinite(amount) || amount <= 0) continue
    const inOut = String(r[iInOut] || '').trim()
    const direction = inOut === '收入' ? 'income' : inOut.includes('/') ? 'transfer' : 'expense'
    const txn = String(r[iTxn] || '').trim()
    out.push({
      ext_id: txn ? 'wx-' + txn : '',
      ts: csvTime(r[iTime]) || nowIso(),
      amount: Math.round(amount * 100) / 100,
      direction,
      merchant: String(r[iPeer] || '').trim().slice(0, 120),
      goods_name: String(r[iGoods] || '').trim().slice(0, 120),
      account: 'wechat',
      note: String(r[iNote] || '').trim().slice(0, 200),
      raw_text: `微信账单 | ${r[iType] || ''} | ${r[iPeer] || ''} | ¥${amount} | ${r[iPay] || ''}`,
    })
  }
  return { rows: out }
}

// 支付宝交易明细 CSV（GBK 编码）：找"交易号"表头
export function parseAlipayCsv(buf) {
  let text
  try { text = new TextDecoder('gbk').decode(buf) } catch (e) { text = buf.toString('utf8') }
  const rows = parseCsv(text)
  const headerIdx = rows.findIndex((r) => r[0] && String(r[0]).trim() === '交易号')
  if (headerIdx < 0) return { rows: [], error: '未找到支付宝账单表头（交易号）' }
  const h = rows[headerIdx].map((s) => String(s).trim())
  const col = (name) => h.indexOf(name)
  const iTxn = col('交易号'); const iTime = col('付款时间') >= 0 ? col('付款时间') : col('交易创建时间')
  const iPeer = col('交易对方'); const iGoods = col('商品名称'); const iAmt = col('金额（元）')
  const iInOut = col('收/支'); const iStatus = col('交易状态'); const iNote = col('备注')
  if (iTxn < 0 || iTime < 0 || iAmt < 0) return { rows: [], error: '支付宝账单缺少关键列' }
  const out = []
  for (const r of rows.slice(headerIdx + 1)) {
    const status = String(r[iStatus] || '').trim()
    if (status && !status.includes('成功') && !status.includes('已付款') && !status.includes('已到账')) continue
    const amount = Number(String(r[iAmt] || '').replace(/[¥￥,\s]/g, ''))
    if (!Number.isFinite(amount) || amount <= 0) continue
    const inOut = String(r[iInOut] || '').trim()
    const direction = inOut === '收入' ? 'income' : inOut === '支出' ? 'expense' : 'transfer'
    out.push({
      ext_id: 'ali-' + String(r[iTxn] || '').trim(),
      ts: csvTime(r[iTime]) || nowIso(),
      amount: Math.round(amount * 100) / 100,
      direction,
      merchant: String(r[iPeer] || '').trim().slice(0, 120),
      goods_name: String(r[iGoods] || '').trim().slice(0, 120),
      account: 'alipay',
      note: String(r[iNote] || '').trim().slice(0, 200),
      raw_text: `支付宝账单 | ${r[iPeer] || ''} | ¥${amount} | ${status}`,
    })
  }
  return { rows: out }
}

// 导入明细：ext_id 去重、规则记忆自动分类、直接确认入账
export async function importBillRows(rows) {
  let imported = 0
  let skipped = 0
  for (const r of rows) {
    if (r.ext_id) {
      const exist = db.prepare('SELECT id FROM transactions WHERE ext_id = ?').get(r.ext_id)
      if (exist) { skipped++; continue }
    }
    const ts = validTs(r.ts) || nowIso()
    let category = null
    if (r.direction === 'expense') {
      const rule = ruleFor(r.merchant)
      category = rule ? rule.category : '其他'
    }
    const rev = nextRev()
    const now = nowIso()
    db.prepare(`
      INSERT INTO transactions (uid, ext_id, ts, created_at, amount, currency, direction, merchant, goods_name, category, account, raw_text, source, status, confidence, note, edited, rev, updated_at)
      VALUES (?,?,?,?,?,'CNY',?,?,?,?,?,?,'csv','confirmed',NULL,?,0,?,?)
    `).run(newUid(), r.ext_id || null, ts, now, r.amount, r.direction, r.merchant, r.goods_name, category, r.account, r.raw_text, r.note, rev, now)
    imported++
  }
  return { imported, skipped }
}

// 从邮箱收取账单附件并导入
export async function importBills(cfg) {
  if (!cfg.enabled) return { imported: 0, skipped: 0, error: '未配置邮箱（MAIL_* / AUTO_IMPORT）' }
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  })
  await client.connect()
  const lock = await client.getMailboxLock(cfg.box)
  try {
    const since = new Date(Date.now() - 45 * 24 * 3600 * 1000)
    const files = []
    for await (const msg of client.fetch({ since }, { envelope: true, bodyStructure: true }, { uid: true })) {
      const from = (msg.envelope.from || []).map((f) => f.address || '').join(' ')
      const subj = msg.envelope.subject || ''
      if (!new RegExp(cfg.fromFilter, 'i').test(from + ' ' + subj)) continue
      for (const att of msg.attachments || []) {
        const name = att.filename || ''
        if (!/\.csv$/i.test(name)) continue
        try {
          const buf = await client.download(att, msg.uid)
          files.push({ name, buffer: buf })
        } catch (e) { /* 单个附件失败不中断 */ }
      }
    }
    let imported = 0
    let skipped = 0
    for (const f of files) {
      const isAli = /alipay|支付宝/i.test(f.name)
      const parsed = isAli ? parseAlipayCsv(f.buffer) : parseWechatCsv(f.buffer.toString('utf8'))
      if (parsed.error) continue
      const r = await importBillRows(parsed.rows)
      imported += r.imported
      skipped += r.skipped
    }
    return { imported, skipped, error: '', files: files.length }
  } finally {
    lock.release()
    await client.logout()
  }
}
