// ================= 数据质量体检：程序确定性检查 + 安全修复 → LLM 复核（只给意见不改账） =================
// 顺序（用户约定）：① 程序先做合并等确定性预处理（精确重复合并 / 空白清洗 / 规则记忆补分类 /
//   方向-分类一致性归一）——全部是"零风险可逆"的修复；② 再把剩余异常（疑似重复对、缺失、
//   格式错误、未自动修复的不一致）分批交给 LLM 复核，输出判定与建议。
// 铁律：LLM 只给"意见"，不改账；任何不确定都标"待人工核对"。
import { env } from './env.js'
import { db, ruleFor, bumpTx, getCategories, validTs, nowIso, newUid, nextRev } from './db.js'
import { llmConfig } from './llm.js'

const DIRECTIONS = ['expense', 'income', 'refund', 'transfer']
const ACCOUNTS = ['wechat', 'alipay', 'bank', 'cash', 'other']
const REVIEW_BATCH = 15
const REVIEW_CAP = 30

const KIND_LABEL = {
  dup_exact: '精确重复', dup_fuzzy: '疑似重复', missing: '字段缺失',
  format: '格式错误', inconsistent: '字段不一致', backlog: '待处理积压',
}

function fetchRows(month) {
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    return db.prepare('SELECT * FROM transactions WHERE ts LIKE ? ORDER BY ts').all(month + '%')
  }
  return db.prepare('SELECT * FROM transactions ORDER BY ts').all()
}

const view = (t) => ({
  uid: t.uid, ts: t.ts, amount: t.amount, direction: t.direction, merchant: t.merchant,
  goods_name: t.goods_name, category: t.category, account: t.account, source: t.source,
  status: t.status, ext_id: t.ext_id || '',
})

// ---- 精确重复组（检查与修复共用同一判定） ----
// a) 业务字段完全一致（时间/金额/方向/商户/账户/来源），且不是"两个不同单号"的独立交易；
// b) 手记双击型：同来源同商户同金额、60 秒内、双方都无账单单号 → 视同精确重复（可自动合并）
function exactDupGroups(rows) {
  const groups = []
  const sigMap = new Map()
  for (const t of rows) {
    const sig = [t.ts, t.amount, t.direction, t.merchant, t.account, t.source].join('|')
    if (!sigMap.has(sig)) sigMap.set(sig, [])
    sigMap.get(sig).push(t)
  }
  for (const group of sigMap.values()) {
    if (group.length < 2) continue
    const extIds = new Set(group.map((t) => t.ext_id || ''))
    if (extIds.size > 1 && group.every((t) => t.ext_id)) continue // 单号互不相同 = 各平台的独立交易，不算重复
    groups.push(group)
  }
  if (groups.length >= 20) return groups
  const man = rows.filter((t) => !t.ext_id)
  for (let i = 0; i < man.length; i++) {
    for (let j = i + 1; j < man.length; j++) {
      const a = man[i], b = man[j]
      if (a.direction !== b.direction || a.source !== b.source || a.account !== b.account) continue
      if (!a.merchant || a.merchant !== b.merchant) continue
      if (Math.abs(Number(a.amount) - Number(b.amount)) > 0.001) continue
      const dt = Math.abs(Date.parse(a.ts) - Date.parse(b.ts))
      if (Number.isNaN(dt) || dt > 60e3) continue
      groups.push([a, b])
      if (groups.length >= 20) return groups
    }
  }
  return groups
}

// ---- 第一步：程序确定性检查 ----
function analyze(rows, cats) {
  const items = []
  const catList = new Set(cats)
  const nowMs = Date.now()

  // 1) 精确重复（含手记双击型，可自动合并）
  for (const group of exactDupGroups(rows)) {
    const dbl = group.length === 2 && String(group[0].ts) !== String(group[1].ts)
    items.push({ key: `dupx:${group.map((t) => t.uid).join(':')}`, kind: 'dup_exact', detail: dbl ? '同商户同金额 60 秒内（双击/重试型重复）' : '', txs: group.map(view) })
  }

  // 2) 疑似重复对：a) 跨来源/都有单号（时间±40h、金额±0.05、同方向）；b) 同来源短窗口（同商户、金额±0.05、10 分钟内）
  //    全量收集后按"像真重复的程度"排序再截断：同商品 > 同商户且10分钟内 > 跨来源/都有单号 > 其他，
  //    避免公交连刷这类高频正常消费把真正可疑的对挤出名额。
  const txs = rows.filter((t) => t.amount != null)
  const pairs = []
  for (let i = 0; i < txs.length; i++) {
    for (let j = i + 1; j < txs.length; j++) {
      const a = txs[i], b = txs[j]
      if (a.direction !== b.direction) continue
      if (Math.abs(Number(a.amount) - Number(b.amount)) > 0.05) continue
      const dt = Math.abs(Date.parse(a.ts) - Date.parse(b.ts))
      if (Number.isNaN(dt)) continue
      if (a.ext_id && b.ext_id && a.ext_id === b.ext_id) continue
      const cross = (a.source === 'csv') !== (b.source === 'csv')
      if ((cross || (a.ext_id && b.ext_id)) && dt <= 40 * 3600e3) pairs.push([a, b, dt])
      else if (a.source === b.source && a.merchant && a.merchant === b.merchant && dt <= 10 * 60e3) pairs.push([a, b, dt])
    }
  }
  const score = ([a, b, dt]) => {
    let s = 0
    if (a.goods_name && a.goods_name === b.goods_name) s -= 4
    if (a.merchant && a.merchant === b.merchant && dt <= 10 * 60e3) s -= 3
    else if (a.merchant && a.merchant === b.merchant) s -= 1
    if (!a.goods_name && !b.goods_name) s += 1
    return s
  }
  pairs.sort((x, y) => score(x) - score(y))
  for (const [a, b] of pairs.slice(0, REVIEW_CAP)) {
    items.push({ key: `dup:${a.uid}:${b.uid}`, kind: 'dup_fuzzy', txs: [view(a), view(b)] })
  }

  // 3) 逐条检查：缺失 / 格式 / 不一致 / 积压
  for (const t of rows) {
    const probs = []
    if (t.status === 'confirmed' && t.amount == null) probs.push(['missing', '金额缺失（已确认但没有金额）'])
    if (t.direction === 'expense' && !t.merchant) probs.push(['missing', '支出缺商户名'])
    if (!validTs(t.ts)) probs.push(['format', `时间格式无效：${t.ts}`])
    else if (nowMs - Date.parse(t.ts) < -24 * 3600e3) probs.push(['format', '时间在未来（超过 1 天）'])
    else if (Date.parse(t.ts) < Date.parse('2020-01-01')) probs.push(['format', '时间早于 2020 年'])
    if (t.amount != null && !(Number(t.amount) > 0)) probs.push(['format', `金额异常：${t.amount}`])
    if (!DIRECTIONS.includes(t.direction)) probs.push(['format', `方向非法：${t.direction}`])
    if (!ACCOUNTS.includes(t.account)) probs.push(['format', `账户非法：${t.account}`])
    if (t.direction === 'expense' && t.category != null && !catList.has(t.category)) probs.push(['format', `分类不在枚举：${t.category}`])
    if (t.confidence != null && (Number(t.confidence) < 0 || Number(t.confidence) > 1)) probs.push(['format', `置信度越界：${t.confidence}`])
    if (t.direction !== 'expense' && t.category != null) probs.push(['inconsistent', `方向为 ${t.direction} 但带支出分类「${t.category}」`])
    if (t.currency && t.currency !== 'CNY') probs.push(['inconsistent', `币种异常：${t.currency}`])
    if (t.status === 'pending' && validTs(t.ts) && nowMs - Date.parse(t.ts) > 7 * 24 * 3600e3) probs.push(['backlog', `待确认已积压超过 7 天`])
    for (const [kind, detail] of probs) {
      items.push({ key: `row:${t.uid}:${kind}`, kind, detail, txs: [view(t)] })
    }
  }
  return items
}

// ---- 第二步：程序安全修复（零风险可逆） ----
function applySafeFixes(rows) {
  const fixed = { merged: 0, trimmed: 0, ruleFilled: 0, normalized: 0 }
  const fixedItems = []

  // 2.1 精确重复（含手记双击型）→ 合并：保留"最权威"的一条（有账单单号 > 账单导入来源 > 最早创建），其余删除（留墓碑同步）
  for (const group of exactDupGroups(rows)) {
    const rank = (t) => (t.ext_id ? 4 : 0) + (t.source === 'csv' ? 2 : 0) - Date.parse(t.created_at || t.ts) / 1e15
    const keep = group.slice().sort((a, b) => rank(b) - rank(a))[0]
    for (const t of group) {
      if (t.id === keep.id) continue
      db.prepare('INSERT INTO tombstones (uid, rev, updated_at) VALUES (?, ?, ?)').run(t.uid || newUid(), nextRev(), nowIso())
      db.prepare('DELETE FROM transactions WHERE id = ?').run(t.id)
      fixed.merged++
      fixedItems.push({ key: `dupx:${t.uid}`, kind: 'dup_exact', action: '已合并删除（保留同组最权威记录）', txs: [view(t)] })
    }
  }

  // 2.2 逐条清洗：空白 / 规则记忆补分类 / 一致性归一（重新查一遍，避免上面删除后引用失效）
  const fresh = db.prepare('SELECT * FROM transactions ORDER BY ts').all()
  for (const t of fresh) {
    const sets = {}
    const trim = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v)
    if (trim(t.merchant) !== t.merchant) sets.merchant = trim(t.merchant)
    if (trim(t.goods_name) !== t.goods_name) sets.goods_name = trim(t.goods_name)
    if (trim(t.note) !== t.note) sets.note = trim(t.note)
    if (t.direction === 'expense' && (t.category == null || t.category === '其他')) {
      const rule = ruleFor(trim(t.merchant) || t.merchant)
      // 规则分类必须在当前枚举内（历史测试可能留下 "Dining" 等脏规则，不校验会把脏分类写回账本）
      if (rule?.category && rule.category !== '其他' && cats.includes(rule.category)) sets.category = rule.category
    }
    if (t.direction !== 'expense' && t.category != null) sets.category = null
    if (t.currency && t.currency !== 'CNY') sets.currency = 'CNY'
    if (t.confidence != null && !(Number(t.confidence) >= 0 && Number(t.confidence) <= 1)) sets.confidence = null
    if (!ACCOUNTS.includes(t.account)) sets.account = 'other'
    if (t.direction === 'expense' && t.category != null && !getCategories().expense.includes(t.category)) sets.category = '其他'
    if (!Object.keys(sets).length) continue
    const keys = Object.keys(sets).map((k) => `${k} = ?`).join(', ')
    db.prepare(`UPDATE transactions SET ${keys} WHERE id = ?`).run(...Object.values(sets), t.id)
    bumpTx(t.id)
    for (const [k, v] of Object.entries(sets)) {
      const kind = k === 'category' && v !== null && t.category === '其他' ? 'ruleFilled' : 'normalized'
      fixed[kind]++
      const label = k === 'category' ? `分类「${t.category || '空'}」→「${v}」（规则记忆）`
        : k === 'category' ? `清除方向不符的分类「${t.category}」`
        : k === 'confidence' ? '置信度越界已清空'
        : k === 'account' ? `非法账户「${t.account}」→ other`
        : k === 'currency' ? `币种 ${t.currency} → CNY`
        : `${k} 空白清洗`
      fixedItems.push({ key: `row:${t.uid}:${k}`, kind: k === 'category' && t.category === '其他' ? 'ruleFilled' : (k === 'category' ? 'inconsistent' : 'format'), action: label, txs: [view(t)] })
    }
  }
  return { fixed, fixedItems }
}

// ---- 第三步：LLM 复核剩余异常（只给意见不改账） ----
async function reviewLlm(items) {
  const chain = []
  const vKey = env('VISION_API_KEY')
  if (vKey) chain.push({
    base: env('VISION_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    key: vKey, model: env('AUDIT_MODEL', 'qwen3.8-flash'), label: env('AUDIT_MODEL', 'qwen3.8-flash'),
  })
  const cfg = llmConfig()
  if (cfg.enabled) chain.push({ base: cfg.base, key: cfg.apiKey, model: cfg.model, label: cfg.model })
  const sys = `你是记账数据质量审核员。给你一组数据体检发现的异常项（dup_fuzzy=疑似重复对；missing=字段缺失；format=格式错误；inconsistent=字段不一致）。逐项判定：
- 若证据显示是正常情况（如两笔真实独立消费、金额相近但明显是两次购买）→ verdict="误报（正常）"，advice="无需处理"
- 若确实有问题 → verdict 用"重复记录/缺失金额/缺失商户/时间错误/金额错误/字段错误"之一，advice 给一句具体处理建议（如"删除后一条，保留账单来源"）
- 只依据给出的字段判断，禁止编造不存在的信息。
只输出 JSON：{"note":"总体结论一句话","items":[{"key":"原样返回","verdict":"...","advice":"..."}]}，items 必须覆盖全部输入项。`
  const decisions = []
  let note = ''
  let model = ''
  for (let i = 0; i < items.length; i += REVIEW_BATCH) {
    const batch = items.slice(i, i + REVIEW_BATCH)
    const payload = batch.map((it) => ({ key: it.key, kind: it.kind, detail: it.detail || '', txs: it.txs }))
    let okRes = null
    for (const p of chain) {
      try {
        const res = await fetch(`${p.base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
          body: JSON.stringify({
            model: p.model,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: `异常项清单：\n${JSON.stringify(payload, null, 1)}` },
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(120000),
        })
        if (!res.ok) continue
        const j = await res.json()
        const content = String(j?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
        const d = JSON.parse(content)
        if (Array.isArray(d.items)) { okRes = { model: p.label, note: String(d.note || '').slice(0, 200), items: d.items }; break }
      } catch { /* 换下一个模型 */ }
    }
    if (!okRes) { decisions.push(...batch.map((it) => ({ key: it.key, verdict: '', advice: '模型复核不可用，请人工核对' }))); continue }
    model = okRes.model
    note = note || okRes.note
    const byKey = new Map(okRes.items.map((d) => [d.key, d]))
    for (const it of batch) {
      const d = byKey.get(it.key)
      decisions.push({ key: it.key, verdict: String(d?.verdict || '').slice(0, 60), advice: String(d?.advice || '').slice(0, 120) })
    }
  }
  return { ok: Boolean(model), model, note, decisions }
}

// ---- 主入口 ----
// llm 默认 false：纯程序体检（秒回、零 token）；llm=true 才把剩余异常交给模型复核
export async function qualityCheck({ month = '', apply = false, llm = false } = {}) {
  const cats = getCategories().expense
  const rows = fetchRows(month)
  let fixed = { merged: 0, trimmed: 0, ruleFilled: 0, normalized: 0 }
  let fixedItems = []
  if (apply) {
    const r = applySafeFixes(rows)
    fixed = r.fixed
    fixedItems = r.fixedItems
  }
  // 修复后重新取数检查（apply 时拿到的是修复后的真实状态）
  const after = apply ? fetchRows(month) : rows
  const items = analyze(after, cats)
  const summary = {
    checked: after.length,
    dupExact: items.filter((x) => x.kind === 'dup_exact').length,
    dupFuzzy: items.filter((x) => x.kind === 'dup_fuzzy').length,
    missing: items.filter((x) => x.kind === 'missing').length,
    formatErrors: items.filter((x) => x.kind === 'format').length,
    inconsistent: items.filter((x) => x.kind === 'inconsistent').length,
    backlog: items.filter((x) => x.kind === 'backlog').length,
  }
  // LLM 复核：只看"需要判断"的异常（疑似重复 + 缺失 + 格式 + 未修复的不一致）；积压类纯信息不进模型
  const reviewable = items.filter((x) => ['dup_fuzzy', 'missing', 'format', 'inconsistent'].includes(x.kind)).slice(0, REVIEW_CAP)
  let llmOut = { ok: false, model: '', note: '', decisions: [] }
  if (!llm) {
    llmOut.note = ''
  } else if (!reviewable.length) {
    llmOut.note = '无异常，无需复核'
  } else {
    const r = await reviewLlm(reviewable)
    llmOut = { ok: r.ok, model: r.model, note: r.note, decisions: r.decisions }
    const byKey = new Map(r.decisions.map((d) => [d.key, d]))
    for (const it of reviewable) {
      const d = byKey.get(it.key)
      it.verdict = String(d?.verdict || '').slice(0, 60)
      it.advice = String(d?.advice || '').slice(0, 120)
    }
  }
  return {
    month: month || null,
    apply: !!apply,
    summary,
    fixed,
    fixedItems,
    items: items.slice(0, 100).map((it) => ({ key: it.key, kind: it.kind, label: KIND_LABEL[it.kind] || it.kind, detail: it.detail || '', txs: it.txs, verdict: it.verdict || '', advice: it.advice || '' })),
    llm: { ok: llmOut.ok, model: llmOut.model, note: llmOut.note, enabled: !!llm },
  }
}
