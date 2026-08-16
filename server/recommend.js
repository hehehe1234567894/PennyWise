import { env } from './env.js'
import { currentMonth } from './db.js'
import { summarizeMonth } from './reporter.js'

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
