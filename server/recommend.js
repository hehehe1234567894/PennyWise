import { env } from './env.js'
import { db, currentMonth } from './db.js'
import { summarizeMonth } from './reporter.js'
import { llmConfig } from './llm.js'

// ================= 商品平替推荐（联网搜索接地） =================

export async function recommendAlternatives(query) {
  const s = summarizeMonth(currentMonth())
  const ctx = `本月支出 ¥${s.expense}，收入 ¥${s.income}，结余 ¥${s.balance}；主要支出分类：${(s.byCategory || []).slice(0, 4).map((c) => `${c.name} ¥${c.total}`).join('、') || '暂无'}`
  const sys = `你是消费顾问。用户会提出想购买的商品/服务。请先联网搜索当前真实价格，再结合用户的消费情况给出建议。
要求：
1. 必须先搜索再回答，价格尽量引用搜索结果，禁止凭空编造价格；
2. 给出 2-3 个更便宜的替代方案（若原品已是最优也请说明理由）：每个方案包含名称、参考价格、与原品的关键差异/取舍；
3. 用户提到预算时，明确判断是否符合预算；
4. 简体中文，Markdown 列表，控制在 250 字以内；结尾注明"价格随时间波动，仅供参考"。`
  const base = env('VISION_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
  const key = env('VISION_API_KEY')
  const model = env('RECOMMEND_MODEL', 'qwen-plus')
  if (!key) return { ok: false, text: '未配置百炼 API Key（VISION_API_KEY），无法联网搜索推荐' }
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        enable_search: true,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `${query}\n\n我的消费情况：${ctx}` },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(90000),
    })
    if (!res.ok) return { ok: false, text: `推荐服务请求失败（HTTP ${res.status}）` }
    const j = await res.json()
    const content = String(j?.choices?.[0]?.message?.content || '').trim()
    if (!content) return { ok: false, text: '推荐服务返回为空' }
    return { ok: true, text: content }
  } catch (e) {
    return { ok: false, text: '推荐服务暂时不可用：' + String(e?.message || e).slice(0, 80) }
  }
}

// ================= 账单驱动的省钱引擎（随月报推送，连续两月不重复推荐） =================

function lastAltRecommend() {
  try {
    const v = db.prepare("SELECT v FROM meta WHERE k = 'last_alt_recommend'").get()?.v
    return v ? JSON.parse(v) : null
  } catch { return null }
}
function saveLastAltRecommend(month, items) {
  db.prepare("INSERT INTO meta (k, v) VALUES ('last_alt_recommend', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(JSON.stringify({ month, items }))
}

// 分析某月账单 → 挑选适合找平替的商品 → 联网搜索 → 返回推荐列表
export async function analyzeBillForAlternatives(month) {
  const cfg = llmConfig()
  if (!cfg.enabled) return []
  const s = summarizeMonth(month)
  if (!s.count) return []
  const freq = db.prepare(`
    SELECT merchant, goods_name, COUNT(*) AS n, SUM(amount) AS total
    FROM transactions WHERE ts LIKE ? AND status = 'confirmed' AND amount IS NOT NULL AND direction = 'expense'
    GROUP BY merchant ORDER BY n DESC, total DESC LIMIT 15
  `).all(month + '%').map((r) => ({ merchant: r.merchant, goods: r.goods_name, n: Number(r.n), total: Number(r.total) }))
  const tops = db.prepare(`
    SELECT merchant, goods_name, amount FROM transactions
    WHERE ts LIKE ? AND status = 'confirmed' AND amount IS NOT NULL AND direction = 'expense'
    ORDER BY amount DESC LIMIT 8
  `).all(month + '%')
  const last = lastAltRecommend()
  const exclude = last && Array.isArray(last.items) && last.items.length ? last.items.join('、') : '无'
  const sys = `你是省钱助手。分析用户的月度账单，挑选 1-3 个"值得找更便宜替代/更划算渠道"的商品或服务。
挑选标准（按优先级）：① 订阅/会员类（音乐/视频/网盘/工具会员，常有学生价/拼车/年付优惠）；② 高频重复购买（同商户多次购买，可能批发/换渠道更便宜）；③ 大额一次性消费。
规则：不要推荐以下商品（上月已推荐过，连续两个月推荐同一商品会让用户厌烦）：${exclude}；商品名不明确的宁可跳过；只输出 JSON：{"items":[{"product":"商品/服务名","reason":"简短理由（含本月花费）","search":"给搜索引擎的关键词"}]}，最多 3 个，没有合适的输出 {"items":[]}。`
  let items = []
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `本月数据：\n高频商户：${JSON.stringify(freq)}\n大额支出：${JSON.stringify(tops)}` },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(45000),
    })
    if (!res.ok) return []
    const j = await res.json()
    const content = String(j?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    const d = JSON.parse(content)
    items = Array.isArray(d.items) ? d.items.slice(0, 3) : []
  } catch { return [] }
  if (!items.length) return []
  const out = []
  for (const it of items) {
    if (!it.product || !it.search) continue
    const r = await recommendAlternatives(`${it.search} 便宜 替代`)
    out.push({ product: String(it.product).slice(0, 60), reason: String(it.reason || '').slice(0, 120), recommendation: r.text })
  }
  if (out.length) saveLastAltRecommend(month, out.map((x) => x.product))
  return out
}
