import { env } from './env.js'
import { currentMonth, nowIso, validTs } from './db.js'
import { summarizeMonth } from './reporter.js'
import { llmConfig } from './llm.js'
import { insertFieldsTx } from './capture-core.js'
import { recommendAlternatives } from './recommend.js'

// ================= 邮箱沟通 AI Agent（意图路由 + 字段提取 + 回复生成） =================

export function ledgerCtx() {
  const s = summarizeMonth(currentMonth())
  const budgets = (s.budgets || []).map((b) => `${b.category} ${b.spent}/${b.limit}${b.spent > b.limit ? '(超支)' : ''}`).join('、')
  return `本月支出 ¥${s.expense}，收入 ¥${s.income}，结余 ¥${s.balance}，共 ${s.count} 笔；支出分类：${(s.byCategory || []).slice(0, 5).map((c) => `${c.name}¥${c.total}(${c.n}笔)`).join('、') || '暂无'}；上月支出 ¥${s.prevExpense}${s.diffPct !== null ? `（环比${s.diffPct > 0 ? '+' : ''}${s.diffPct}%）` : ''}；预算执行：${budgets || '未设置'}`
}

const AGENT_SYSTEM = `你是 PennyWise 个人记账系统的 AI 助手，通过邮件与用户沟通。根据邮件内容判断意图并处理：

1. intent=record：内容是交易记录（微信/支付宝/银行通知、消费描述、转账等）→ 提取交易字段。字段规则：amount 只取实付金额（正数，最多两位小数，忽略余额/优惠）；direction 为 expense/income/refund/transfer（收款/入账→income，支付/消费→expense，退款→refund，转账→transfer）；merchant 去掉"收款方/付款方"前缀；goods_name 为商品名（没有则空字符串）；category 从 [餐饮,交通,购物,娱乐,学习,日用品,医疗,通讯,住宿,运动,生活缴费,人情,其他] 选最合适（支出类），收入/退款/转账填 null；account 为 wechat/alipay/bank/cash/other；ts 为 ISO 时间（无则 null）；confidence 为 0-1。
2. intent=recommend：想买某样东西/求平替/比价 → 不需要自己回答，只输出 intent=recommend，reply 可写"正在为你联网比价…"。
3. intent=ledger：询问自己的账目（花了多少/结余/分类/趋势等）→ 结合上下文中的数据直接回答，给出具体数字。
4. intent=chat：其他问题/闲聊/功能询问 → 直接友好回答。
5. 完全无法判断的交易内容按 chat 处理，引导用户补充金额或商户信息。

只输出一个 JSON 对象：{"intent":"record|recommend|ledger|chat","reply":"给用户的回复（简体中文，友好简洁）","fields":{record 意图时提供：amount,direction,merchant,goods_name,category,account,note,ts,confidence，其他意图为 null}}`

export async function agentRoute(text) {
  const cfg = llmConfig()
  if (!cfg.enabled) return { intent: 'chat', reply: 'AI 助手暂时不可用（未配置 LLM_API_KEY），请稍后再试。', fields: null }
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: AGENT_SYSTEM },
          { role: 'user', content: `我的账目情况：${ledgerCtx()}\n\n邮件内容：${String(text).slice(0, 3000)}` },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(45000),
    })
    if (!res.ok) return { intent: 'chat', reply: `AI 助手请求失败（HTTP ${res.status}），请稍后再试。`, fields: null }
    const j = await res.json()
    const content = String(j?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    const d = JSON.parse(content)
    return {
      intent: ['record', 'recommend', 'ledger', 'chat'].includes(d.intent) ? d.intent : 'chat',
      reply: String(d.reply || '').slice(0, 2000),
      fields: d.intent === 'record' && d.fields ? d.fields : null,
    }
  } catch (e) {
    return { intent: 'chat', reply: 'AI 助手暂时不可用：' + String(e?.message || e).slice(0, 80), fields: null }
  }
}

// 让 Agent 为截图识别结果写友好回复
export async function agentPhraseImageResult(summary) {
  const cfg = llmConfig()
  if (!cfg.enabled) return ''
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: '你是 PennyWise 记账助手，用户刚通过邮件发来一张支付截图。根据识别结果给用户一句友好简短的确认回复（简体中文，40 字以内）。' },
          { role: 'user', content: String(summary).slice(0, 800) },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return ''
    const j = await res.json()
    return String(j?.choices?.[0]?.message?.content || '').trim().slice(0, 200)
  } catch { return '' }
}

// 供推荐使用的联网搜索可用性
export function recommendEnabled() {
  return Boolean(env('VISION_API_KEY'))
}

// 网页聊天 / 邮箱共用的 Agent 处理：路由 → 记账 / 联网推荐 / 直接回答
export async function agentChat(text, threshold) {
  const q = String(text || '').trim()
  if (!q) return { kind: 'empty', reply: '把交易文本发给我就能记账；也可以问"这个月花了多少"、"餐饮花了多少"，或"想买 XX，有平替推荐吗"。' }
  const route = await agentRoute(q)
  if (route.intent === 'record' && route.fields) {
    const f = route.fields
    const fields = {
      ts: validTs(f.ts) || nowIso(),
      amount: Number(f.amount) > 0 ? Math.round(Number(f.amount) * 100) / 100 : null,
      direction: ['expense', 'income', 'refund', 'transfer'].includes(f.direction) ? f.direction : 'expense',
      merchant: String(f.merchant || '').trim().slice(0, 120),
      goods_name: String(f.goods_name || '').trim().slice(0, 120),
      category: f.direction === 'expense' ? String(f.category || '其他').trim().slice(0, 20) : null,
      account: ['wechat', 'alipay', 'bank', 'cash', 'other'].includes(f.account) ? f.account : 'other',
      note: String(f.note || '').trim().slice(0, 200),
      confidence: Number.isFinite(Number(f.confidence)) ? Math.min(1, Math.max(0, Number(f.confidence))) : null,
    }
    if (fields.amount == null) {
      return { kind: 'record_fail', reply: route.reply || '没能从内容里确认金额，请补充金额后再发一次。' }
    }
    const { status } = insertFieldsTx(fields, q, null, 'chat', threshold)
    const tail = status === 'confirmed' ? '已自动入账 ✓' : '已记入待处理'
    return { kind: 'record', reply: `${route.reply || '已记账'}（${tail}）` }
  }
  if (route.intent === 'recommend') {
    const r = await recommendAlternatives(q)
    return { kind: 'recommend', reply: r.text }
  }
  return { kind: route.intent || 'chat', reply: route.reply || '收到。' }
}
