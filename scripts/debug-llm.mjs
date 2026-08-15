// 调试脚本：把原始 LLM 输出打印出来，用于排查解析失败案例。
// 用法: node scripts/debug-llm.mjs "支付宝 你收到一笔转账 200.00元 来自：妈妈"
import { llmConfig, SYSTEM_PROMPT } from '../server/llm.js'

const text = process.argv.slice(2).join(' ') || '支付宝 你收到一笔转账 200.00元 来自：妈妈'
const cfg = llmConfig()
if (!cfg.enabled) { console.log('LLM_API_KEY 未配置'); process.exit(1) }

const res = await fetch(`${cfg.base}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
  body: JSON.stringify({
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  }),
  signal: AbortSignal.timeout(30000),
})
console.log('HTTP', res.status)
const j = await res.json()
console.log('RAW CONTENT >>>')
console.log(j?.choices?.[0]?.message?.content)
console.log('<<<')
