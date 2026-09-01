import { db, currentMonth } from './db.js'
import { summarizeMonth } from './reporter.js'
import { llmConfig } from './llm.js'
import { webSearch } from './search.js'

// ================= 商品平替推荐（两步式：先联网搜索拿证据，再接地生成） =================
// 铁律：没有搜索证据就不给具体产品推荐（防"一派胡言"式幻觉）。

function buildEvidenceBlock(results) {
  return results.map((r, i) => {
    const src = r.source ? `（来源:${r.source}）` : ''
    return `[${i + 1}] ${r.title}${src}\n    链接: ${r.url}\n    摘要: ${r.snippet}`
  }).join('\n')
}

function buildSourcesLine(results) {
  const urls = results.filter((r) => r.url).slice(0, 3).map((r) => r.url)
  return urls.length ? `\n\n来源:\n${urls.map((u) => u).join('\n')}` : ''
}

async function llmGenerate(sys, user, { json = false, timeout = 60000 } = {}) {
  const cfg = llmConfig()
  if (!cfg.enabled) return { ok: false, text: 'AI 未配置（LLM_API_KEY）' }
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return { ok: false, text: `生成请求失败（HTTP ${res.status}）` }
    const j = await res.json()
    const content = String(j?.choices?.[0]?.message?.content || '').trim()
    if (!content) return { ok: false, text: '生成返回为空' }
    return { ok: true, text: content }
  } catch (e) {
    return { ok: false, text: '生成服务暂不可用：' + String(e?.message || e).slice(0, 80) }
  }
}

// 用户主动求平替：搜索 → 接地生成
export async function recommendAlternatives(query) {
  const s = summarizeMonth(currentMonth())
  const ctx = `本月支出 ¥${s.expense}，收入 ¥${s.income}，结余 ¥${s.balance}；主要支出分类：${(s.byCategory || []).slice(0, 4).map((c) => `${c.name} ¥${c.total}`).join('、') || '暂无'}`
  const search = await webSearch(`${query} 价格 多少钱`, { maxResults: 6 })
  if (!search.ok) {
    return { ok: false, text: `⚠️ 联网搜索暂不可用（${search.reason}）。为避免推荐不存在的商品，这次不给具体建议；请稍后再试或自行在电商 App 核实。` }
  }
  const evidence = buildEvidenceBlock(search.results) || (search.summary ? `模型联网总结：${search.summary}` : '')
  if (!evidence) {
    return { ok: false, text: '⚠️ 联网搜索没有返回可用结果，无法给出有依据的推荐。请换个说法再试。' }
  }
  const sys = `你是消费顾问。只能依据【搜索证据】中真实出现的产品名、型号和价格来推荐，禁止凭记忆编造或补充任何证据之外的型号/价格。
要求：
1. 给出 2-3 个更便宜的替代方案（若证据显示原品已是最优也请说明）：每个方案末尾标注证据编号，如 [2]；
2. 证据不足 2 个方案时，就只给有依据的，并明确说"搜索证据有限"；
3. 用户提到预算时，明确判断是否符合预算；
4. 简体中文，Markdown 列表，250 字以内；结尾注明"价格随时间波动，仅供参考"。`
  const r = await llmGenerate(sys, `用户想买：${query}\n\n我的消费情况：${ctx}\n\n【搜索证据】\n${evidence}`)
  if (!r.ok) return { ok: false, text: r.text }
  return { ok: true, text: r.text + buildSourcesLine(search.results) }
}

// 分析用户在用产品的两个方向：① 更便宜的方案；② 更好的升级产品（搜索 + 接地 JSON 输出）
export async function analyzeProductOptions({ product, currentPrice, reason }) {
  const search = await webSearch(`${product} 价格`, { maxResults: 5 })
  if (!search.ok) return { cheaper: false, cheaperText: '', better: false, betterText: '', searchFail: search.reason }
  const evidence = buildEvidenceBlock(search.results) || (search.summary ? `模型联网总结：${search.summary}` : '')
  if (!evidence) return { cheaper: false, cheaperText: '', better: false, betterText: '', searchFail: '无搜索结果' }
  const sys = `你是消费顾问。用户目前在用「${product}」，价格为 ${currentPrice} 元。只能依据【搜索证据】里真实出现的产品/价格判断，禁止编造证据之外的型号或价格。
给出两个独立判断：
1. cheaper：有没有【比现价 ${currentPrice} 元更低】的真实方案（优惠、拼车、学生价、年付折扣、更便宜的同类替代品）。证据里没有 → cheaper=false。
2. better：有没有【明显更好、值得升级】的产品。证据里没有 → better=false。
只输出 JSON：{"cheaper":true或false,"cheaper_text":"cheaper=true 时 Markdown 列表（名称、价格、省多少、取舍，标注证据编号如[1]）；false 填\"\"","better":true或false,"better_text":"better=true 时 Markdown 列表（名称、价格、好在哪、是否值得，标注证据编号）；false 填\"\""}`
  const r = await llmGenerate(sys, `商品：${product}\n现价：${currentPrice} 元\n备注：${reason || ''}\n\n【搜索证据】\n${evidence}`, { json: true })
  if (!r.ok) return { cheaper: false, cheaperText: '', better: false, betterText: '', searchFail: r.text }
  const content = r.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    const d = JSON.parse(content)
    return {
      cheaper: d.cheaper === true,
      cheaperText: String(d.cheaper_text || '').slice(0, 600),
      better: d.better === true,
      betterText: String(d.better_text || '').slice(0, 600),
      searchFail: '',
    }
  } catch {
    return { cheaper: false, cheaperText: '', better: false, betterText: '', searchFail: '输出格式异常' }
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
  `).all(month + '%').map((r) => ({ merchant: r.merchant, goods: r.goods_name, n: Number(r.n), total: Number(r.total), avg: Math.round((Number(r.total) / Number(r.n)) * 100) / 100 }))
  const tops = db.prepare(`
    SELECT merchant, goods_name, amount FROM transactions
    WHERE ts LIKE ? AND status = 'confirmed' AND amount IS NOT NULL AND direction = 'expense'
    ORDER BY amount DESC LIMIT 8
  `).all(month + '%')
  const last = lastAltRecommend()
  const exclude = last && Array.isArray(last.items) && last.items.length ? last.items.join('、') : '无'
  const sys = `你是省钱助手。分析用户的月度账单，挑选 1-3 个"可能存在更便宜选择"的商品或服务（订阅/会员、高频重复购买、大额消费）。
规则：不要推荐以下商品（上月已推荐过，连续两个月推荐同一商品会让用户厌烦）：${exclude}；商品名不明确的宁可跳过；current_price 填用户当前的单价（订阅=月费，商品=单价，从 avg 字段取）；只输出 JSON：{"items":[{"product":"商品/服务名","current_price":25.5,"reason":"简短理由","search":"给搜索引擎的关键词"}]}，最多 3 个，没有合适的输出 {"items":[]}。`
  let items = []
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `本月数据：\n高频商户（含平均单价 avg）：${JSON.stringify(freq)}\n大额支出：${JSON.stringify(tops)}` },
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
    const price = Number(it.current_price)
    // 两个方向：更便宜的方案 + 更好的升级产品（搜索失败 = 跳过，绝不凭记忆推荐）
    const r = await analyzeProductOptions({ product: String(it.product).slice(0, 60), currentPrice: Number.isFinite(price) ? price : 0, reason: String(it.reason || '').slice(0, 120) })
    if (!r.cheaperText && !r.betterText) continue
    out.push({
      product: String(it.product).slice(0, 60),
      reason: `现价 ¥${Number.isFinite(price) ? price : '?'}${it.reason ? '，' + String(it.reason).slice(0, 100) : ''}`,
      cheaperText: r.cheaperText,
      betterText: r.betterText,
    })
  }
  if (out.length) saveLastAltRecommend(month, out.map((x) => x.product))
  return out
}
