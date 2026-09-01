import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { DATA_DIR } from './env.js'

// ================= 事件中心（后台动作 → 网页红点/动态/提示） =================
// 所有后台动作（邮件回信、账单导入、自动入账、月报发送）都推送到这里：
// - 持久化到 data/notify.json（保留最近 50 条）→ 托盘守护直接读文件弹气泡，无需开网页
// - 内存总线 → /api/events SSE 实时推给打开的网页
// - GET /api/notify → 网页"邮箱助手"动态列表拉取

const FILE = path.join(DATA_DIR, 'notify.json')
const bus = new EventEmitter()
bus.setMaxListeners(50)

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return { seq: 0, events: [] } }
}
function save(state) {
  try { fs.writeFileSync(FILE, JSON.stringify(state)) } catch { /* 写失败不影响主流程 */ }
}

// type: mail(邮箱回信) | bill(账单导入) | record(自动入账) | report(月报) | test
export function pushEvent(type, title, body = '') {
  const state = load()
  const ev = {
    id: (state.seq || 0) + 1,
    type: String(type || 'info').slice(0, 24),
    title: String(title || '').slice(0, 80),
    body: String(body || '').slice(0, 300),
    at: new Date().toISOString(),
  }
  state.seq = ev.id
  state.events = [ev, ...(state.events || [])].slice(0, 50)
  save(state)
  bus.emit('event', ev)
  return ev
}

// after 之后的事件（新的在前），limit 上限保护
export function recentEvents(after = 0, limit = 30) {
  const s = load()
  return { seq: s.seq || 0, events: (s.events || []).filter((e) => e.id > after).slice(0, limit) }
}

export function onEvent(fn) {
  bus.on('event', fn)
  return () => bus.off('event', fn)
}
