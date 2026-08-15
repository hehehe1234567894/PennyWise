import fs from 'node:fs'
import path from 'node:path'
import { env, DATA_DIR } from './env.js'
import { db, ruleFor, nowIso, validTs, newUid, nextRev } from './db.js'
import { llmConfig } from './llm.js'
import { ImapFlow } from 'imapflow'
import AdmZip from 'adm-zip'
import XLSX from 'xlsx'

const INBOX_DIR = path.join(DATA_DIR, 'inbox')

// ================= 账单导入（微信/支付宝/银行，多策略解析 + LLM 兜底） =================

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

export function xlsxToRows(buf) {
  try {
    const wb = XLSX.read(buf, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' })
      .map((r) => r.map((c) => String(c ?? '').trim()))
  } catch { return [] }
}

export function htmlTableToRows(html) {
  const tables = []
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi
  let tm
  while ((tm = tableRe.exec(html))) {
    const rows = []
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    let rm
    while ((rm = trRe.exec(tm[1]))) {
      const cells = []
      const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
      let dm
      while ((dm = tdRe.exec(rm[1]))) {
        const c = dm[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&#(\d+);/g, (m2, n) => String.fromCharCode(Number(n)))
          .replace(/\s+/g, ' ')
          .trim()
        cells.push(c)
      }
      if (cells.length) rows.push(cells)
    }
    if (rows.length) tables.push(rows)
  }
  tables.sort((a, b) => b.length - a.length)
  return tables[0] || []
}

function csvTime(v) {
  const s = String(v || '').trim()
  if (!s) return null
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?$/)
  if (!m) return null
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0))
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString()
}

function amountNum(v) {
  const n = Number(String(v ?? '').replace(/[¥￥,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

// ---- 微信账单：行数组（CSV/xlsx 通用）----
export function parseWechatRows(rows) {
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
    const amount = amountNum(r[iAmt])
    if (amount <= 0) continue
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
export function parseWechatCsv(text) { return parseWechatRows(parseCsv(text)) }
export function parseWechatXlsx(buf) {
  const rows = xlsxToRows(buf)
  if (!rows.length) return { rows: [], error: 'xlsx 无法读取' }
  return parseWechatRows(rows)
}

// ---- 支付宝账单：行数组（账单 CSV / 电子回单 CSV / HTML 表格通用）----
export function parseAlipayRows(rows) {
  const headerIdx = rows.findIndex((r) => {
    if (r[0] && String(r[0]).trim() === '交易号') return true
    const joined = r.map((s) => String(s).trim()).join('|')
    return /交易时间/.test(joined) && /金额/.test(joined) && /交易对方/.test(joined) && /交易订单号|交易号/.test(joined)
  })
  if (headerIdx < 0) return { rows: [], error: '未找到支付宝账单表头' }
  const h = rows[headerIdx].map((s) => String(s).trim())
  const col = (name) => h.indexOf(name)
  const iTxn = col('交易号') >= 0 ? col('交易号') : col('交易订单号')
  const iTime = col('付款时间') >= 0 ? col('付款时间') : (col('交易创建时间') >= 0 ? col('交易创建时间') : col('交易时间'))
  const iPeer = col('交易对方')
  const iGoods = col('商品名称') >= 0 ? col('商品名称') : col('商品说明')
  const iAmt = col('金额（元）') >= 0 ? col('金额（元）') : col('金额')
  const iInOut = col('收/支')
  const iStatus = col('交易状态')
  const iNote = col('备注')
  if (iTxn < 0 || iTime < 0 || iAmt < 0) return { rows: [], error: '支付宝账单缺少关键列' }
  const out = []
  for (const r of rows.slice(headerIdx + 1)) {
    const status = String(r[iStatus] || '').trim()
    if (status && /失败|关闭|取消/.test(status)) continue // 还款失败等不入账
    if (status && !/成功|已付款|已到账|已支付|完成/.test(status)) continue
    const amount = amountNum(r[iAmt])
    if (amount <= 0) continue
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
export function parseAlipayCsv(buf) {
  let text
  try { text = new TextDecoder('gbk').decode(buf) } catch (e) { text = buf.toString('utf8') }
  return parseAlipayRows(parseCsv(text))
}
export function parseAlipayHtml(html) {
  const rows = htmlTableToRows(html)
  if (!rows.length) return { rows: [], error: 'HTML 中未找到表格' }
  return parseAlipayRows(rows)
}

// ---- 银行对账单：行数组（自动识别常见表头）----
export function parseBankRows(rows) {
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
    if (!/^\d{4}/.test(dateStr)) continue
    const timeStr = iTime >= 0 && iTime !== iDate ? String(r[iTime] || '').trim() : ''
    const ts = csvTime(dateStr + (timeStr ? ' ' + timeStr : '')) || nowIso()
    const toNum = (i) => (i >= 0 ? amountNum(r[i]) : 0)
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
      else if (iBalance >= 0 && prevBalance !== null) direction = toNum(iBalance) > prevBalance ? 'income' : 'expense'
      else continue
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
export function parseBankCsv(buf) {
  let text = buf.toString('utf8')
  if (text.includes('\uFFFD')) text = new TextDecoder('gbk').decode(buf)
  return parseBankRows(parseCsv(text))
}

// ---- LLM 兜底：列映射解析未知格式 ----
export async function parseRowsWithLlm(rows) {
  const cfg = llmConfig()
  if (!cfg.enabled) return { rows: [], error: '无法识别的账单格式（且未配置文本模型，无法 LLM 兜底）' }
  const sample = rows.slice(0, 11).map((r) => r.join('\t')).join('\n')
  const sys = '你是账单文件解析器。用户给你账单的表头与前若干行（制表符分隔）。请识别各列含义，只输出一个 JSON 对象：{"skipHeaderRows":表头之前要跳过的行数,"colTs":交易时间列下标,"colAmount":金额列下标,"colIncome":收入金额列下标(-1表示无),"colExpense":支出金额列下标(-1表示无),"colDirection":收支方向列下标(-1表示无),"colMerchant":对方/商户列下标,"colGoods":商品列下标(-1表示无),"colNote":备注列下标(-1表示无),"colTxn":交易单号列下标(-1表示无)}。下标从 0 开始计数。'
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: sample.slice(0, 6000) }],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(45000),
    })
    if (!res.ok) return { rows: [], error: 'LLM 列识别失败 http' + res.status }
    const j = await res.json()
    const m = JSON.parse(String(j?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim())
    const g = (k, def = -1) => (Number.isInteger(m[k]) ? m[k] : def)
    const skip = g('skipHeaderRows', 0)
    const cTs = g('colTs'); const cAmt = g('colAmount'); const cInc = g('colIncome')
    const cExp = g('colExpense'); const cDir = g('colDirection'); const cPeer = g('colMerchant')
    const cGoods = g('colGoods'); const cNote = g('colNote'); const cTxn = g('colTxn')
    if (cTs < 0 && cAmt < 0) return { rows: [], error: 'LLM 未识别出时间/金额列' }
    const out = []
    for (const r of rows.slice(skip)) {
      const ts = cTs >= 0 ? (csvTime(r[cTs]) || nowIso()) : nowIso()
      let amount = 0
      let direction = 'expense'
      const inc = cInc >= 0 ? amountNum(r[cInc]) : 0
      const exp = cExp >= 0 ? amountNum(r[cExp]) : 0
      if (inc > 0 || exp > 0) {
        amount = inc > 0 ? inc : exp
        direction = inc > 0 ? 'income' : 'expense'
      } else if (cAmt >= 0) {
        amount = amountNum(r[cAmt])
        if (amount <= 0) continue
        const dirRaw = cDir >= 0 ? String(r[cDir] || '') : ''
        if (/贷|收|收入/.test(dirRaw)) direction = 'income'
        else if (/借|支|支出|付/.test(dirRaw)) direction = 'expense'
      } else continue
      const peer = cPeer >= 0 ? String(r[cPeer] || '').trim() : ''
      const txn = cTxn >= 0 ? String(r[cTxn] || '').trim() : ''
      const ext = txn ? 'llm-' + txn : 'llm-' + String(ts).slice(0, 10) + '|' + amount.toFixed(2) + '|' + peer
      out.push({
        ext_id: ext,
        ts,
        amount: Math.round(amount * 100) / 100,
        direction,
        merchant: peer.slice(0, 120),
        goods_name: cGoods >= 0 ? String(r[cGoods] || '').trim().slice(0, 120) : '',
        account: 'other',
        note: cNote >= 0 ? String(r[cNote] || '').trim().slice(0, 200) : '',
        raw_text: `LLM账单 | ${ts} | ${peer} | ¥${amount}`,
      })
    }
    return { rows: out }
  } catch (e) {
    return { rows: [], error: 'LLM 列识别失败：' + String(e?.message || e).slice(0, 100) }
  }
}

// ---- 导入明细 ----
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

// 行数据 → 确定性解析（按平台提示）→ 失败 LLM 兜底 → 入库
export async function importRowsSmart(rows, kindHint) {
  let parsed = null
  if (kindHint === 'wechat') parsed = parseWechatRows(rows)
  else if (kindHint === 'alipay') parsed = parseAlipayRows(rows)
  else if (kindHint === 'bank') parsed = parseBankRows(rows)
  else {
    parsed = parseWechatRows(rows)
    if (parsed.error) parsed = parseAlipayRows(rows)
    if (parsed.error) parsed = parseBankRows(rows)
  }
  if (parsed.error) {
    const llm = await parseRowsWithLlm(rows)
    if (llm.error) return { imported: 0, skipped: 0, error: llm.error }
    return await importBillRows(llm.rows)
  }
  return await importBillRows(parsed.rows)
}

// 按文件名/内容处理一个账单文件（CSV / XLSX / HTML 表格 / 原始行）
export async function importBillFile(name, buf, kindHint) {
  const isXlsx = /\.xlsx?$/i.test(name)
  const isHtml = /\.html?$/i.test(name) || /<table/i.test(buf.toString('latin1').slice(0, 4000))
  if (isXlsx) {
    const rows = xlsxToRows(buf)
    if (!rows.length) return { imported: 0, skipped: 0, error: 'xlsx 无法读取' }
    return await importRowsSmart(rows, kindHint || (/支付宝/i.test(name) ? 'alipay' : /微信/i.test(name) ? 'wechat' : null))
  }
  if (isHtml) {
    const rows = htmlTableToRows(buf.toString('utf8'))
    if (!rows.length) return { imported: 0, skipped: 0, error: 'HTML 中未找到表格' }
    return await importRowsSmart(rows, kindHint || 'alipay')
  }
  // CSV：先按 GBK 兼容策略读文本
  let text = buf.toString('utf8')
  if (text.includes('\uFFFD')) text = new TextDecoder('gbk').decode(buf)
  const isAli = /alipay|支付宝/i.test(name)
  const isWx = /wechat|微信/i.test(name)
  let parsed
  if (isAli) parsed = parseAlipayRows(parseCsv(text))
  else if (isWx) parsed = parseWechatRows(parseCsv(text))
  else {
    parsed = parseWechatRows(parseCsv(text))
    if (parsed.error) parsed = parseAlipayRows(parseCsv(text))
    if (parsed.error) parsed = parseBankRows(parseCsv(text))
  }
  if (parsed.error) return await importRowsSmart(parseCsv(text), kindHint)
  return await importBillRows(parsed.rows)
}

// ---- 解压密码：多策略（主题分平台 + 正则 + LLM 兜底） ----

export function extractPassword(subject, text) {
  const subj = String(subject || '').trim()
  const body = String(text || '').trim()
  let kind = 'any'
  if (/微信密码/.test(subj)) kind = 'wechat'
  else if (/支付宝密码/.test(subj)) kind = 'alipay'
  else if (!/密码/.test(subj + '\n' + body)) return null
  const clean = body.replace(/[\s\u3000]/g, '')
  if (/^[A-Za-z0-9]{4,16}$/.test(clean)) return { kind, password: clean }
  const s = subj + '\n' + body
  const m = s.match(/解压密码[：: ]*(?:是|为)?\s*([A-Za-z0-9]{4,16})/) || s.match(/密码[：: ]*(?:是|为)?\s*([A-Za-z0-9]{4,16})/)
  if (m) return { kind, password: m[1] }
  return { kind, password: '' } // 有密码邮件但规则提取失败 → 调用方走 LLM 兜底
}

export async function extractPasswordLlm(subject, text) {
  const cfg = llmConfig()
  if (!cfg.enabled) return null
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: '你是邮件解析器。从邮件主题和正文中提取账单压缩包的解压密码，只输出密码本身（4-16 位字母或数字），找不到输出 NONE。' },
          { role: 'user', content: `主题：${subject}\n正文：${String(text || '').slice(0, 2000)}` },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return null
    const j = await res.json()
    const p = String(j?.choices?.[0]?.message?.content || '').trim()
    return /^[A-Za-z0-9]{4,16}$/.test(p) ? p : null
  } catch { return null }
}

// ---- 加密 zip：待处理队列 + 密码历史（分平台） ----

function pendingZips() {
  try { return JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'pending_zips'").get()?.v || '[]') } catch { return [] }
}
function savePendingZips(list) {
  db.prepare("INSERT INTO meta (k, v) VALUES ('pending_zips', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(list))
}
function passwordHistory() {
  try {
    const arr = JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'bill_passwords'").get()?.v || '[]')
    return arr.map((x) => (typeof x === 'string' ? { kind: 'any', password: x, at: '' } : x))
  } catch { return [] }
}
function savePasswordHistory(list) {
  db.prepare("INSERT INTO meta (k, v) VALUES ('bill_passwords', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(list))
}

// 解压 zip 并导入其中 CSV/XLSX（密码必须显式传给 getData；zipKind 为平台提示）
export async function tryUnzipImport(filePath, password, zipKind) {
  try {
    const zip = new AdmZip(filePath)
    const entries = zip.getEntries(password).filter((e) => !e.isDirectory)
    let imported = 0
    let skipped = 0
    let found = false
    for (const e of entries) {
      const name = e.entryName || ''
      const isXlsx = /\.xlsx?$/i.test(name)
      if (!/\.(csv|xlsx?)$/i.test(name)) continue
      found = true
      const kindHint = zipKind || (/支付宝/i.test(name) ? 'alipay' : /微信/i.test(name) ? 'wechat' : null)
      const r = isXlsx
        ? await importBillFile(name, e.getData(password), kindHint)
        : await importBillFile(name, e.getData(password), kindHint)
      imported += r.imported
      skipped += r.skipped
    }
    return { ok: found, imported, skipped, badPassword: false }
  } catch (e) {
    const msg = String(e?.message || e)
    return { ok: false, imported: 0, skipped: 0, badPassword: true, error: msg.slice(0, 100) }
  }
}

// ---- 邮件解析（自建 MIME 解析） ----

function qpDecode(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
}
// RFC2047 编码字（=?charset?B?base64?= / =?charset?Q?quoted?=）解码
export function decodeRfc2047(s) {
  let out = String(s).replace(/[ \t]*\r?\n[ \t]*/g, '')
  out = out.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (m, cs, enc, data) => {
    try {
      let buf
      if (enc.toUpperCase() === 'B') buf = Buffer.from(data, 'base64')
      else buf = Buffer.from(qpDecode(data.replace(/_/g, ' ')), 'latin1')
      let t
      try { t = new TextDecoder(cs.toLowerCase()).decode(buf) } catch { t = buf.toString('utf8') }
      return t
    } catch { return m }
  })
  return out
}
function decodeFilename(v) {
  let s = decodeRfc2047(String(v))
  s = s.replace(/^"|"$/g, '')
  const rfc2231 = s.match(/^UTF-8''(.+)$/i)
  if (rfc2231) {
    try { s = decodeURIComponent(rfc2231[1]) } catch { s = rfc2231[1] }
  }
  return s
}

export function parseMime(raw) {
  const src = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw)
  const text = []
  const files = []
  function decodeBody(headers, body) {
    const cte = /^content-transfer-encoding:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim().toLowerCase() || '7bit'
    if (cte === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64')
    if (cte === 'quoted-printable') return Buffer.from(qpDecode(body), 'latin1')
    return Buffer.from(body, 'latin1')
  }
  function walk(headers, body) {
    const h = headers.replace(/\r?\n[ \t]+/g, ' ')
    const ct = /^content-type:\s*([^\r\n]+)/im.exec(h)?.[1] || ''
    const bm = /boundary="?([^";\r\n]+)"?/i.exec(ct)
    if (bm) {
      const boundary = bm[1]
      const segs = body.split('--' + boundary)
      for (const seg of segs.slice(1, -1)) {
        const si = seg.search(/\r?\n\r?\n/)
        if (si < 0) continue
        walk(seg.slice(0, si).replace(/^\r?\n/, ''), seg.slice(si + 2))
      }
      return
    }
    const cs = /charset="?([^";\r\n]+)"?/im.exec(h)?.[1]?.trim().toLowerCase() || ''
    const filenameM = /filename\*?=(?:"([^"]+)"|([^;\r\n]+))/i.exec(h) || /name="?([^";\r\n]+)"?/i.exec(ct)
    const filename = filenameM ? decodeFilename(filenameM[1] || filenameM[2] || '') : ''
    if (/^text\//i.test(ct)) {
      const buf = decodeBody(h, body)
      let t
      try { t = /^gb/i.test(cs) ? new TextDecoder('gbk').decode(buf) : buf.toString('utf8') } catch { t = buf.toString('utf8') }
      text.push(t)
    } else if (filename && /\.(zip|csv|xlsx?)$/i.test(filename)) {
      files.push({ name: filename, buffer: decodeBody(h, body) })
    }
  }
  const idx = src.search(/\r?\n\r?\n/)
  if (idx >= 0) walk(src.slice(0, idx), src.slice(idx + 2).replace(/\r?\n$/, ''))
  return { text: text.join('\n'), files }
}

export function extractLinks(text) {
  const links = []
  const re = /https?:\/\/[^\s<>"']+/gi
  let m
  while ((m = re.exec(text))) links.push(m[0].replace(/&amp;/g, '&'))
  return [...new Set(links)]
}

export async function downloadBillFile(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90000), redirect: 'follow' })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 100) return null
    const cd = res.headers.get('content-disposition') || ''
    const ct = res.headers.get('content-type') || ''
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b
    const isXlsx = buf[0] === 0x50 && buf[1] === 0x4b && /xlsx/i.test(cd) || /spreadsheet|officedocument/i.test(ct) || /\.xlsx?/i.test(cd)
    if (!isZip && !/\.(zip|csv|xlsx?)/i.test(cd) && !/zip|spreadsheet|csv/i.test(ct)) return null
    return { buffer: buf, kind: isZip && !isXlsx ? 'zip' : 'file' }
  } catch { return null }
}

function senderKind(from) {
  if (/alipay|支付宝/i.test(from)) return 'alipay'
  if (/wechatpay|微信支付|weixin/i.test(from)) return 'wechat'
  return 'bank'
}

// ---- 主流程：从邮箱收取账单并导入 ----
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
    for await (const msg of client.fetch({ since }, { envelope: true, source: true }, { uid: true })) {
      // 隐私红线：① 白名单账单邮件读正文/附件/链接；② 自己发的密码邮件只提取密码
      const from = (msg.envelope.from || []).map((f) => f.address || '').join(' ')
      const isSelf = String(cfg.user || '').trim().toLowerCase() === from.trim().toLowerCase()
      const isWhitelist = new RegExp(cfg.fromFilter, 'i').test(from)
      if (!isSelf && !isWhitelist) continue
      const { text, files } = parseMime(msg.source || Buffer.alloc(0))
      const subject = msg.envelope.subject || ''
      let pw = extractPassword(subject, text)
      if (pw && !pw.password) {
        // 规则提取失败 → LLM 兜底
        const llmPw = await extractPasswordLlm(subject, text)
        if (llmPw) pw = { kind: pw.kind, password: llmPw }
      }
      if (pw && pw.password && !passwords.some((p) => p.password === pw.password && p.kind === pw.kind)) {
        passwords.push({ kind: pw.kind, password: pw.password, at: nowIso() })
      }
      if (!isWhitelist) continue // 自己发的邮件到此为止
      const kind = senderKind(from)
      for (const f of files) {
        if (/\.zip$/i.test(f.name)) newZips.push({ name: f.name, buffer: f.buffer, kind })
        else if (/\.(csv|xlsx?|html?)$/i.test(f.name)) {
          const r = await importBillFile(f.name, f.buffer, kind)
          imported += r.imported
          skipped += r.skipped
        }
      }
      // 正文里的账单下载链接（微信账单用链接）
      const links = extractLinks(text).filter((l) => /wechatpay|tenpay|weixin|qpay|alipay|bank/i.test(l))
      for (const link of links.slice(0, 3)) {
        const dl = await downloadBillFile(link)
        if (!dl) continue
        if (dl.kind === 'zip') newZips.push({ name: 'link-' + Date.now() + '.zip', buffer: dl.buffer, kind })
        else {
          const r = await importBillFile('link-' + Date.now() + (kind === 'alipay' ? '.xlsx' : '.csv'), dl.buffer, kind)
          imported += r.imported
          skipped += r.skipped
        }
      }
      // 支付宝账单：流水表格直接渲染在正文 HTML 里 → 直接解析表格
      if (kind === 'alipay' && /<table/i.test(text) && /交易号/.test(text)) {
        const r = await importBillFile('body.html', Buffer.from(text, 'utf8'), 'alipay')
        imported += r.imported
        skipped += r.skipped
      }
    }
  } finally {
    lock.release()
    await client.logout()
  }
  // 新 zip 落盘（带平台标记），等密码配对
  fs.mkdirSync(INBOX_DIR, { recursive: true })
  const pend = pendingZips()
  for (const z of newZips) {
    const file = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.zip'
    fs.writeFileSync(path.join(INBOX_DIR, file), z.buffer)
    pend.push({ name: z.name, file, savedAt: nowIso(), kind: z.kind || 'any' })
  }
  // 配对：本平台密码优先 → any → 其余
  const allPw = [...new Set([...passwords, ...passwordHistory()])]
  const still = []
  for (const p of pend) {
    const ordered = [
      ...allPw.filter((x) => x.kind === p.kind),
      ...allPw.filter((x) => x.kind === 'any'),
      ...allPw.filter((x) => x.kind !== p.kind && x.kind !== 'any'),
    ]
    let done = false
    for (const entry of ordered) {
      const r = await tryUnzipImport(path.join(INBOX_DIR, p.file), entry.password, p.kind)
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
  const fresh = []
  for (const p of still) {
    if (Date.now() - Date.parse(p.savedAt || nowIso()) < 14 * 24 * 3600 * 1000) fresh.push(p)
    else fs.rmSync(path.join(INBOX_DIR, p.file), { force: true })
  }
  savePendingZips(fresh)
  savePasswordHistory([...passwords, ...passwordHistory()].slice(-20))
  return { imported, skipped, error: '', files: newZips.length, passwords: passwords.length }
}
