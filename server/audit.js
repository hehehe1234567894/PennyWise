// ================= 账单核验（账单行 vs 账本记录 比对 + 好模型终审兜底） =================
// 流程：原始账单行在导入时已存证（bill_rows 表）→ 核验时逐行比对账本 →
//       异常项（缺失/金额不符/方向不符/疑似重复）交给强模型终审（qwen3.8-flash 长文本优先，DeepSeek 托底）→
//       输出结论与建议，并可导出 CSV 供人工复核。
// 铁律：模型只给"意见"，不改账；任何不确定都标记"待人工核对"。
import { env } from './env.js'
import { db } from './db.js'
import { llmConfig } from './llm.js'

const auditCache = new Map() // month -> {at, data}（5 分钟内重复核验/下载直接复用，避免重跑模型终审）

export async function auditMonth(month) {
  const cached = auditCache.get(month)
  if (cached && Date.now() - cached.at < 5 * 60e3) return cached.data
  // 1) 该月的原始账单行
  const billRows = db.prepare('SELECT * FROM bill_rows WHERE ts LIKE ? ORDER BY ts').all(month + '%')
  const txByExt = new Map()
  const txByUid = new Map()
  for (const b of billRows) {
    if (b.match_tx_id) {
      const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(b.match_tx_id)
      if (t) { txByExt.set(b.ext_id, t); txByUid.set(b.match_tx_uid || '', t) }
    } else {
      const t = db.prepare('SELECT * FROM transactions WHERE ext_id = ?').get(b.ext_id)
      if (t) txByExt.set(b.ext_id, t)
    }
  }

  // 2) 逐行比对
  const items = []
  let ok = 0, missing = 0, mismatch = 0
  for (const b of billRows) {
    const t = txByExt.get(b.ext_id)
    if (!t) {
      missing++
      items.push({ key: b.ext_id, kind: 'missing', verdict: '', advice: '', bill: rowView(b), tx: null })
      continue
    }
    const probs = []
    if (b.amount != null && t.amount != null && Math.abs(Number(b.amount) - Number(t.amount)) > 0.005) probs.push(`金额不符：账单 ¥${b.amount} vs 账本 ¥${t.amount}`)
    if (b.direction && t.direction && b.direction !== t.direction) probs.push(`方向不符：账单 ${b.direction} vs 账本 ${t.direction}`)
    if (probs.length) {
      mismatch++
      items.push({ key: b.ext_id, kind: 'mismatch', detail: probs.join('；'), verdict: '', advice: '', bill: rowView(b), tx: txView(t) })
    } else {
      ok++
    }
  }

  // 3) 账本内部异常：疑似重复（同向、金额±0.05、时间±40h；跨来源或不同单号才算）
  const txs = db.prepare(`SELECT * FROM transactions WHERE ts LIKE ? AND status = 'confirmed' AND amount IS NOT NULL ORDER BY ts`).all(month + '%')
  const dupPairs = []
  for (let i = 0; i < txs.length; i++) {
    for (let j = i + 1; j < txs.length; j++) {
      const a = txs[i], b = txs[j]
      if (a.direction !== b.direction) continue
      if (Math.abs(Number(a.amount) - Number(b.amount)) > 0.05) continue
      if (Math.abs(Date.parse(a.ts) - Date.parse(b.ts)) > 40 * 3600e3) continue
      const sameExt = a.ext_id && b.ext_id && a.ext_id === b.ext_id
      if (sameExt) continue
      const cross = (a.source === 'csv') !== (b.source === 'csv')
      if (!cross && !(a.ext_id && b.ext_id)) continue // 同源无单号的手记不算
      dupPairs.push({ key: `dup:${a.uid}:${b.uid}`, kind: 'dup', verdict: '', advice: '', tx: txView(a), tx2: txView(b) })
      if (dupPairs.length >= 20) break
    }
    if (dupPairs.length >= 20) break
  }
  items.push(...dupPairs)

  // 4) 模型终审（有异常才调用；qwen3.8-flash 长文本优先 → DeepSeek 托底）
  const anomalous = items.filter((x) => x.kind !== 'ok')
  let llm = { ok: false, model: '', note: anomalous.length ? '未调用' : '无异常，无需终审' }
  if (anomalous.length) {
    const r = await auditLLM(anomalous.slice(0, 12))
    if (r.ok) {
      llm = { ok: true, model: r.model, note: r.note }
      const byKey = new Map((r.decisions || []).map((d) => [d.key, d]))
      for (const it of anomalous) {
        const d = byKey.get(it.key)
        it.verdict = String(d?.verdict || '').slice(0, 60)
        it.advice = String(d?.advice || '').slice(0, 120)
      }
    } else {
      llm = { ok: false, model: r.model || '', note: r.note || '模型终审不可用，请人工核对' }
    }
  }

  const out = {
    month,
    summary: { billRows: billRows.length, checked: billRows.length, ok, missing, mismatch, dupPairs: dupPairs.length },
    items,
    llm,
  }
  auditCache.set(month, { at: Date.now(), data: out })
  return out
}

function rowView(b) {
  return { ts: b.ts, amount: b.amount, direction: b.direction, merchant: b.merchant, goods_name: b.goods_name, ext_id: b.ext_id }
}
function txView(t) {
  return { uid: t.uid, ts: t.ts, amount: t.amount, direction: t.direction, merchant: t.merchant, category: t.category, source: t.source, goods_name: t.goods_name }
}

// 终审模型链：qwen3.8-flash（长文本，适合整单审阅）优先 → 主 LLM（DeepSeek）托底
async function auditLLM(items) {
  const chain = []
  const vKey = env('VISION_API_KEY')
  if (vKey) chain.push({
    base: env('VISION_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    key: vKey, model: env('AUDIT_MODEL', 'qwen3.8-flash'), label: env('AUDIT_MODEL', 'qwen3.8-flash'),
  })
  const cfg = llmConfig()
  if (cfg.enabled) chain.push({ base: cfg.base, key: cfg.apiKey, model: cfg.model, label: cfg.model })
  const sys = `你是记账审计员。给你一组账单核验异常项（missing=账单行没进账本；mismatch=金额/方向不符；dup=疑似重复对）。逐项判定：
- 若证据显示是正常情况（如两笔真实独立消费）→ verdict="误报（正常）"，advice="无需处理"
- 若确实有问题 → verdict 用"缺失入账/金额错误/方向错误/重复记录"之一，advice 给一句具体处理建议（如"删除 UID 后一条"）
只输出 JSON：{"note":"总体结论一句话","items":[{"key":"原样返回","verdict":"...","advice":"..."}]}，items 必须覆盖全部输入项。禁止编造不存在的信息。`
  for (const p of chain) {
    try {
      const res = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({
          model: p.model,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: `异常项清单：\n${JSON.stringify(items, null, 1)}` },
          ],
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(120000),
      })
      if (!res.ok) continue
      const j = await res.json()
      const content = String(j?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
      const d = JSON.parse(content)
      if (Array.isArray(d.items)) return { ok: true, model: p.label, note: String(d.note || '').slice(0, 200), decisions: d.items }
    } catch { /* 换下一个模型 */ }
  }
  return { ok: false, model: '', note: '模型终审不可用（链上模型都失败），请人工核对' }
}

// 核验报告 CSV（Excel 友好：BOM + 转义）
export function buildAuditCsv(data) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const L = []
  L.push(`PennyWise 账单核验报告 ${data.month}`)
  L.push(`账单行,正常,缺失,不符,疑似重复对,模型终审`)
  const s = data.summary
  L.push([s.billRows, s.ok, s.missing, s.mismatch, s.dupPairs, data.llm?.ok ? `${data.llm.model}：${data.llm.note}` : (data.llm?.note || '')].map(esc).join(','))
  L.push('')
  L.push('类型,单号/键,账单行时间,账单金额,方向,商户,商品,账本UID,账本时间,账本金额,账本商户,账本分类,账本来源,明细,模型判定,处理建议')
  for (const it of data.items) {
    const b = it.bill || {}
    const t = it.tx || {}
    const t2 = it.tx2 || {}
    L.push([it.kind, it.key, b.ts || '', b.amount ?? '', b.direction || '', b.merchant || '', b.goods_name || '',
      t.uid || '', t.ts || '', t.amount ?? '', t.merchant || '', t.category || '', t.source || '',
      it.detail || (it.tx2 ? `与另一条疑似重复：${t2.ts} ¥${t2.amount} ${t2.merchant || ''}` : ''),
      it.verdict || '', it.advice || ''].map(esc).join(','))
  }
  return L.join('\r\n')
}
