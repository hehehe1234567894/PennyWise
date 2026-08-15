import { env } from './env.js'

export function llmConfig() {
  const base = env('LLM_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, '')
  const apiKey = env('LLM_API_KEY')
  const model = env('LLM_MODEL', 'deepseek-chat')
  return { base, apiKey, model, enabled: Boolean(apiKey) }
}

export const SYSTEM_PROMPT = `你是"PennyWise"个人记账系统的交易解析器。用户会把微信/支付宝/银行卡的交易通知或一句话描述发给你。你只输出一个 JSON 对象，不要输出任何其他文字、解释或代码块标记。
字段说明：
- amount: 交易金额（人民币元，正数，最多两位小数）；无法确定时填 null
- direction: "expense"(支出) | "income"(收入) | "refund"(退款) | "transfer"(转账)
- merchant: 商户/对方名称，去掉"收款方""付款方"等前缀，保留原名；不知道填 ""
- category: 从 [餐饮, 交通, 购物, 娱乐, 学习, 日用品, 医疗, 通讯, 住宿, 人情, 其他] 中选一个最合适的；收入/退款/转账类交易填 null；不确定填 "其他"
- account: "wechat" | "alipay" | "bank" | "cash" | "other"
- ts: 交易时间，ISO8601 格式（如 2025-06-01T12:30:00+08:00）；文本中没有时间信息时填 null
- note: 简短备注（如"红包""代付"），没有填 ""
- confidence: 0 到 1 之间的置信度，表示你对整体解析结果的把握

判定规则（按顺序执行）：
1. account 判定（最先做）：文本含"微信支付/微信" → "wechat"；含"支付宝" → "alipay"；含"银行/储蓄卡/信用卡/尾号" → "bank"；都没有 → "other"
2. 方向："收款/入账/到账/红包收到" → income；明确提到"退款"且钱是退回给你的 → refund；"支付/付款/消费/扣款/购买" → expense；只有"转账"且无方向 → transfer
3. merchant 判定（必填，不许因为拿不准就填空）：支出时填收款商户名；收入/转账时填"来自/转自/对方"后面的名字（如"来自：妈妈" → "妈妈"）；实在找不到对方才填 ""
4. 金额可能写作 "¥18.50"、"18.5元"、"1,234.56"，去掉千分位逗号；只提取与交易本身相关的数字
5. 示例：
"微信支付 收款方：全家便利店 ¥18.50" → {"amount":18.5,"direction":"expense","merchant":"全家便利店","category":"餐饮","account":"wechat","ts":null,"note":"","confidence":0.9}
"支付宝 你收到一笔转账 200.00元 来自：妈妈" → {"amount":200,"direction":"income","merchant":"妈妈","category":null,"account":"alipay","ts":null,"note":"转账","confidence":0.9}
"您尾号8888的储蓄卡收入人民币500.00元，交易对方：京东商城" → {"amount":500,"direction":"income","merchant":"京东商城","category":null,"account":"bank","ts":null,"note":"","confidence":0.85}
"招商银行 尾号1234 储蓄卡 支出人民币58.00元 沃尔玛" → {"amount":58,"direction":"expense","merchant":"沃尔玛","category":"购物","account":"bank","ts":null,"note":"","confidence":0.9}
"买了一杯奶茶 13元" → {"amount":13,"direction":"expense","merchant":"奶茶店","category":"餐饮","account":"other","ts":null,"note":"","confidence":0.6}

输出必须是一个合法的 JSON 对象，键为上述字段名。`

export async function parseCapture(text, { timeoutMs = 30000 } = {}) {
  const cfg = llmConfig()
  if (!cfg.enabled) return { ok: false, code: 'no_key', error: '未配置 LLM_API_KEY，进入手动记账模式' }
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: String(text).slice(0, 4000) },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  }
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, code: `http_${res.status}`, error: t.slice(0, 300) }
    }
    const json = await res.json()
    let content = json?.choices?.[0]?.message?.content ?? ''
    content = String(content).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    return { ok: true, data: sanitize(JSON.parse(content)) }
  } catch (e) {
    return { ok: false, code: 'network', error: String(e?.message || e).slice(0, 300) }
  }
}

function sanitize(d) {
  const amt = Number(d?.amount)
  const conf = Number(d?.confidence)
  let ts = null
  if (typeof d?.ts === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d.ts) && !Number.isNaN(Date.parse(d.ts))) {
    ts = new Date(d.ts).toISOString()
  }
  return {
    amount: Number.isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : null,
    direction: ['expense', 'income', 'refund', 'transfer'].includes(d?.direction) ? d.direction : 'expense',
    merchant: typeof d?.merchant === 'string' ? d.merchant.trim().slice(0, 120) : '',
    category: typeof d?.category === 'string' ? d.category.trim().slice(0, 20) : null,
    account: ['wechat', 'alipay', 'bank', 'cash', 'other'].includes(d?.account) ? d.account : 'other',
    ts,
    note: typeof d?.note === 'string' ? d.note.trim().slice(0, 200) : '',
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
  }
}
