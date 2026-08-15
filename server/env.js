import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const DATA_DIR = path.join(ROOT, 'data')
export const PUBLIC_DIR = path.join(ROOT, 'public')

// 极简 .env 加载：不依赖 dotenv 包，`npm start` 开箱即用
;(function loadDotEnv() {
  const file = process.env.PENNYWISE_ENV_FILE || path.join(ROOT, '.env')
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return }
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
