import { db } from './db.js'
import { env } from './env.js'
import { llmChain } from './llm.js'
import { analyzeBillForAlternatives } from './recommend.js'
// nodemailer 改为 sendEmail 内动态加载：只有真发信才需要，冷启动不再背着它

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
  // 预算执行（借鉴 Firefly/Actual）
  const budgets = db.prepare(`
    SELECT b.category, b.limit_amount AS lim, COALESCE(SUM(t.amount), 0) AS spent
    FROM budgets b LEFT JOIN transactions t
      ON t.category = b.category AND t.direction = 'expense' AND t.status = 'confirmed'
      AND t.ts LIKE ? AND t.amount IS NOT NULL
    WHERE b.month = ?
    GROUP BY b.category, b.limit_amount ORDER BY b.category
  `).all(like, month)
    .map((r) => ({ category: r.category, limit: Number(r.lim), spent: Math.round(Number(r.spent) * 100) / 100 }))
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
    count, byCategory, topExpenses, incomes, pendingCount, budgets,
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
  const chain = llmChain()
  if (!chain.length) return ''
  const data = JSON.stringify({
    月: s.month, 收入: s.income, 支出: s.expense, 退款: s.refund, 结余: s.balance, 笔数: s.count,
    支出分类: (s.byCategory || []).slice(0, 6).map((c) => `${c.name} ${c.total}(${c.n}笔)`),
    最大支出: (s.topExpenses || []).slice(0, 3).map((t) => `${t.merchant} ${t.amount}`),
    收入明细: (s.incomes || []).slice(0, 3).map((t) => `${t.merchant} ${t.amount}`),
    上月支出: s.prevExpense, 环比: s.diffPct, 未确认: s.pendingCount,
    预算执行: (s.budgets || []).map((b) => `${b.category} ${b.spent}/${b.limit}${b.spent > b.limit ? '超支' : ''}`),
  })
  const sys = '你是个人财务分析助手。根据给出的月度数据写一段 120-200 字的简体中文分析：①本月亮点与问题；②最值得关注的一两处（最大支出、异常分类、环比变化）；③一条切实可行的建议。语气亲切专业，不重复罗列全部数据。'
  for (const p of chain) {
    try {
      const res = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: data }],
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(45000),
      })
      if (!res.ok) continue
      const j = await res.json()
      const txt = String(j?.choices?.[0]?.message?.content || '').trim().slice(0, 600)
      if (txt) return txt
    } catch { /* 换下一个模型 */ }
  }
  return ''
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
  if (s.pendingCount > 0) lines.push(`未确认  ${s.pendingCount} 条`)
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
  if (s.budgets && s.budgets.length) {
    lines.push('')
    lines.push('📋 预算执行')
    s.budgets.forEach((b) => {
      const over = b.spent > b.limit
      lines.push(`  ${over ? '⚠' : '✓'} ${b.category}  ${money(-b.spent)} / ¥${b.limit}（${over ? '超支 ' + money(b.spent - b.limit) : '剩余 ' + money(b.limit - b.spent)}）`)
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

// 近 N 个月支出趋势（月报柱状图数据）
export function monthlyTrend(month, n = 6) {
  const [y, m] = String(month).split('-').map(Number)
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const expense = Number(db.prepare("SELECT SUM(amount) AS s FROM transactions WHERE ts LIKE ? AND status = 'confirmed' AND amount IS NOT NULL AND direction = 'expense'").get(key + '%')?.s ?? 0)
    out.push({ key, label: `${d.getUTCMonth() + 1}月`, expense: Math.round(expense * 100) / 100, isCurrent: key === month })
  }
  return out
}

const BAR_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d']

// 纯 CSS 水平条形图（邮件客户端不支持 JS，图表用 div 绘制；浅色主题）
function categoryBarsHtml(s) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const max = s.byCategory[0]?.total || 1
  return s.byCategory.slice(0, 8).map((c, i) => {
    const pct = Math.max(4, Math.round((c.total / max) * 100))
    return `<div style="display:flex;align-items:center;margin:7px 0;font-size:12px">
      <div style="width:66px;color:#374151;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:none">${esc(c.name)}</div>
      <div style="flex:1;background:#eef1f5;border-radius:4px;height:14px;overflow:hidden">
        <div style="width:${pct}%;height:14px;background:${BAR_COLORS[i % BAR_COLORS.length]};border-radius:4px"></div>
      </div>
      <div style="width:86px;text-align:right;color:#111827;flex:none;font-variant-numeric:tabular-nums;font-weight:600">${money(-c.total)} <span style="color:#6b7280;font-size:10px;font-weight:400">${c.n}笔</span></div>
    </div>`
  }).join('')
}

// 纯 CSS 垂直柱状图（近 6 个月支出趋势；浅色主题）
function trendBarsHtml(months) {
  const max = Math.max(...months.map((m) => m.expense), 1)
  return `<div style="display:flex;align-items:flex-end;gap:8px;height:130px;padding:10px 4px 0">
    ${months.map((m) => {
      const h = Math.max(5, Math.round((m.expense / max) * 88))
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0">
        <div style="font-size:10px;color:#6b7280;margin-bottom:2px;white-space:nowrap">${m.expense > 0 ? Math.round(m.expense) : ''}</div>
        <div style="width:62%;max-width:36px;background:${m.isCurrent ? '#2563eb' : '#dbe4f3'};border-radius:4px 4px 0 0;height:${h}%"></div>
        <div style="font-size:10px;color:${m.isCurrent ? '#2563eb' : '#6b7280'};margin-top:4px;font-weight:${m.isCurrent ? '700' : '400'}">${m.label}</div>
      </div>`
    }).join('')}
  </div>`
}

export function buildReportHtml(s, narrative = '', alts = []) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const topRows = s.topExpenses.map((t) => `<tr><td style="padding:3px 0;color:#111827">${money(-t.amount)}</td><td style="padding:3px 0;color:#111827">${esc(t.merchant || '')}${t.goods_name ? '（' + esc(t.goods_name) + '）' : ''}</td><td style="padding:3px 0;color:#6b7280">${esc(t.category || '')}</td></tr>`).join('')
  const incRows = s.incomes.map((t) => `<tr><td style="padding:3px 0;color:#111827">${money(t.amount)}</td><td style="padding:3px 0;color:#111827">${esc(t.merchant || '')}${t.note ? '（' + esc(t.note) + '）' : ''}</td></tr>`).join('')
  const diff = s.diffPct !== null ? `<p style="color:#374151">支出环比：<b>${s.diffPct > 0 ? '↑' : '↓'}${Math.abs(s.diffPct)}%</b>（上月 ${money(-s.prevExpense)}）</p>` : ''
  const reminder = billImportStale()
    ? `<p style="background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:8px;padding:10px 12px;font-size:13px">⚠ ${esc(BILL_REMINDER)}</p>`
    : ''
  const aiSection = narrative
    ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px;margin:12px 0"><div style="color:#166534;font-size:12px;font-weight:700;margin-bottom:6px">📝 AI 分析</div><div style="font-size:14px;line-height:1.7;color:#1f2937">${esc(narrative).replace(/\n/g, '<br>')}</div></div>`
    : ''
  const altSection = alts.length
    ? `<div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:12px 14px;margin:12px 0"><div style="color:#6d28d9;font-size:12px;font-weight:700;margin-bottom:8px">🛒 省钱与升级建议（根据你的账单）</div>${alts.map((a) => `<div style="margin-bottom:12px;font-size:14px;color:#1f2937"><b>${esc(a.product)}</b>${a.reason ? ` <span style="color:#6b7280;font-size:12px">（${esc(a.reason)}）</span>` : ''}${a.cheaperText ? `<div style="margin-top:4px;line-height:1.7"><span style="color:#15803d">💰 更便宜</span><br>${esc(a.cheaperText).replace(/\n/g, '<br>')}</div>` : ''}${a.betterText ? `<div style="margin-top:6px;line-height:1.7"><span style="color:#1d4ed8">⬆️ 更好的</span><br>${esc(a.betterText).replace(/\n/g, '<br>')}</div>` : ''}</div>`).join('')}</div>`
    : ''
  const budgetSection = (s.budgets && s.budgets.length)
    ? `<div style="margin:12px 0"><h3 style="font-size:14px;color:#374151;margin:0 0 8px">📋 预算执行</h3>${s.budgets.map((b) => {
        const pct = Math.min(100, Math.round((b.spent / b.limit) * 100))
        const over = b.spent > b.limit
        return `<div style="display:flex;align-items:center;margin:7px 0;font-size:12px">
        <div style="width:66px;color:#374151;flex:none">${esc(b.category)}</div>
        <div style="flex:1;background:#eef1f5;border-radius:4px;height:14px;overflow:hidden">
          <div style="width:${pct}%;height:14px;background:${over ? '#dc2626' : '#16a34a'};border-radius:4px"></div>
        </div>
        <div style="width:150px;text-align:right;color:${over ? '#b91c1c' : '#374151'};flex:none;font-weight:600">${money(-b.spent)} / ¥${b.limit} ${over ? '⚠超支' : '✓'}</div>
      </div>`
      }).join('')}</div>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:#f3f4f6;color:#111827;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
<h2 style="margin:0 0 4px;color:#111827">💰 PennyWise 月度报告 · ${monthLabel(s.month)}</h2>
<div style="display:flex;gap:12px;margin:16px 0;flex-wrap:wrap">
  <div style="flex:1;min-width:120px"><div style="color:#6b7280;font-size:12px">收入</div><div style="color:#15803d;font-size:18px;font-weight:700">${money(s.income)}</div></div>
  <div style="flex:1;min-width:120px"><div style="color:#6b7280;font-size:12px">支出</div><div style="color:#b91c1c;font-size:18px;font-weight:700">${money(-s.expense)}</div></div>
  <div style="flex:1;min-width:120px"><div style="color:#6b7280;font-size:12px">结余</div><div style="font-size:18px;font-weight:700;color:#111827">${money(s.balance)}</div></div>
</div>
${diff}
${reminder}
${aiSection}
${budgetSection}
${altSection}
<h3 style="font-size:14px;color:#374151;margin:16px 0 8px">📊 支出分类</h3>
${categoryBarsHtml(s)}
<h3 style="font-size:14px;color:#374151;margin:16px 0 8px">📈 近 6 个月支出趋势</h3>
${trendBarsHtml(monthlyTrend(s.month))}
<h3 style="font-size:14px;color:#374151;margin:16px 0 8px">最大支出</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px">${topRows || '<tr><td>无</td></tr>'}</table>
<h3 style="font-size:14px;color:#374151;margin:16px 0 8px">收入明细</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px">${incRows || '<tr><td>无</td></tr>'}</table>
<p style="color:#6b7280;font-size:12px;margin-top:20px">—— PennyWise 自动生成 · 共 ${s.count} 笔确认记录${s.pendingCount ? ' · 未确认 ' + s.pendingCount + ' 条' : ''}</p>
</div></body></html>`
}

export async function sendEmail(subject, html) {
  const cfg = mailerConfig()
  if (!cfg.enabled) return { ok: false, error: '未配置 SMTP（SMTP_HOST/SMTP_USER/SMTP_PASS）' }
  const nodemailer = (await import('nodemailer')).default
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