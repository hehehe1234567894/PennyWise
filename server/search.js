// ================= 联网搜索（平替推荐的证据来源） =================
// 设计原则：搜索结果必须结构化返回，供下游"接地生成"引用；
// 搜索不可用 = 明确失败，绝不静默降级成"凭记忆瞎编"。
//
// 提供商优先级：
// 1. 阿里云百炼（VISION_API_KEY + SEARCH_MODEL，默认 qwen3.8-flash）
//    enable_search + search_options.forced_search 强制联网，search_info.search_results 拿结构化结果
// 2. 智谱 BigModel（BIGMODEL_API_KEY）：web_search 工具，search_std 约 ¥0.01/次，glm-4.5-flash 免费
// 3. Tavily（TAVILY_API_KEY）：每月 1000 次免费额度
import { env } from './env.js'

const cool = { bailian: 0, bigmodel: 0, tavily: 0 }

export async function webSearch(query, { maxResults = 6 } = {}) {
  const key = env('VISION_API_KEY')
  // 故障冷却：某提供商被判定"结构性不可用"（如搜索插件未开通）后 10 分钟内直接跳过，避免每次都白等
  const now = Date.now()
  if (key && now >= cool.bailian) {
    const r = await bailianSearch(key, query, maxResults)
    if (r.ok) return r
    if (r.broken) cool.bailian = now + 10 * 60 * 1000
  }
  const bmKey = env('BIGMODEL_API_KEY')
  if (bmKey && now >= cool.bigmodel) {
    const r = await bigmodelSearch(bmKey, query, maxResults)
    if (r.ok) return r
    if (r.broken) cool.bigmodel = now + 10 * 60 * 1000
  }
  const tvKey = env('TAVILY_API_KEY')
  if (tvKey && now >= cool.tavily) {
    const r = await tavilySearch(tvKey, query, maxResults)
    if (r.ok) return r
  }
  return { ok: false, reason: '搜索服务不可用（检查 VISION_API_KEY 是否有效，或配置 BIGMODEL_API_KEY / TAVILY_API_KEY）', results: [], summary: '' }
}

// ---- 百炼：自带联网搜索的模型链（SEARCH_MODELS 按序降级，默认 qwen3.8-flash 优先）----
async function bailianSearch(key, query, maxResults) {
  const base = env('VISION_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
  const models = env('SEARCH_MODELS', 'qwen3.8-flash,qwen3.7-flash,qwen-plus').split(',').map((s) => s.trim()).filter(Boolean)
  let lastReason = 'bailian 未尝试'
  let pluginDead = false // 全部模型"HTTP 200 但无结构化搜索结果" = 插件未开通，属结构性故障
  for (const model of models) {
    const r = await bailianSearchOnce(base, key, model, query, maxResults)
    if (r.ok) return r
    lastReason = `${model}: ${r.reason}`
    if (r.pluginDead) pluginDead = true
  }
  return { ok: false, results: [], summary: '', reason: lastReason, broken: pluginDead }
}

async function bailianSearchOnce(base, key, model, query, maxResults) {
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `搜索并总结当前真实情况：${query}` }],
        enable_search: true,
        search_options: { forced_search: true, enable_source: true },
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) return { ok: false, results: [], summary: '', reason: `http ${res.status}` }
    const j = await res.json()
    const msg = j?.choices?.[0]?.message || {}
    const raw = Array.isArray(j?.search_info?.search_results) ? j.search_info.search_results : []
    const results = raw.slice(0, maxResults).map((r) => ({
      title: String(r.title || ''),
      url: String(r.url || r.link || ''),
      snippet: String(r.content || '').slice(0, 400),
      source: String(r.site_name || r.media || ''),
    }))
    // 铁律：只有拿到结构化搜索结果才算成功。模型凭记忆的"总结"不是证据，绝不下游引用。
    if (!results.length) return { ok: false, results: [], summary: '', reason: '联网搜索插件未生效（无结构化结果，检查百炼控制台是否开通联网搜索）', pluginDead: true }
    return { ok: true, results, summary: '', model, reason: '' }
  } catch (e) {
    return { ok: false, results: [], summary: '', reason: String(e?.message || e).slice(0, 80) }
  }
}

// ---- 智谱 BigModel：web_search 工具（search_result:true 返回原始结果）----
async function bigmodelSearch(key, query, maxResults) {
  const base = env('BIGMODEL_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: env('SEARCH_MODEL_BIGMODEL', 'glm-4.5-flash'),
        messages: [{ role: 'user', content: `搜索：${query}` }],
        tools: [{ type: 'web_search', web_search: { enable: true, search_engine: 'search_std', search_result: true } }],
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(45000),
    })
    if (!res.ok) return { ok: false, results: [], summary: '', reason: `bigmodel http ${res.status}`, broken: true }
    const j = await res.json()
    const msg = j?.choices?.[0]?.message || {}
    const raw = Array.isArray(msg.web_search) ? msg.web_search : []
    const results = raw.slice(0, maxResults).map((r) => ({
      title: String(r.title || ''),
      url: String(r.link || r.url || ''),
      snippet: String(r.content || '').slice(0, 400),
      source: String(r.media || ''),
    }))
    if (!results.length) return { ok: false, results: [], summary: '', reason: 'bigmodel 无结构化搜索结果', broken: true }
    return { ok: true, results, summary: '', model, reason: '' }
  } catch (e) {
    return { ok: false, results: [], summary: '', reason: String(e?.message || e).slice(0, 80), broken: true }
  }
}

// ---- Tavily（每月 1000 次免费）----
async function tavilySearch(key, query, maxResults) {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: maxResults, search_depth: 'basic' }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return { ok: false, results: [], summary: '', reason: `tavily http ${res.status}` }
    const j = await res.json()
    const results = (j.results || []).slice(0, maxResults).map((r) => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: String(r.content || '').slice(0, 400),
      source: '',
    }))
    return { ok: results.length > 0, results, summary: '', reason: results.length ? '' : '无搜索结果' }
  } catch (e) {
    return { ok: false, results: [], summary: '', reason: String(e?.message || e).slice(0, 80) }
  }
}
