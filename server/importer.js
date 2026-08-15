import fs from 'node:fs'
import path from 'node:path'
import { env, DATA_DIR } from './env.js'
import { db, ruleFor, nowIso, validTs, newUid, nextRev } from './db.js'
import { ImapFlow } from 'imapflow'
import AdmZip from 'adm-zip'

const INBOX_DIR = path.join(DATA_DIR, 'inbox')

// ================= 账单导入（微信/支付宝 CSV + 邮箱自动收取） =================

export function mailConfig() {
  const imapConfigured = Boolean(env('MAIL_USER')) && Boolean(env('MAIL_PASS')) && Boolean(env('MAIL_IMAP_HOST'))
  return {
    imapConfigured,
    billsEnabled: env('AUTO_IMPORT', '0') === '1' && imapConfigured,
    enabled: imapConfigured && env('AUTO_IMPORT', '0') === '1',
    host: env('MAIL_IMAP_HOST', ''),
    port: Number(env('MAIL_IMAP_PORT', '993')) || 993,
    user: env('MAIL_USER', ''),
    pass: env('MAIL_PASS', ''),
    box: env('MAIL_BOX', 'INBOX'),
    // 隐私红线：只读白名单发件人的账单邮件（微信/支付宝/银行），其他邮件一律不碰、不上传云端
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

// 银行对账单 CSV：自动识别常见银行表头（收入/支出两列，或金额+方向列）
export function parseBankCsv(buf) {
  let text = buf.toString('utf8')
  if (text.includes('\uFFFD')) text = new TextDecoder('gbk').decode(buf)
  const rows = parseCsv(text)
  const headerIdx = rows.findIndex((r) => {
    const joined = r.map((s) => String(s).trim()).join('|')
    return /交易日期|记账日期|交易时间|发生日期|日期/.test(joined) && /金额|发生额/.test(joined)
  })
  if (headerIdx < 0) return { rows: [], error: '未识别银行对账单表头' }
  const h = rows[headerIdx].map((s) => String(s).trim())
  const find = (...names) => h.findIndex((c) => names.some((n) => c.includes(n)))
  const iDate = find('交易日期', '记账日期', '交易时间', '发生日期', '日期')
  const iTime = find('交易时间')
  const iIncome = find('收入金额', '收入', '存入金额', '贷方发生额', '贷方金额')
  const iExpense = find('支出金额', '支出', '支取金额', '借方发生额', '借方金额')
  const iAmount = find('交易金额', '发生额', '金额')
  const iDir = find('收支', '借贷标志', '借贷', '收/支', '资金流向')
  const iBalance = find('余额', '账户余额')
  const iPeer = find('对方户名', '对方账号', '交易对方', '商户名称', '对方单位', '对方名称', '交易摘要', '摘要')
  const iNote = find('备注', '用途', '附言', '交易摘要', '摘要')
  const iTxn = find('流水号', '交易序号', '凭证号', '交易流水号', '序号')
  if (iDate < 0) return { rows: [], error: '缺少日期列' }
  if (iIncome < 0 && iExpense < 0 && iAmount < 0) return { rows: [], error: '缺少金额列' }
  const out = []
  let prevBalance = null
  for (const r of rows.slice(headerIdx + 1)) {
    const dateStr = String(r[iDate] || '').trim()
    if (!/^\d{4}/.test(dateStr)) continue // 跳过合计/空行
    const timeStr = iTime >= 0 && iTime !== iDate ? String(r[iTime] || '').trim() : ''
    const ts = csvTime(dateStr + (timeStr ? ' ' + timeStr : '')) || nowIso()
    const toNum = (i) => {
      if (i < 0) return 0
      const v = Number(String(r[i] || '').replace(/[¥￥,\s]/g, ''))
      return Number.isFinite(v) ? v : 0
    }
    let amount = 0
    let direction = 'expense'
    if (iIncome >= 0 && iExpense >= 0) {
      const inc = toNum(iIncome)
      const exp = toNum(iExpense)
      if (inc > 0) { amount = inc; direction = 'income' }
      else if (exp > 0) { amount = exp; direction = 'expense' }
      else continue
    } else if (iAmount >= 0) {
      amount = toNum(iAmount)
      if (amount <= 0) continue
      const dirRaw = iDir >= 0 ? String(r[iDir] || '').trim() : ''
      if (/贷|收|收入/.test(dirRaw)) direction = 'income'
      else if (/借|支|支出|付/.test(dirRaw)) direction = 'expense'
      else if (iBalance >= 0 && prevBalance !== null) {
        direction = toNum(iBalance) > prevBalance ? 'income' : 'expense'
      } else continue
    }
    if (iBalance >= 0) prevBalance = toNum(iBalance)
    const peer = iPeer >= 0 ? String(r[iPeer] || '').trim() : ''
    const note = iNote >= 0 && iNote !== iPeer ? String(r[iNote] || '').trim() : ''
    const txn = iTxn >= 0 ? String(r[iTxn] || '').trim() : ''
    const ext = txn ? 'bank-' + txn : 'bank-' + dateStr + '|' + amount.toFixed(2) + '|' + peer
    out.push({
      ext_id: ext,
      ts,
      amount: Math.round(amount * 100) / 100,
      direction,
      merchant: peer.slice(0, 120),
      goods_name: '',
      account: 'bank',
      note: note.slice(0, 200),
      raw_text: `银行账单 | ${dateStr} | ${peer} | ¥${amount}`,
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

// 按文件名选解析器；名字不明确时依次尝试 微信 → 支付宝 → 银行
export async function importCsvByName(name, buf) {
  const isAli = /alipay|支付宝/i.test(name)
  const isWx = /wechat|微信/i.test(name)
  let parsed
  if (isAli) parsed = parseAlipayCsv(buf)
  else if (isWx) parsed = parseWechatCsv(buf.toString('utf8'))
  else {
    parsed = parseWechatCsv(buf.toString('utf8'))
    if (parsed.error) parsed = parseAlipayCsv(buf)
    if (parsed.error) parsed = parseBankCsv(buf)
  }
  if (parsed.error) return { imported: 0, skipped: 0, error: parsed.error }
  return await importBillRows(parsed.rows)
}

// ---- 微信/支付宝账单 = 加密 zip + 单独一封解压密码邮件 → 自动配对 ----

export function extractPassword(subject, text) {
  const s = String(subject || '') + '\n' + String(text || '')
  if (!/密码/.test(s)) return null
  const m = s.match(/解压密码[：: ]*(?:是|为)?\s*([A-Za-z0-9]{4,16})/)
    || s.match(/密码[：: ]*(?:是|为)?\s*(\d{4,8})/)
  return m ? m[1] : null
}

function pendingZips() {
  try { return JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'pending_zips'").get()?.v || '[]') } catch { return [] }
}
function savePendingZips(list) {
  db.prepare("INSERT INTO meta (k, v) VALUES ('pending_zips', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(list))
}
function passwordHistory() {
  try { return JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'bill_passwords'").get()?.v || '[]') } catch { return [] }
}
function savePasswordHistory(list) {
  db.prepare("INSERT INTO meta (k, v) VALUES ('bill_passwords', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(list))
}

// 尝试用密码解压并导入 zip 内 CSV；返回 { ok, imported, skipped, badPassword }
export async function tryUnzipImport(filePath, password) {
  try {
    const zip = new AdmZip(filePath)
    const entries = zip.getEntries(password).filter((e) => !e.isDirectory)
    let imported = 0
    let skipped = 0
    let found = false
    for (const e of entries) {
      const name = e.entryName || ''
      if (!/\.csv/i.test(name)) continue
      found = true
      // 密码必须显式传给 getData（加密 zip 的 ZipCrypto 解密在这里发生）
      const r = await importCsvByName(name, e.getData(password))
      imported += r.imported
      skipped += r.skipped
    }
    return { ok: found, imported, skipped, badPassword: false }
  } catch (e) {
    const msg = String(e?.message || e)
    return { ok: false, imported: 0, skipped: 0, badPassword: true, error: msg.slice(0, 100) }
  }
}

// 从邮箱收取账单附件并导入（zip 与密码邮件顺序无关，自动配对）
export async function importBills(cfg) {
  if (!cfg.billsEnabled) return { imported: 0, skipped: 0, error: '未配置账单邮件导入（MAIL_* / AUTO_IMPORT）' }
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  })
  await client.connect()
  const lock = await client.getMailboxLock(cfg.box)
  const newZips = []
  const passwords = []
  let imported = 0
  let skipped = 0
  try {
    const since = new Date(Date.now() - 45 * 24 * 3600 * 1000)
    for await (const msg of client.fetch({ since }, { envelope: true, bodyStructure: true }, { uid: true })) {
      // 隐私红线：只读白名单发件人（微信/支付宝/银行账单），其他邮件一律不碰
      const from = (msg.envelope.from || []).map((f) => f.address || '').join(' ')
      if (!new RegExp(cfg.fromFilter, 'i').test(from)) continue
      // 解压密码邮件：从主题/正文提取密码
      const pw = extractPassword(msg.envelope.subject || '', msg.text || '')
      if (pw && !passwords.includes(pw)) passwords.push(pw)
      for (const att of msg.attachments || []) {
        const name = att.filename || ''
        try {
          const buf = await client.download(att, msg.uid)
          if (/\.zip$/i.test(name)) newZips.push({ name, buffer: buf })
          else if (/\.csv$/i.test(name)) {
            const r = await importCsvByName(name, buf)
            imported += r.imported
            skipped += r.skipped
          }
        } catch (e) { /* 单个附件失败不中断 */ }
      }
    }
  } finally {
    lock.release()
    await client.logout()
  }
  // 新 zip 落盘进入待处理队列（等密码配对）
  fs.mkdirSync(INBOX_DIR, { recursive: true })
  const pend = pendingZips()
  for (const z of newZips) {
    const file = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.zip'
    fs.writeFileSync(path.join(INBOX_DIR, file), z.buffer)
    pend.push({ name: z.name, file, savedAt: nowIso() })
  }
  // 用（本次 + 历史）密码尝试解压全部待处理 zip
  const allPw = [...new Set([...passwords, ...passwordHistory()])]
  const still = []
  for (const p of pend) {
    let done = false
    for (const pw of allPw) {
      const r = await tryUnzipImport(path.join(INBOX_DIR, p.file), pw)
      if (r.ok) {
        imported += r.imported
        skipped += r.skipped
        fs.rmSync(path.join(INBOX_DIR, p.file), { force: true })
        done = true
        break
      }
    }
    if (!done) still.push(p)
  }
  // 清理超过 14 天仍无法解压的 zip
  const fresh = []
  for (const p of still) {
    if (Date.now() - Date.parse(p.savedAt || nowIso()) < 14 * 24 * 3600 * 1000) fresh.push(p)
    else fs.rmSync(path.join(INBOX_DIR, p.file), { force: true })
  }
  savePendingZips(fresh)
  savePasswordHistory(allPw.slice(-10))
  return { imported, skipped, error: '', files: newZips.length }
}
