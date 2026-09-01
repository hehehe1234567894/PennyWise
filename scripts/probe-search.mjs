// 诊断：找出 qwen3.8-flash 在百炼 compatible-mode 上触发联网搜索的正确参数
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const envText = fs.readFileSync(path.join(root, '.env'), 'utf8')
const get = (k) => (envText.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim() || ''
const base = get('VISION_BASE_URL').replace(/\/+$/, '')
const key = get('VISION_API_KEY')
const q = '蓝牙耳机 200元以内 推荐'

async function call(label, model, extra) {
  const body = { model, messages: [{ role: 'user', content: `搜索：${q}` }], temperature: 0.1, ...extra }
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    })
    if (!res.ok) { console.log(`[${label}] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); return }
    const j = await res.json()
    const msg = j?.choices?.[0]?.message || {}
    const sr = j?.search_info?.search_results || []
    const ws = msg.web_search || j?.web_search || []
    console.log(`[${label}] keys=${Object.keys(j).join(',')}  search_info=${sr.length}  web_search字段=${Array.isArray(ws) ? ws.length : '无'}`)
    if (Array.isArray(ws) && ws.length) console.log('   首条:', JSON.stringify(ws[0]).slice(0, 160))
    console.log('   内容:', String(msg.content || '').replace(/\s+/g, ' ').slice(0, 120))
  } catch (e) { console.log(`[${label}] 异常: ${String(e?.message || e).slice(0, 100)}`) }
}

await call('V1 enable_search+forced(qwen3.8)', 'qwen3.8-flash', { enable_search: true, search_options: { forced_search: true, enable_source: true } })
await call('V2 tools web_search(qwen3.8)', 'qwen3.8-flash', { tools: [{ type: 'web_search', web_search: { enable: true, search_result: true } }] })
await call('V3 enable_search(qwen-plus)', 'qwen-plus', { enable_search: true, search_options: { forced_search: true } })
await call('V4 enable_search(qwen3.7)', 'qwen3.7-flash', { enable_search: true, search_options: { forced_search: true } })
