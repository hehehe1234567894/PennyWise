import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// PENNYWISE_DATA_DIR：测试隔离用（指向临时目录）；默认项目 data/
export const DATA_DIR_OVERRIDE = process.env.PENNYWISE_DATA_DIR || ''
export const DATA_DIR = DATA_DIR_OVERRIDE || path.join(ROOT, 'data')
export const PUBLIC_DIR = path.join(ROOT, 'public')

// 极简 .env 加载：不依赖 dotenv 包，`npm start` 开箱即用
;(function loadDotEnv() {
  const file = process.env.PENNYWISE_ENV_FILE || path.join(ROOT, '.env')
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { /* 不存在则首次运行自动生成 */ }
  if (!raw) {
    const token = 'pw-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
    raw = [
      '# ===== PennyWise 配置（首次运行自动生成）=====',
      'PORT=8720',
      `AUTH_TOKEN=${token}`,
      'LLM_BASE_URL=https://api.deepseek.com',
      'LLM_API_KEY=',
      'LLM_MODEL=deepseek-chat',
      'VISION_BASE_URL=https://open.bigmodel.cn/api/paas/v4',
      'VISION_API_KEY=',
      'VISION_MODEL=glm-4v-flash',
      '',
    ].join('\n')
    try { fs.writeFileSync(file, raw, 'utf8') } catch {}
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
})()

export function env(key, def = '') {
  const v = process.env[key]
  return v === undefined || v === '' ? def : v
}

// 回写 .env（供网页设置修改配置，如 AI Key），并同步到当前进程，无需重启
export function writeEnv(key, value) {
  const file = process.env.PENNYWISE_ENV_FILE || path.join(ROOT, '.env')
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch {}
  const lines = raw.split(/\r?\n/)
  let found = false
  const out = lines.map((l) => {
    if (new RegExp(`^\\s*${key}\\s*=`).test(l)) { found = true; return `${key}=${String(value)}` }
    return l
  })
  if (!found) out.push(`${key}=${String(value)}`)
  fs.writeFileSync(file, out.join('\n'), 'utf8')
  process.env[key] = String(value)
}
