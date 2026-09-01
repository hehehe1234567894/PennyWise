// 诊断工具：连接 .env 配置的邮箱，列出 INBOX 最近邮件（发件人/主题/时间，不读正文），
// 并扫描所有其他文件夹里「主题恰好为 PW」的邮件（排查是否被投进垃圾邮件等文件夹）。
// 用法：node scripts/mailcheck.mjs
import fs from 'node:fs'
import { ImapFlow } from 'imapflow'

const envFile = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
const env = Object.fromEntries(
  envFile.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const user = env.MAIL_USER || ''
const subjectKey = (env.MAIL_PW_SUBJECT || 'PW').trim().toLowerCase()
const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)

const c = new ImapFlow({
  host: env.MAIL_IMAP_HOST || 'imap.163.com',
  port: Number(env.MAIL_IMAP_PORT || 993),
  secure: true,
  auth: { user, pass: env.MAIL_PASS },
  logger: false,
})
await c.connect()

function fmt(m) {
  const e = m.envelope || {}
  const from = (e.from || []).map((f) => f.address).join(',')
  const d = e.date ? new Date(e.date).toLocaleString('zh-CN', { hour12: false }) : '?'
  return { uid: m.uid, d, from, subject: String(e.subject || '') }
}
const isMine = (f) => String(f).toLowerCase().includes(String(user).toLowerCase())
const isPw = (s, f) => String(s || '').trim().toLowerCase() === subjectKey && isMine(f)

try {
  const boxes = await c.list()
  const folders = (boxes || []).map((f) => f.path).filter(Boolean)
  console.log(`邮箱文件夹（${folders.length} 个）：${folders.join(' | ')}`)

  // 1) INBOX：列出最近 10 封的真实发件人/主题（诊断"为什么没匹配"）
  const inbox = env.MAIL_BOX || 'INBOX'
  const lock = await c.getMailboxLock(inbox)
  try {
    const total = c.mailbox.exists
    const start = Math.max(1, total - 9)
    const list = []
    for await (const m of c.fetch({ seq: `${start}:*` }, { envelope: true, uid: true })) list.push(fmt(m))
    list.sort((a, b) => a.uid - b.uid)
    console.log(`\n[INBOX] 共 ${total} 封，最近 ${list.length} 封（★ = 符合处理条件：自己发 + 主题 ${subjectKey.toUpperCase()}）：`)
    for (const m of list) {
      const mark = isPw(m.subject, m.from) ? '★' : ' '
      console.log(`  ${mark} uid=${m.uid} ${m.d} from=${m.from || '(空)'} subject=${JSON.stringify(m.subject)}`)
    }
  } finally { lock.release() }

  // 2) 其他文件夹：只报「主题 PW + 自己发」的命中（不展示其他邮件内容）
  console.log('\n[其他文件夹] 搜索最近 7 天内符合条件的 PW 邮件：')
  let foundElsewhere = 0
  for (const path of folders) {
    if (path === inbox) continue
    try {
      const l2 = await c.getMailboxLock(path)
      try {
        for await (const m of c.fetch({ since }, { envelope: true, uid: true })) {
          const f = fmt(m)
          if (isPw(f.subject, f.from)) { console.log(`  ★ ${path} uid=${f.uid} ${f.d} subject=${JSON.stringify(f.subject)}`); foundElsewhere++ }
        }
      } finally { l2.release() }
    } catch { /* 文件夹打不开就跳过 */ }
  }
  if (!foundElsewhere) console.log('  （无）')
  console.log('\n结论：若 INBOX 无 ★ 且其他文件夹也无 ★ → 邮件未到达此邮箱，或发件人/主题不符（红线：发件人必须是 ' + user + '，主题必须恰好是 ' + subjectKey.toUpperCase() + '）')
} finally {
  await c.logout().catch(() => {})
}
