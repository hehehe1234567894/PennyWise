// ================= 账单导出：Excel / CSV / 精美分析 PDF =================
// 三种筛选维度（可任意组合）：
//   range : 时间范围 —— { month: '2026-08' } 或 { from: '2026-07-01', to: '2026-08-31' }，都不给 = 全部
//   channel: 渠道 —— all / wechat / alipay / bank / cash / other（对应 transactions.account）
//   category: 消费分类 —— 留空 = 全部
// 账单文件（xlsx/csv）按筛选结果逐笔导出；PDF 报告是"给人看"的图文分析，内容块可勾选。
import fs from 'node:fs'
import { db, getCategories, currentMonth } from './db.js'

const ACCOUNT_LABEL = { wechat: '微信', alipay: '支付宝', bank: '银行卡', cash: '现金', other: '其他' }
const DIRECTION_LABEL = { expense: '支出', income: '收入', refund: '退款', transfer: '转账' }
const SOURCE_LABEL = { csv: '账单导入', email: '邮件账单', manual: '手动', text: '文字', image: '截图' }

export function channelLabel(k) { return ACCOUNT_LABEL[k] || k || '其他' }

// ================= 规则引擎（剔除 / 替换 共用匹配条件）=================
// 匹配条件（两种规则完全一致）：
//   merchant  : 商家名（必填，包含匹配）
//   direction : 限定方向（expense/income/refund/transfer）
//   from / to : 限定时间区间（YYYY-MM-DD）
//   min / max : 限定金额区间（绝对值，元）
//   category  : 限定分类
// 剔除规则：条件全空 = 剔除该商家全部账单
// 替换规则：条件全空 = 替换该商家全部账单
export const EXCLUDE_DIRECTIONS = ['expense', 'income', 'refund', 'transfer']

function str(v) { return typeof v === 'string' ? v.trim() : '' }
function num(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.abs(n) : null
}
// 匹配条件的公共部分（剔除与替换共用，保证两套规则行为完全一致）
function normCondition(r = {}) {
  const out = {
    id: str(r.id) || 'r' + Math.random().toString(36).slice(2, 9),
    merchant: str(r.merchant),
    direction: EXCLUDE_DIRECTIONS.includes(r.direction) ? r.direction : '',
    from: /^\d{4}-\d{2}-\d{2}$/.test(str(r.from)) ? str(r.from) : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(str(r.to)) ? str(r.to) : '',
    min: num(r.min),
    max: num(r.max),
    category: str(r.category),
    enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    note: str(r.note),
  }
  // 金额区间写反了自动交换，避免规则静默失效
  if (out.min !== null && out.max !== null && out.min > out.max) {
    const t = out.min; out.min = out.max; out.max = t
  }
  return out
}

function normRule(r = {}) { return normCondition(r) }

export function normalizeRules(list) {
  return (Array.isArray(list) ? list : []).map(normRule).filter((r) => r.merchant)
}

// ---- 替换规则：命中后把商家名（可选分类）改写成目标值 ----
// toMerchant: 替换成的商家名（必填，否则规则无效）
// toCategory: 同时把分类改成这个（留空 = 保留原分类）
// 注意：内部统一把"替换目标"存成 toMerchant，避免与时间上限字段 to 冲突
function normReplace(r = {}) {
  const out = normCondition(r)
  out.toMerchant = str(r.toMerchant !== undefined ? r.toMerchant : r.to)
  out.toCategory = str(r.toCategory)
  delete out.to_merchant
  return out
}
export function normalizeReplaces(list) {
  return (Array.isArray(list) ? list : []).map(normReplace).filter((r) => r.merchant && r.toMerchant)
}

// 单条匹配条件是否命中某笔交易（剔除/替换共用）
export function ruleMatches(rule, row) {
  if (!rule || !rule.enabled || !rule.merchant) return false
  const m = String(row.merchant || '')
  if (!m || !m.includes(rule.merchant)) return false
  if (rule.direction && row.direction !== rule.direction) return false
  if (rule.category && (row.category || '未分类') !== rule.category) return false
  if (rule.from || rule.to) {
    const day = String(row.ts || '').slice(0, 10)
    if (rule.from && day < rule.from) return false
    if (rule.to && day > rule.to) return false
  }
  const amt = Math.abs(Number(row.amount) || 0)
  if (rule.min !== null && amt < rule.min) return false
  if (rule.max !== null && amt > rule.max) return false
  return true
}

// 该笔交易命中的第一条规则（用于标记来源，便于用户在报告里核对剔除了什么）
export function firstMatch(rules, row) {
  for (const r of rules) if (ruleMatches(r, row)) return r
  return null
}

// 按规则拆分：保留 / 剔除。返回 excluded 明细便于预览与报告标注。
export function applyExcludes(rows, rules) {
  const active = normalizeRules(rules)
  if (!active.length) return { kept: rows, excluded: [], active: [] }
  const kept = []
  const excluded = []
  for (const row of rows) {
    const hit = firstMatch(active, row)
    if (hit) excluded.push({ ...row, _ruleId: hit.id, _ruleMerchant: hit.merchant })
    else kept.push(row)
  }
  return { kept, excluded, active }
}

// 应用替换规则：返回改写后的行 + 每条规则命中统计（用于报告标注）
// 完全替换不留痕迹：merchant 直接换成 to，原文不保留；toCategory 给了就一并改分类。
export function applyReplaces(rows, rules) {
  const active = normalizeReplaces(rules)
  if (!active.length) return { rows, applied: [], active: [] }
  const hitCount = new Map()
  const out = rows.map((row) => {
    const hit = firstMatch(active, row)
    if (!hit) return row
    const prev = hitCount.get(hit.id) || { id: hit.id, label: replaceLabel(hit), from: hit.merchant, to: hit.toMerchant, count: 0, amount: 0 }
    prev.count += 1
    prev.amount += Math.abs(Number(row.amount) || 0)
    hitCount.set(hit.id, prev)
    return {
      ...row,
      merchant: hit.toMerchant,
      category: hit.toCategory || row.category,
      _replacedFrom: row.merchant,
      _replaceId: hit.id,
    }
  })
  return { rows: out, applied: [...hitCount.values()], active }
}

// 剔除规则的中文描述（前端列表和报告里都用它）
export function ruleLabel(rule) {
  const r = normRule(rule)
  const parts = []
  if (r.direction) parts.push(DIRECTION_LABEL[r.direction] || r.direction)
  if (r.category) parts.push(r.category)
  if (r.min !== null && r.max !== null) parts.push(`¥${r.min}~¥${r.max}`)
  else if (r.min !== null) parts.push(`≥¥${r.min}`)
  else if (r.max !== null) parts.push(`≤¥${r.max}`)
  if (r.from || r.to) parts.push(`${r.from || '最早'}~${r.to || '今天'}`)
  return `「${r.merchant}」${parts.length ? ' 的 ' + parts.join(' · ') : ' 的全部账单'}`
}

// 替换规则的中文描述：突出「命中条件 → 替换目标」
export function replaceLabel(rule) {
  const r = normReplace(rule)
  const parts = []
  if (r.direction) parts.push(DIRECTION_LABEL[r.direction] || r.direction)
  if (r.category) parts.push(r.category)
  if (r.min !== null && r.max !== null) parts.push(`¥${r.min}~¥${r.max}`)
  else if (r.min !== null) parts.push(`≥¥${r.min}`)
  else if (r.max !== null) parts.push(`≤¥${r.max}`)
  if (r.from || r.to) parts.push(`${r.from || '最早'} 至 ${r.to || '今天'}`)
  const from = `「${r.merchant}」${parts.length ? ' 的 ' + parts.join(' · ') : ' 全部'}`
  const to = `「${r.toMerchant}」${r.toCategory ? ' · 归入「' + r.toCategory + '」' : ''}`
  return `${from} → ${to}`
}

// ---- 筛选条件 → SQL WHERE 片段 ----
function buildWhere({ month, from, to, channel, category } = {}) {
  const cond = ["amount IS NOT NULL"]
  const params = []
  if (month && /^\d{4}-\d{2}$/.test(month)) { cond.push('ts LIKE ?'); params.push(month + '%') }
  else {
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { cond.push('ts >= ?'); params.push(from + 'T00:00:00.000Z') }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { cond.push('ts <= ?'); params.push(to + 'T23:59:59.999Z') }
  }
  if (channel && channel !== 'all' && ACCOUNT_LABEL[channel]) { cond.push('account = ?'); params.push(channel) }
  if (category) { cond.push('category = ?'); params.push(category) }
  return { sql: cond.join(' AND '), params }
}

// 筛选条件下的逐笔交易（按时间倒序）
export function queryRows(filter = {}, { confirmedOnly = true } = {}) {
  const { sql, params } = buildWhere(filter)
  const extra = confirmedOnly ? " AND status = 'confirmed'" : ''
  return db.prepare(
    `SELECT uid, ts, amount, direction, merchant, goods_name, category, account, note, source, status, ext_id
     FROM transactions WHERE ${sql}${extra} ORDER BY ts DESC`
  ).all(...params)
}

// 导出用的表头与行（中文化，金额正负号按方向折算）
const HEADERS = ['交易时间', '类型', '金额(元)', '商户', '商品', '分类', '账户', '备注', '来源', '交易单号']
function fmtTime(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return String(ts || '')
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function signedAmount(amount, direction) {
  const n = Number(amount) || 0
  return direction === 'income' || direction === 'refund' ? Math.abs(n) : -Math.abs(n)
}
export function toMatrix(rows) {
  return [
    HEADERS,
    ...rows.map((r) => [
      fmtTime(r.ts),
      DIRECTION_LABEL[r.direction] || r.direction,
      signedAmount(r.amount, r.direction),
      r.merchant || '',
      r.goods_name || '',
      r.category || '未分类',
      ACCOUNT_LABEL[r.account] || r.account || '',
      r.note || '',
      SOURCE_LABEL[r.source] || r.source || '',
      r.ext_id || '',
    ]),
  ]
}

// ---- CSV（带 BOM，Excel 双击直接打开且中文不乱码）----
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
export function buildCsv(rows) {
  return toMatrix(rows).map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

// ---- Excel：用已装的 xlsx 包（动态加载，冷启动不背依赖）----
export async function buildXlsx(rows, meta = {}) {
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.aoa_to_sheet(toMatrix(rows))
  ws['!cols'] = [{ wch: 19 }, { wch: 6 }, { wch: 11 }, { wch: 22 }, { wch: 22 }, { wch: 10 }, { wch: 8 }, { wch: 18 }, { wch: 10 }, { wch: 28 }]
  // 金额列右对齐、可筛选：给标题行加自动筛选
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: HEADERS.length - 1 } }) }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '账本')
  // 第二张表：汇总（方便直接看总额）
  const sum = summarize(rows, meta)
  const sumWs = XLSX.utils.aoa_to_sheet([
    ['PennyWise 导出汇总'],
    ['时间范围', meta.rangeLabel || '全部'],
    ['渠道', meta.channelLabel || '全部'],
    ['分类', meta.category || '全部'],
    [''],
    ['类型', '笔数', '金额(元)'],
    ['支出', sum.expenseN, -sum.expense],
    ['收入', sum.incomeN, sum.income],
    ['退款', sum.refundN, sum.refund],
    ['转账', sum.transferN, sum.transfer],
    ['净收支', rows.length, sum.net],
  ])
  sumWs['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 14 }]
  XLSX.utils.book_append_sheet(wb, sumWs, '汇总')
  // 第三张表：已替换（有替换规则命中时才生成）
  const applied = Array.isArray(meta.appliedReplaces) ? meta.appliedReplaces : []
  if (applied.length) {
    const rpWs = XLSX.utils.aoa_to_sheet([
      ['以下账单的商家名已按导出偏好改写（账本中显示的是替换后的商家）'],
      ['替换规则', '笔数', '金额(元)'],
      ...applied.map((a) => [a.label || ('「' + a.from + '」 → 「' + a.to + '」'), a.count, a.amount]),
      ['合计', applied.reduce((s, a) => s + a.count, 0), applied.reduce((s, a) => s + a.amount, 0)],
    ])
    rpWs['!cols'] = [{ wch: 52 }, { wch: 10 }, { wch: 14 }]
    XLSX.utils.book_append_sheet(wb, rpWs, '已替换')
  }
  // 第四张表：被剔除的账单（有排除规则命中时才生成），让导出结果可自证口径
  const excluded = Array.isArray(meta.excluded) ? meta.excluded : []
  if (excluded.length) {
    const exWs = XLSX.utils.aoa_to_sheet([
      ['以下账单已按导出偏好剔除，未计入「账本」「汇总」'],
      ['剔除规则', '笔数', '金额(元)'],
      ...normalizeRules(meta.excludeRules || []).map((r) => {
        const hit = excluded.filter((e) => e._ruleId === r.id)
        return [ruleLabel(r), hit.length, -hit.reduce((s, e) => s + Math.abs(Number(e.amount) || 0), 0)]
      }).filter((row) => row[1] > 0),
      ['合计', excluded.length, -excluded.reduce((s, e) => s + Math.abs(Number(e.amount) || 0), 0)],
      [''],
      ...toMatrix(excluded.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))),
    ])
    exWs['!cols'] = [{ wch: 38 }, { wch: 8 }, { wch: 13 }, { wch: 20 }, { wch: 22 }, { wch: 10 }, { wch: 8 }, { wch: 16 }, { wch: 10 }, { wch: 26 }]
    XLSX.utils.book_append_sheet(wb, exWs, '已剔除')
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

export function summarize(rows, meta = {}) {
  const g = (d) => rows.filter((r) => r.direction === d)
  const sum = (a) => a.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0)
  const expense = sum(g('expense')), income = sum(g('income')), refund = sum(g('refund')), transfer = sum(g('transfer'))
  return {
    count: rows.length,
    expense, expenseN: g('expense').length,
    income, incomeN: g('income').length,
    refund, refundN: g('refund').length,
    transfer, transferN: g('transfer').length,
    net: income + refund - expense,
    rangeLabel: meta.rangeLabel || '全部',
  }
}

// ================= 精美分析 PDF =================
// 内容块（与前端勾选项一一对应）：
//   charts  基础版：概览卡片 + 分类环形图 + 月度趋势柱状图 + 最大支出榜
//   ai      AI 文字分析（调用模型写消费点评）
//   budget  预算执行进度条 + 省钱/升级建议
//   detail  逐笔明细附录
export function buildExportHtml({ rows, meta = {}, blocks = {}, narrative = '', alts = [], budgets = [], trend = [] }) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const yuan = (n, sign = false) => (sign && n > 0 ? '+' : '') + '¥' + Math.abs(Number(n) || 0).toFixed(2)
  const s = summarize(rows, meta)

  // 分类聚合
  const byCat = new Map()
  for (const r of rows) {
    if (r.direction !== 'expense') continue
    const k = r.category || '未分类'
    byCat.set(k, (byCat.get(k) || 0) + Math.abs(Number(r.amount) || 0))
  }
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1])
  const catTotal = cats.reduce((a, [, v]) => a + v, 0) || 1

  // 月度聚合（用于趋势图）
  const byMonth = new Map()
  for (const r of rows) {
    if (r.direction !== 'expense') continue
    const m = String(r.ts).slice(0, 7)
    byMonth.set(m, (byMonth.get(m) || 0) + Math.abs(Number(r.amount) || 0))
  }
  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const trendData = trend.length ? trend : months.map(([m, v]) => ({ month: m, expense: v }))
  const trendMax = Math.max(...trendData.map((t) => t.expense), 1)

  // 最大支出榜
  const top = rows.filter((r) => r.direction === 'expense').sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 10)

  // ---- 分类环形图（内联 SVG，不依赖任何图表库；打印友好）----
  const PALETTE = ['#0A84FF', '#30D158', '#FF9F0A', '#FF375F', '#BF5AF2', '#5AC8FA', '#FFD60A', '#64D2FF', '#AC8E68', '#8E8E93']
  function donut() {
    const R = 78, r = 50, cx = 100, cy = 100
    let acc = -Math.PI / 2
    const slices = cats.map(([name, v], i) => {
      const ang = (v / catTotal) * Math.PI * 2
      const a0 = acc, a1 = acc + ang
      acc = a1
      const large = ang > Math.PI ? 1 : 0
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0)
      const x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1)
      const x2 = cx + r * Math.cos(a1), y2 = cy + r * Math.sin(a1)
      const x3 = cx + r * Math.cos(a0), y3 = cy + r * Math.sin(a0)
      const d = `M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${r},${r} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`
      return `<path d="${d}" fill="${PALETTE[i % PALETTE.length]}"/>`
    }).join('')
    const legend = cats.slice(0, 10).map(([name, v], i) => `
      <div class="lg-row">
        <span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
        <span class="lg-name">${esc(name)}</span>
        <span class="lg-pct">${((v / catTotal) * 100).toFixed(1)}%</span>
        <span class="lg-amt">${yuan(v)}</span>
      </div>`).join('')
    return `<div class="donut-wrap">
      <svg viewBox="0 0 200 200" width="200" height="200">${slices}
        <text x="100" y="96" text-anchor="middle" font-size="13" fill="#6E6E73">总支出</text>
        <text x="100" y="118" text-anchor="middle" font-size="19" font-weight="700" fill="#1D1D1F">${yuan(catTotal)}</text>
      </svg>
      <div class="legend">${legend}</div>
    </div>`
  }

  // ---- 趋势柱状图（内联 SVG）----
  function bars() {
    const W = 560, H = 180, pad = 34
    const n = trendData.length || 1
    const bw = Math.min(56, (W - pad * 2) / n - 12)
    const barsSvg = trendData.map((t, i) => {
      const h = (t.expense / trendMax) * (H - pad - 24)
      const x = pad + i * ((W - pad * 2) / n) + ((W - pad * 2) / n - bw) / 2
      const y = H - pad - h
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="5" fill="url(#barGrad)"/>
        <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#6E6E73">${yuan(t.expense)}</text>
        <text x="${(x + bw / 2).toFixed(1)}" y="${H - pad + 15}" text-anchor="middle" font-size="10" fill="#86868B">${esc(String(t.month).slice(2))}</text>`
    }).join('')
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">
      <defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0A84FF"/><stop offset="100%" stop-color="#5AC8FA"/>
      </linearGradient></defs>
      <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#E5E5EA" stroke-width="1"/>
      ${barsSvg}</svg>`
  }

  const rangeLabel = meta.rangeLabel || '全部时间'
  const chip = (t) => `<span class="chip">${esc(t)}</span>`

  const overview = blocks.charts === false ? '' : `
  <section>
    <div class="cards">
      <div class="card"><div class="c-k">支出</div><div class="c-v red">${yuan(s.expense)}</div><div class="c-s">${s.expenseN} 笔</div></div>
      <div class="card"><div class="c-k">收入</div><div class="c-v green">${yuan(s.income)}</div><div class="c-s">${s.incomeN} 笔</div></div>
      <div class="card"><div class="c-k">退款</div><div class="c-v green">${yuan(s.refund)}</div><div class="c-s">${s.refundN} 笔</div></div>
      <div class="card"><div class="c-k">净收支</div><div class="c-v ${s.net >= 0 ? 'green' : 'red'}">${yuan(s.net, true)}</div><div class="c-s">共 ${s.count} 笔</div></div>
    </div>
    <h3>支出分类</h3>
    ${cats.length ? donut() : '<p class="muted">该范围内没有支出记录</p>'}
    <h3>月度支出趋势</h3>
    ${bars()}
    <h3>最大支出 Top 10</h3>
    <table class="tbl">
      <thead><tr><th style="width:34%">时间</th><th>商户 / 商品</th><th style="width:14%">分类</th><th class="r" style="width:16%">金额</th></tr></thead>
      <tbody>${top.map((t) => `<tr><td class="muted">${fmtTime(t.ts)}</td><td>${esc(t.merchant || '—')}${t.goods_name ? '<span class="muted"> · ' + esc(t.goods_name) + '</span>' : ''}</td><td>${esc(t.category || '未分类')}</td><td class="r red">${yuan(t.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">无</td></tr>'}</tbody>
    </table>
  </section>`

  const aiSection = blocks.ai && narrative ? `
  <section class="page-break">
    <h3>AI 消费分析</h3>
    <div class="quote">${esc(narrative).replace(/\n/g, '<br>')}</div>
  </section>` : ''

  const budgetSection = blocks.budget && (budgets.length || alts.length) ? `
  <section>
    ${budgets.length ? `<h3>预算执行</h3>${budgets.map((b) => {
      const pct = Math.min(100, Math.round((b.spent / b.limit) * 100))
      const over = b.spent > b.limit
      const overPct = over ? Math.round(((b.spent - b.limit) / b.limit) * 100) : 0
      return `<div class="bud"><span class="bud-name">${esc(b.category)}</span>
        <span class="bud-bar"><span class="bud-fill" style="width:${pct}%;background:${over ? '#FF375F' : '#30D158'}"></span></span>
        <span class="bud-val ${over ? 'red' : ''}">${yuan(b.spent)} / ¥${b.limit}${over ? ` ⚠超支 ${overPct}%` : ''}</span></div>`
    }).join('')}` : ''}
    ${alts.length ? `<h3>省钱与升级建议</h3>${alts.map((a) => `<div class="alt"><b>${esc(a.product)}</b>${a.reason ? ` <span class="muted">（${esc(a.reason)}）</span>` : ''}${a.cheaperText ? `<div class="alt-line"><span class="tag green">省钱</span>${esc(a.cheaperText).replace(/\n/g, '<br>')}</div>` : ''}${a.betterText ? `<div class="alt-line"><span class="tag blue">升级</span>${esc(a.betterText).replace(/\n/g, '<br>')}</div>` : ''}</div>`).join('')}` : ''}
  </section>` : ''

  // 替换说明：商家名被改写后，告诉读者"原是谁、现在记成谁"，避免看不出来源
  const applied = Array.isArray(meta.appliedReplaces) ? meta.appliedReplaces : []
  const replaceSection = applied.length ? `
  <section class="repl">
    <h3>已按偏好替换商家 <span class="muted" style="font-weight:400">（下列账单的商家名已改写）</span></h3>
    <table class="tbl">
      <thead><tr><th style="width:56%">替换规则</th><th style="width:14%">笔数</th><th class="r">金额</th></tr></thead>
      <tbody>
        ${applied.map((a) => `<tr><td>${esc(a.label || ('「' + a.from + '」 → 「' + a.to + '」'))}</td><td class="muted">${a.count} 笔</td><td class="r">${yuan(a.amount)}</td></tr>`).join('')}
        <tr><td class="muted">合计</td><td class="muted">${applied.reduce((s, a) => s + a.count, 0)} 笔</td><td class="r">${yuan(applied.reduce((s, a) => s + a.amount, 0))}</td></tr>
      </tbody>
    </table>
  </section>` : ''

  // 已剔除说明：让报告自证口径（剔了谁、多少笔、多少钱），便于事后对账
  const exRules = normalizeRules(meta.excludeRules || [])
  const excluded = Array.isArray(meta.excluded) ? meta.excluded : []
  const excludeSection = excluded.length ? `
  <section class="excl">
    <h3>已按偏好剔除 <span class="muted" style="font-weight:400">（以下账单未计入本报告统计）</span></h3>
    <table class="tbl">
      <thead><tr><th style="width:40%">剔除规则</th><th style="width:14%">笔数</th><th class="r">金额</th></tr></thead>
      <tbody>
        ${exRules.map((r) => {
          const hit = excluded.filter((e) => e._ruleId === r.id)
          if (!hit.length) return ''
          const amt = hit.reduce((s, e) => s + Math.abs(Number(e.amount) || 0), 0)
          return `<tr><td>${esc(ruleLabel(r))}</td><td class="muted">${hit.length} 笔</td><td class="r red">${yuan(amt)}</td></tr>`
        }).join('')}
        <tr><td class="muted">合计</td><td class="muted">${excluded.length} 笔</td><td class="r red">${yuan(excluded.reduce((s, e) => s + Math.abs(Number(e.amount) || 0), 0))}</td></tr>
      </tbody>
    </table>
  </section>` : ''

  const detailSection = blocks.detail ? `
  <section class="page-break">
    <h3>逐笔明细（共 ${rows.length} 笔）</h3>
    <table class="tbl dense">
      <thead><tr><th style="width:22%">时间</th><th>商户 / 商品</th><th style="width:12%">分类</th><th style="width:11%">账户</th><th class="r" style="width:15%">金额</th></tr></thead>
      <tbody>${rows.map((t) => `<tr><td class="muted">${fmtTime(t.ts).slice(0, 16)}</td><td>${esc(t.merchant || '—')}${t.goods_name ? '<span class="muted"> · ' + esc(t.goods_name) + '</span>' : ''}</td><td>${esc(t.category || '未分类')}</td><td class="muted">${esc(ACCOUNT_LABEL[t.account] || t.account || '')}</td><td class="r ${t.direction === 'expense' ? 'red' : 'green'}">${yuan(t.amount)}</td></tr>`).join('')}</tbody>
    </table>
  </section>` : ''

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>PennyWise 账单分析报告</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1D1D1F; margin: 0; background: #fff; font-size: 12px; line-height: 1.6; }
  .page-break { page-break-before: always; }
  header.hero { border-bottom: 3px solid #0A84FF; padding-bottom: 14px; margin-bottom: 20px; }
  .hero h1 { margin: 0; font-size: 25px; letter-spacing: -.4px; }
  .hero .sub { color: #6E6E73; font-size: 12.5px; margin-top: 6px; }
  .chips { margin-top: 9px; }
  .chip { display: inline-block; background: #F5F5F7; color: #3A3A3C; border-radius: 20px; padding: 3px 11px; font-size: 11px; margin-right: 6px; }
  h3 { font-size: 14px; color: #1D1D1F; margin: 22px 0 10px; padding-left: 9px; border-left: 3px solid #0A84FF; }
  .cards { display: flex; gap: 10px; }
  .card { flex: 1; background: #F5F5F7; border-radius: 12px; padding: 13px 15px; }
  .c-k { color: #6E6E73; font-size: 11px; }
  .c-v { font-size: 20px; font-weight: 700; margin: 3px 0 1px; letter-spacing: -.5px; }
  .c-s { color: #86868B; font-size: 10.5px; }
  .red { color: #D70015; } .green { color: #1D8A3E; } .muted { color: #86868B; } .r { text-align: right; }
  .donut-wrap { display: flex; align-items: center; gap: 26px; }
  .legend { flex: 1; }
  .lg-row { display: flex; align-items: center; font-size: 11.5px; padding: 3.5px 0; border-bottom: 1px solid #F2F2F7; }
  .lg-row .dot { width: 9px; height: 9px; border-radius: 3px; margin-right: 8px; flex: none; }
  .lg-name { flex: 1; color: #3A3A3C; }
  .lg-pct { width: 52px; text-align: right; color: #86868B; }
  .lg-amt { width: 78px; text-align: right; font-weight: 600; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .tbl th { text-align: left; color: #6E6E73; font-weight: 600; font-size: 10.5px; padding: 6px 7px; border-bottom: 1.5px solid #E5E5EA; }
  .tbl td { padding: 6px 7px; border-bottom: 1px solid #F2F2F7; }
  .tbl.dense td, .tbl.dense th { padding: 4px 6px; font-size: 10.5px; }
  .quote { background: #F5F5F7; border-left: 3px solid #30D158; border-radius: 0 10px 10px 0; padding: 13px 16px; line-height: 1.85; font-size: 12.5px; }
  .bud { display: flex; align-items: center; font-size: 11.5px; margin: 7px 0; }
  .bud-name { width: 76px; flex: none; }
  .bud-bar { flex: 1; height: 13px; background: #F2F2F7; border-radius: 7px; overflow: hidden; margin: 0 10px; }
  .bud-fill { display: block; height: 13px; border-radius: 7px; }
  .bud-val { width: 168px; text-align: right; flex: none; font-weight: 600; }
  .alt { background: #FAFAFC; border: 1px solid #F2F2F7; border-radius: 10px; padding: 10px 13px; margin: 8px 0; }
  .alt-line { margin-top: 6px; line-height: 1.7; }
  .tag { display: inline-block; border-radius: 5px; padding: 1px 6px; font-size: 10px; margin-right: 6px; }
  .tag.green { background: #E8F8EE; color: #1D8A3E; }
  .tag.blue { background: #E9F2FF; color: #0A5BD3; }
  footer { margin-top: 26px; padding-top: 11px; border-top: 1px solid #E5E5EA; color: #86868B; font-size: 10.5px; display: flex; justify-content: space-between; }
  .excl { background: #FFF8F0; border: 1px solid #FFE0B2; border-radius: 10px; padding: 8px 14px 12px; }
  .excl h3 { border-left-color: #E8890C; margin-top: 10px; }
  .repl { background: #F0F7FF; border: 1px solid #C7E0FF; border-radius: 10px; padding: 8px 14px 12px; margin-bottom: 14px; }
  .repl h3 { border-left-color: #0A84FF; margin-top: 10px; }
</style></head><body>
<header class="hero">
  <h1>💰 PennyWise 账单分析报告</h1>
  <div class="sub">${esc(rangeLabel)} · 生成于 ${fmtTime(new Date().toISOString())}</div>
  <div class="chips">${chip('范围：' + rangeLabel)}${chip('渠道：' + (meta.channelLabel || '全部'))}${chip('分类：' + (meta.category || '全部'))}${chip('共 ' + s.count + ' 笔')}${applied.length ? chip('已替换 ' + applied.reduce((x, a) => x + a.count, 0) + ' 笔') : ''}${excluded.length ? chip('已剔除 ' + excluded.length + ' 笔') : ''}</div>
</header>
${replaceSection}
${excludeSection}
${overview}
${aiSection}
${budgetSection}
${detailSection}
<footer><span>PennyWise 自动生成</span><span>数据来源：本地账本（微信 / 支付宝账单导入）</span></footer>
</body></html>`
}

// ---- HTML → PDF：复用本机 Edge（与 scripts/audit-layout.mjs 同一套路，零新增依赖）----
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
export function findBrowser() {
  for (const p of EDGE_CANDIDATES) { try { if (fs.existsSync(p)) return p } catch { /* 继续找 */ } }
  return ''
}
export async function htmlToPdf(html) {
  const exe = findBrowser()
  if (!exe) throw new Error('未找到 Edge/Chrome，无法生成 PDF（可手动打开网页版报告后打印为 PDF）')
  const puppeteer = (await import('puppeteer-core')).default
  // 报告 HTML 全是内联资源（SVG/CSS），不需要等外部网络。
  // 用 domcontentloaded + 显式给足超时，避免大报告在默认 30s 导航超时上偶发失败。
  const render = async () => {
    const browser = await puppeteer.launch({
      executablePath: exe, headless: 'new',
      args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-extensions', '--disable-background-networking'],
    })
    try {
      const page = await browser.newPage()
      page.setDefaultNavigationTimeout(60000)
      page.setDefaultTimeout(60000)
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 })
      // 等字体就绪，保证中文排版稳定（失败也不阻塞）
      await page.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready : null)).catch(() => {})
      const buf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } })
      return Buffer.from(buf)
    } finally { await browser.close() }
  }
  try {
    return await render()
  } catch (e1) {
    // 偶发的浏览器启动/渲染抖动：清场后重试一次（复用同一份 HTML，不重跑统计与 AI）
    await new Promise((r) => setTimeout(r, 1200))
    try { return await render() }
    catch (e2) { throw new Error(`PDF 渲染失败：${e2?.message || e1?.message || '未知错误'}`) }
  }
}

// ---- 月度支出趋势（给月报/导出复用）----
export function monthlyExpenseTrend(from, to, channel, category) {
  const rows = queryRows({ from, to, channel, category })
  const g = new Map()
  for (const r of rows) {
    if (r.direction !== 'expense') continue
    const m = String(r.ts).slice(0, 7)
    g.set(m, (g.get(m) || 0) + Math.abs(Number(r.amount) || 0))
  }
  return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, expense]) => ({ month, expense }))
}

// ---- 预算执行（某月各分类预算 vs 实际）----
export function budgetExecution(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return []
  const rows = db.prepare('SELECT category, limit_amount FROM budgets WHERE month = ? ORDER BY category').all(month)
  return rows.map((b) => {
    const spent = Number(db.prepare(
      "SELECT SUM(amount) s FROM transactions WHERE ts LIKE ? AND status='confirmed' AND direction='expense' AND category = ?"
    ).get(month + '%', b.category)?.s ?? 0)
    return { category: b.category, limit: Number(b.limit_amount), spent }
  })
}

// ================= 导出偏好（持久化在 meta 表）=================
// 存的不只是排除规则，还有上次的筛选/区块勾选，下次打开导出页直接复用。
const PREF_KEY = 'export_prefs'

const DEFAULT_PREFS = {
  excludeRules: [],    // 剔除规则数组
  excludeOn: true,     // 剔除总开关
  replaceRules: [],    // 替换规则数组（把某些商家的账单换成别的商家）
  replaceOn: true,     // 替换总开关
  channel: 'all',
  category: '',
  range: 'all',
  month: '',
  from: '',
  to: '',
  blocks: { charts: true, ai: false, budget: true, detail: false },
}

export function getExportPrefs() {
  try {
    const raw = db.prepare('SELECT v FROM meta WHERE k = ?').get(PREF_KEY)?.v
    const saved = raw ? JSON.parse(raw) : {}
    return {
      ...DEFAULT_PREFS,
      ...saved,
      blocks: { ...DEFAULT_PREFS.blocks, ...(saved.blocks || {}) },
      excludeRules: normalizeRules(saved.excludeRules),
      excludeOn: saved.excludeOn === undefined ? true : Boolean(saved.excludeOn),
      replaceRules: normalizeReplaces(saved.replaceRules),
      replaceOn: saved.replaceOn === undefined ? true : Boolean(saved.replaceOn),
    }
  } catch {
    return {
      ...DEFAULT_PREFS,
      blocks: { ...DEFAULT_PREFS.blocks },
      excludeRules: [], replaceRules: [],
    }
  }
}

export function saveExportPrefs(patch = {}) {
  const cur = getExportPrefs()
  const next = {
    ...cur,
    ...patch,
    blocks: { ...cur.blocks, ...(patch.blocks || {}) },
    excludeRules: patch.excludeRules !== undefined ? normalizeRules(patch.excludeRules) : cur.excludeRules,
    replaceRules: patch.replaceRules !== undefined ? normalizeReplaces(patch.replaceRules) : cur.replaceRules,
  }
  db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(PREF_KEY, JSON.stringify(next))
  return next
}

// 商家清单（供前端做排除规则的下拉/自动补全）：出现次数 + 累计支出，按笔数倒序
export function listMerchants({ q = '', limit = 300 } = {}) {
  const rows = db.prepare(`
    SELECT merchant,
           COUNT(*) AS n,
           SUM(CASE WHEN direction = 'expense' THEN amount ELSE 0 END) AS expense
    FROM transactions
    WHERE status = 'confirmed' AND merchant IS NOT NULL AND merchant <> ''
    GROUP BY merchant
    ORDER BY n DESC
  `).all()
  const kw = String(q || '').trim().toLowerCase()
  const out = kw ? rows.filter((r) => String(r.merchant).toLowerCase().includes(kw)) : rows
  return out.slice(0, limit).map((r) => ({ merchant: r.merchant, n: r.n, expense: Number(r.expense) || 0 }))
}

export { currentMonth, getCategories }
