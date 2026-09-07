// ================= AI 批量分类：未分类支出 → 分批 LLM 批量推理 → 结构化分类写回 =================
// 流程：扫描"分类为空/其他"的支出记录 → 按 商户+商品 去重 → 分批（每批 40 组）一次调用 LLM →
//       输出结构化 JSON（下标对齐 + 枚举校验）→ 写回账本分类并沉淀规则记忆（同商户下月起 0 token）。
// 铁律：LLM 只输出枚举内的分类；越界/其他 一律不写回，宁缺毋滥。
import { env } from './env.js'
import { db, ruleFor, upsertRule, bumpTx, getCategories } from './db.js'
import { llmConfig, noteModelResult } from './llm.js'

const BATCH_SIZE = 40

// 分类模型链：qwen（视觉 Key 复用，默认 qwen3.8-flash）优先 → 主 LLM（DeepSeek）托底
function classifyChain() {
  const chain = []
  const vKey = env('VISION_API_KEY')
  if (vKey) {
    const m = env('CLASSIFY_MODEL', env('AUDIT_MODEL', 'qwen3.8-flash'))
    chain.push({ base: env('VISION_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''), key: vKey, model: m, label: m })
  }
  const cfg = llmConfig()
  if (cfg.enabled) chain.push({ base: cfg.base, key: cfg.apiKey, model: cfg.model, label: cfg.model })
  return chain
}

// 待分类候选：支出 + 分类为空或「其他」+ 有商户名（confirmed 与 pending 都算，pending 分类后确认更快）
export function classifyCandidates(month) {
  const cond = ["direction = 'expense'", "(category IS NULL OR category = '其他')", "merchant != ''"]
  const params = []
  if (month && /^\d{4}-\d{2}$/.test(month)) { cond.push('ts LIKE ?'); params.push(month + '%') }
  return db.prepare(
    `SELECT id, uid, merchant, goods_name, raw_text, status FROM transactions WHERE ${cond.join(' AND ')} ORDER BY ts DESC`
  ).all(...params)
}

const keyOf = (r) => `${r.merchant}\u0001${r.goods_name || ''}`

// 预览：只统计规模，不调 LLM、不花钱（前端点击后先弹确认用）
export function classifyPreview(month) {
  const rows = classifyCandidates(month)
  const seen = new Set()
  let uniq = 0
  for (const r of rows) {
    if (ruleFor(r.merchant)?.category && ruleFor(r.merchant).category !== '其他') continue // 有规则记忆的不进 LLM
    const k = keyOf(r)
    if (seen.has(k)) continue
    seen.add(k)
    uniq++
  }
  return { scanned: rows.length, uniq, batches: Math.ceil(uniq / BATCH_SIZE), apply: false }
}

// 用户自己的归类习惯（规则记忆）作为少样本示例：让 AI 对齐个人分类风格，而不是凭通用感觉
function ruleExamples(cats) {
  const valid = new Set(cats)
  return db.prepare("SELECT merchant, category FROM rules WHERE category != '其他' ORDER BY hits DESC LIMIT 15").all()
    .filter((r) => valid.has(r.category))
    .map((r) => ({ m: r.merchant, category: r.category }))
}

// 单批 LLM 推理：输入 [{i,m,g,x}]，输出 {"items":[{"i":0,"category":"餐饮"}]}；链上模型依次尝试
async function llmClassifyBatch(items, examples) {
  const chain = classifyChain()
  if (!chain.length) return { ok: false, error: 'no_llm' }
  const cats = getCategories().expense
  const sys = `你是记账分类助手。给你一组"商户+商品"组合（i 是序号），为每组从以下分类枚举中选一个最合适的：${cats.join(',')}。
判断要点：商品名（g 字段）是关键依据，商户名被脱敏（含 **）时以商品名为准；x 是账本原文片段，仅作辅助；同一商户可能对应多种消费（如淘宝既购物又买菜），按每组自己的商品名判断；无法判断时填"其他"。
该用户的历史归类习惯示例（仅供参考风格，尤其是软件/API/云服务类消费的归类倾向，不要照抄商户名）：${JSON.stringify(examples)}。
只输出一个 JSON 对象：{"items":[{"i":序号,"category":"分类"}]}，items 必须覆盖全部输入序号，顺序不限。禁止输出枚举以外的分类。`
  let lastErr = ''
  for (const p of chain) {
    try {
      const res = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(items) }],
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        lastErr = `${p.label} http${res.status} ${t.slice(0, 60)}`
        if (p === chain[0]) noteModelResult('text', false, 'api_error', lastErr) // 主链路欠费等状态要透出给界面
        continue
      }
      const j = await res.json()
      const content = String(j?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
      const parsed = JSON.parse(content)
      if (!Array.isArray(parsed.items)) { lastErr = `${p.label} bad_items`; continue }
      return { ok: true, items: parsed.items, model: p.label }
    } catch (e) {
      lastErr = `${p.label} ${String(e?.message || e).slice(0, 80)}`
    }
  }
  return { ok: false, error: lastErr || 'all_failed' }
}

// 主流程：apply=false 只返回结构化预览；apply=true 写回分类 + 沉淀规则记忆
export async function classifyPending({ month = '', apply = false } = {}) {
  const cats = getCategories().expense
  const rows = classifyCandidates(month)
  // 去重：同 商户+商品 只推理一次；已有有效规则记忆（非"其他"且在枚举内）的 0 token 跳过
  const seen = new Map()
  const uniq = []
  for (const r of rows) {
    const rule = ruleFor(r.merchant)
    if (rule?.category && rule.category !== '其他' && cats.includes(rule.category)) continue
    const k = keyOf(r)
    if (seen.has(k)) continue
    seen.set(k, uniq.length)
    uniq.push({ i: uniq.length, k, m: r.merchant, g: r.goods_name || '', x: String(r.raw_text || '').replace(/\s+/g, ' ').slice(0, 60) })
  }
  const batches = []
  for (let i = 0; i < uniq.length; i += BATCH_SIZE) batches.push(uniq.slice(i, i + BATCH_SIZE))
  const examples = ruleExamples(cats)

  const catByKey = new Map()
  const errors = []
  for (const batch of batches) {
    let res = await llmClassifyBatch(batch, examples)
    if (!res.ok) res = await llmClassifyBatch(batch, examples) // 重试一次（网络抖动/偶发 JSON 截断）
    if (!res.ok) { errors.push(res.error); noteModelResult('text', false, 'api_error', res.error); break }
    noteModelResult('text', true)
    for (const it of res.items) {
      const idx = Number(it?.i)
      if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue // 越界下标忽略
      const cat = String(it?.category || '').trim()
      if (!cat || cat === '其他' || !cats.includes(cat)) continue // 枚举校验：越界/其他 不写回
      catByKey.set(batch[idx].k, cat)
    }
  }

  // 结构化结果：每条候选记录给出 原分类 → 新分类
  const items = []
  for (const r of rows) {
    const cat = catByKey.get(keyOf(r))
    if (!cat) continue
    items.push({ uid: r.uid, merchant: r.merchant, goods_name: r.goods_name || '', from: r.category || '其他', to: cat, status: r.status })
  }

  let updated = 0
  let rules = 0
  if (apply && catByKey.size) {
    for (const it of items) {
      const r = rows.find((x) => x.uid === it.uid)
      if (!r) continue
      db.prepare('UPDATE transactions SET category = ? WHERE id = ?').run(it.to, r.id)
      bumpTx(r.id)
      upsertRule(r.merchant, it.to)
      updated++
    }
    rules = catByKey.size
  }

  return {
    month: month || null,
    apply: !!apply,
    scanned: rows.length,
    uniq: uniq.length,
    batches: batches.length,
    categorized: catByKey.size,
    updated,
    rules,
    items: items.slice(0, 200),
    errors,
    error: errors.length ? errors[0] : '',
  }
}
