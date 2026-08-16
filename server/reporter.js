import { db } from './db.js'
import { env } from './env.js'
import { llmConfig } from './llm.js'
import { analyzeBillForAlternatives } from './recommend.js'
import nodemailer from 'nodemailer'

// ================= 月度报告（邮箱 / Server酱微信推送） =================

export function mailerConfig() {
  return {
    enabled: Boolean(env('SMTP_HOST')) && Boolean(env('SMTP_USER')) && Boolean(env('SMTP_PASS')),
    host: env('SMTP_HOST', ''),
    port: Number(env('SMTP_PORT', '465')) || 465,
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
    to: env('MAIL_TO', env('SMTP_USER', '')),
  }
}

export function serverChanKey() {
  return env('SERVERCHAN_KEY', '')
}

function monthLabel(month) {
  const [y, m] = String(month).split('-').map(Number)
  return `${y}年${m}月`
}

function money(n) {
  return (n >= 0 ? '+' : '') + '¥' + Number(n).toFixed(2)
}

// 汇总某月数据
export function summarizeMonth(month) {
  const like = month + '%'
  const base = "FROM transactions WHERE ts LIKE ? AND status = 'confirmed' AND amount IS NOT NULL"
  const sum = (extra) => Number(db.prepare(`SELECT SUM(amount) AS s ${base} ${extra}`).get(like)?.s ?? 0)
  const income = sum("AND direction = 'income'")
  const expense = sum("AND direction = 'expense'")
  const refund = sum("AND direction = 'refund'")
  const transfer = sum("AND direction = 'transfer'")
  const count = Number(db.prepare(`SELECT COUNT(*) AS n ${base}`).get(like)?.n ?? 0)
  const byCategory = db.prepare(`
    SELECT category AS name, SUM(amount) AS total, COUNT(*) AS n ${base} AND direction = 'expense'
    GROUP BY category ORDER BY total DESC
  `).all(like).map((r) => ({ name: r.name, total: Number(r.total), n: Number(r.n) }))
  const topExpenses = db.prepare(`
    SELECT merchant, goods_name, amount, category ${base} AND direction = 'expense' ORDER BY amount DESC LIMIT 5
  `).all(like)
  const incomes = db.prepare(`
    SELECT merchant, note, amount ${base} AND direction = 'income' ORDER BY amount DESC LIMIT 5
  `).all(like)
  const pendingCount = Number(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending'").get()?.n ?? 0)
  // 环比：上月支出
  const [y, m] = String(month).split('-').map(Number)
  const prev = new Date(Date.UTC(y, m - 2, 1))
  const prevKey = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
  const prevExpense = sum2(prevKey, "AND direction = 'expense'")
  function sum2(key, extra) {
    return Number(db.prepare(`SELECT SUM(amount) AS s FROM transactions WHERE ts LIKE ? AND status = 'confirmed' AND amount IS NOT NULL ${extra}`).get(key + '%')?.s ?? 0)
  }
  return {
    month, income: Math.round(income * 100) / 100, expense: Math.round(expense * 100) / 100,
    refund, transfer, balance: Math.round((income + refund - expense) * 100) / 100,
    count, byCategory, topExpenses, incomes, pendingCount,
    prevExpense, diffPct: prevExpense > 0 ? Math.round(((expense - prevExpense) / prevExpense) * 100) : null,
  }
}

// 账单是否超过 35 天未导入（月报中提醒）
export function billImportStale() {
  const last = db.prepare("SELECT v FROM meta WHERE k = 'last_bill_import'").get()?.v
  if (!last) return true
  const t = Date.parse(last)
  if (Number.isNaN(t)) return true
  return Date.now() - t > 35 * 24 * 3600 * 1000
}

// LLM 撰写月报分析（数据 → 洞察；模型不可用时返回空，回退模板报告）
export async function generateReportNarrative(s) {
  const cfg = llmConfig()
  if (!cfg.enabled) return ''
  const data = JSON.stringify({
    月: s.month, 收入: s.income, 支出: s.expense, 退款: s.refund, 结余: s.balance, 笔数: s.count,
    支出分类: (s.byCategory || []).slice(0, 6).map((c) => `${c.name} ${c.total}(${c.n}笔)`),
    最大支出: (s.topExpenses || []).slice(0, 3).map((t) => `${t.merchant} ${t.amount}`),
    收入明细: (s.incomes || []).slice(0, 3).map((t) => `${t.merchant} ${t.amount}`),
    上月支出: s.prevExpense, 环比: s.diffPct, 待处理: s.pendingCount,
  })
  const sys = '你是个人财务分析助手。根据给出的月度数据写一段 120-200 字的简体中文分析：①本月亮点与问题；②最值得关注的一两处（最大支出、异常分类、环比变化）；③一条切实可行的建议。语气亲切专业，不重复罗列全部数据。'
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: data }],
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(45000),
    })
    if (!res.ok) return ''
    const j = await res.json()
    return String(j?.choices?.[0]?.message?.content || '').trim().slice(0, 600)
  } catch { return '' }
}

const BILL_REMINDER = '微信/支付宝账单已超过 35 天未导入。支付宝可在 App 里开启"每月自动发送账单到邮箱"（设置一次永久自动）；微信账单请每月在 微信 → 我 → 服务 → 钱包 → 账单 → 下载账单 手动发送到邮箱（发送后自动入库，无需其他操作）。'

export function buildReportText(s, narrative = '', alts = []) {
  const lines = []
  lines.push(`PennyWise 月度报告 · ${monthLabel(s.month)}`)
  lines.push('━━━━━━━━━━━━━━━━')
  lines.push(`总收入  ${money(s.income)}（${s.count} 笔确认记录）`)
  lines.push(`总支出  ${money(-s.expense)}`)
  if (s.refund > 0) lines.push(`退款    ${money(s.refund)}`)
  lines.push(`结余    ${money(s.balance)}`)
  if (s.diffPct !== null) lines.push(`支出环比  ${s.diffPct > 0 ? '↑' : '↓'}${Math.abs(s.diffPct)}%（上月 ${money(-s.prevExpense)}）`)
  if (s.pendingCount > 0) lines.push(`待处理  ${s.pendingCount} 条`)
  if (narrative) {
    lines.push('')
    lines.push('📝 AI 分析')
    lines.push(narrative)
  }
  if (alts.length) {
    lines.push('')
    lines.push('🛒 省钱与升级建议（根据你的账单）')
    alts.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.product}${a.reason ? '（' + a.reason + '）' : ''}`)
      if (a.cheaperText) {
        lines.push('  💰 更便宜：')
        lines.push(a.cheaperText)
      }
      if (a.betterText) {
        lines.push('  ⬆️ 更好的：')
        lines.push(a.betterText)
      }
    })
  }
  lines.push('')
  if (s.byCategory.length) {
    lines.push('支出分类 TOP：')
    s.byCategory.slice(0, 6).forEach((c, i) => lines.push(`  ${i + 1}. ${c.name}  ${money(-c.total)}（${c.n} 笔）`))
    lines.push('')
  }
  if (s.topExpenses.length) {
    lines.push('最大支出：')
    s.topExpenses.forEach((t, i) => lines.push(`  ${i + 1}. ${money(-t.amount)}  ${t.merchant || ''}${t.goods_name ? '（' + t.goods_name + '）' : ''}`))
    lines.push('')
  }
  if (s.incomes.length) {
    lines.push('收入明细：')
    s.incomes.forEach((t) => lines.push(`  ${money(t.amount)}  ${t.merchant || ''}${t.note ? '（' + t.note + '）' : ''}`))
    lines.push('')
  }
  if (billImportStale()) {
    lines.push('⚠ 提醒：' + BILL_REMINDER)
    lines.push('')
  }
  lines.push('—— PennyWise 自动生成')
  return lines.join('\n')
}

export function buildReportHtml(s, narrative = '', alts = []) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const catRows = s.byCategory.slice(0, 6).map((c) => `<tr><td>${esc(c.name)}</td><td>${money(-c.total)}</td><td>${c.n} 笔</td></tr>`).join('')
  const topRows = s.topExpenses.map((t) => `<tr><td>${money(-t.amount)}</td><td>${esc(t.merchant || '')}${t.goods_name ? '（' + esc(t.goods_name) + '）' : ''}</td><td>${esc(t.category || '')}</td></tr>`).join('')
  const incRows = s.incomes.map((t) => `<tr><td>${money(t.amount)}</td><td>${esc(t.merchant || '')}${t.note ? '（' + esc(t.note) + '）' : ''}</td></tr>`).join('')
  const diff = s.diffPct !== null ? `<p>支出环比：<b>${s.diffPct > 0 ? '↑' : '↓'}${Math.abs(s.diffPct)}%</b>（上月 ${money(-s.prevExpense)}）</p>` : ''
  const reminder = billImportStale()
    ? `<p style="background:#2a2410;border:1px solid #f59e0b55;color:#fbbf24;border-radius:8px;padding:10px 12px;font-size:13px">⚠ ${esc(BILL_REMINDER)}</p>`
    : ''
  const aiSection = narrative
    ? `<div style="background:#12231a;border:1px solid #22c55e55;border-radius:8px;padding:12px 14px;margin:12px 0"><div style="color:#22c55e;font-size:12px;font-weight:700;margin-bottom:6px">📝 AI 分析</div><div style="font-size:14px;line-height:1.7">${esc(narrative).replace(/\n/g, '<br>')}</div></div>`
    : ''
  const altSection = alts.length
    ? `<div style="background:#1a1626;border:1px solid #a855f755;border-radius:8px;padding:12px 14px;margin:12px 0"><div style="color:#c084fc;font-size:12px;font-weight:700;margin-bottom:8px">🛒 省钱与升级建议（根据你的账单）</div>${alts.map((a) => `<div style="margin-bottom:12px;font-size:14px"><b>${esc(a.product)}</b>${a.reason ? ` <span style="color:#8b93a5;font-size:12px">（${esc(a.reason)}）</span>` : ''}${a.cheaperText ? `<div style="margin-top:4px;line-height:1.7"><span style="color:#22c55e">💰 更便宜</span><br>${esc(a.cheaperText).replace(/\n/g, '<br>')}</div>` : ''}${a.betterText ? `<div style="margin-top:6px;line-height:1.7"><span style="color:#38bdf8">⬆️ 更好的</span><br>${esc(a.betterText).replace(/\n/g, '<br>')}</div>` : ''}</div>`).join('')}</div>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:#0f1115;color:#e8eaf0;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#171a21;border-radius:12px;padding:24px;border:1px solid #2a2f3a">
<h2 style="margin:0 0 4px">💰 PennyWise 月度报告 · ${monthLabel(s.month)}</h2>
<div style="display:flex;gap:12px;margin:16px 0;flex-wrap:wrap">
  <div style="flex:1;min-width:120px"><div style="color:#8b93a5;font-size:12px">收入</div><div style="color:#22c55e;font-size:18px;font-weight:700">${money(s.income)}</div></div>
  <div style="flex:1;min-width:120px"><div style="color:#8b93a5;font-size:12px">支出</div><div style="color:#ef4444;font-size:18px;font-weight:700">${money(-s.expense)}</div></div>
  <div style="flex:1;min-width:120px"><div style="color:#8b93a5;font-size:12px">结余</div><div style="font-size:18px;font-weight:700">${money(s.balance)}</div></div>
</div>
${diff}
${reminder}
${aiSection}
${altSection}
<h3 style="font-size:14px;color:#8b93a5;margin:16px 0 8px">支出分类</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px">${catRows || '<tr><td>本月暂无支出</td></tr>'}</table>
<h3 style="font-size:14px;color:#8b93a5;margin:16px 0 8px">最大支出</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px">${topRows || '<tr><td>无</td></tr>'}</table>
<h3 style="font-size:14px;color:#8b93a5;margin:16px 0 8px">收入明细</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px">${incRows || '<tr><td>无</td></tr>'}</table>
<p style="color:#8b93a5;font-size:12px;margin-top:20px">—— PennyWise 自动生成 · 共 ${s.count} 笔确认记录${s.pendingCount ? ' · 待处理 ' + s.pendingCount + ' 条' : ''}</p>
</div></body></html>`
}

export async function sendEmail(subject, html) {
  const cfg = mailerConfig()
  if (!cfg.enabled) return { ok: false, error: '未配置 SMTP（SMTP_HOST/SMTP_USER/SMTP_PASS）' }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  })
  try {
    await transporter.sendMail({ from: cfg.user, to: cfg.to, subject, html })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) }
  }
}

export async function sendServerChan(title, text) {
  const key = serverChanKey()
  if (!key) return { ok: false, error: '未配置 SERVERCHAN_KEY' }
  try {
    const res = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, desp: text }),
      signal: AbortSignal.timeout(15000),
    })
    const j = await res.json().catch(() => null)
    if (!res.ok || (j && j.code !== 0)) return { ok: false, error: String(j?.message || res.status).slice(0, 100) }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 100) }
  }
}

// 发送某月报告到所有已配置渠道（LLM 撰写分析 + 账单驱动的平替推荐，失败自动回退模板）
export async function sendMonthlyReport(month) {
  const s = summarizeMonth(month)
  const narrative = await generateReportNarrative(s)
  const alts = await analyzeBillForAlternatives(month)
  const title = `PennyWise 月报 · ${monthLabel(month)}`
  const channels = []
  const email = await sendEmail(title, buildReportHtml(s, narrative, alts))
  channels.push({ name: 'email', ...email })
  const chan = await sendServerChan(title, buildReportText(s, narrative, alts))
  channels.push({ name: 'serverchan', ...chan })
  return { summary: s, channels, sent: channels.filter((c) => c.ok).length }
}