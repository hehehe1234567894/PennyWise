import { env } from './env.js'
import { db } from './db.js'
import { ImapFlow } from 'imapflow'
import { parseMime } from './importer.js'
import { detectImage, captureImageCore } from './capture-core.js'
import { agentChat, agentPhraseImageResult } from './agent.js'
import { mailerConfig, sendEmail } from './reporter.js'

// ================= 邮箱沟通 AI Agent（只读"自己发的、主题为 PW"的邮件） =================

function seenUids() {
  try { return new Set(JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'mail_seen_uids'").get()?.v || '[]')) } catch { return new Set() }
}
function saveSeen(set) {
  const arr = [...set].slice(-400)
  db.prepare("INSERT INTO meta (k, v) VALUES ('mail_seen_uids', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(arr))
}
function replyHtml(text) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.7">${esc(text).replace(/\n/g, '<br>')}</div>`
}

// 处理一封 PW 邮件：返回 {kind, reply}
export async function processPwMail(text, attachments, threshold) {
  const img = (attachments || []).find((a) => detectImage(a.buffer))
  if (img) {
    const mime = detectImage(img.buffer)
    const { transaction, parse } = await captureImageCore(img.buffer, mime, null, 'email', threshold)
    const summary = parse.code === 'ok'
      ? `${transaction.merchant} ¥${transaction.amount}（${transaction.goods_name || ''}），置信度 ${Math.round((transaction.confidence || 0) * 100)}%`
      : `识别失败（${parse.error || parse.code}）`
    const phrased = await agentPhraseImageResult(summary)
    return { kind: 'image', reply: phrased || summary }
  }
  const q = String(text || '').trim()
  if (!q) return { kind: 'empty', reply: '没有可处理的内容：把交易文本写在正文、附支付截图即可记账；也可以直接问"想买 XX，有平替推荐吗"或"这个月我花了多少"。' }
  // AI Agent 路由：record / recommend / ledger / chat（与网页聊天共用）
  return agentChat(q, threshold)
}

export async function pollMailCapture(cfg, threshold) {
  if (!cfg.imapConfigured) return { processed: 0, error: '未配置邮箱 IMAP（MAIL_USER/MAIL_PASS）' }
  const subjectKey = env('MAIL_PW_SUBJECT', 'PW').trim().toLowerCase()
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  })
  await client.connect()
  const lock = await client.getMailboxLock(cfg.box)
  const seen = seenUids()
  const results = []
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    for await (const msg of client.fetch({ since }, { uid: true, envelope: true, source: true }, { uid: true })) {
      if (seen.has(msg.uid)) continue
      seen.add(msg.uid)
      // 隐私红线：只处理"自己发的 + 主题为 PW"的邮件，其余一律不碰
      const from = (msg.envelope.from || []).map((f) => f.address || '').join(' ').trim().toLowerCase()
      if (from !== String(cfg.user || '').trim().toLowerCase()) continue
      const subject = String(msg.envelope.subject || '').trim()
      if (subject.toLowerCase() !== subjectKey) continue
      const { text, files } = parseMime(msg.source || Buffer.alloc(0))
      let r
      try {
        r = await processPwMail(text, files, threshold)
      } catch (e) {
        r = { kind: 'error', reply: '处理失败：' + String(e?.message || e).slice(0, 100) }
      }
      results.push({ uid: msg.uid, subject, kind: r.kind, reply: r.reply })
      if (mailerConfig().enabled) {
        try { await sendEmail('PennyWise 回复', replyHtml(r.reply)) } catch { /* 回信失败不影响处理 */ }
      }
    }
  } finally {
    lock.release()
    await client.logout()
    saveSeen(seen)
  }
  return { processed: results.length, results, error: '' }
}
