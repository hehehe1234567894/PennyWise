import { env } from './env.js'
import { db, nowIso, validTs } from './db.js'
import { ImapFlow } from 'imapflow'
import { parseMime } from './importer.js'
import { detectImage, captureImageCore, insertFieldsTx } from './capture-core.js'
import { agentRoute, agentPhraseImageResult } from './agent.js'
import { recommendAlternatives } from './recommend.js'
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
  // AI Agent 路由：record / recommend / ledger / chat
  const route = await agentRoute(q)
  if (route.intent === 'record' && route.fields) {
    const f = route.fields
    const fields = {
      ts: validTs(f.ts) || nowIso(),
      amount: Number(f.amount) > 0 ? Math.round(Number(f.amount) * 100) / 100 : null,
      direction: ['expense', 'income', 'refund', 'transfer'].includes(f.direction) ? f.direction : 'expense',
      merchant: String(f.merchant || '').trim().slice(0, 120),
      goods_name: String(f.goods_name || '').trim().slice(0, 120),
      category: f.direction === 'expense' ? String(f.category || '其他').trim().slice(0, 20) : null,
      account: ['wechat', 'alipay', 'bank', 'cash', 'other'].includes(f.account) ? f.account : 'other',
      note: String(f.note || '').trim().slice(0, 200),
      confidence: Number.isFinite(Number(f.confidence)) ? Math.min(1, Math.max(0, Number(f.confidence))) : null,
    }
    if (fields.amount == null) {
      return { kind: 'record_fail', reply: route.reply || '没能从内容里确认金额，请补充金额后重发。' }
    }
    const { status } = insertFieldsTx(fields, q, null, 'email', threshold)
    const tail = status === 'confirmed' ? '已自动入账 ✓' : '已记入待处理，请到 PennyWise 确认'
    return { kind: 'record', reply: `${route.reply || '已记账'}\n（${tail}）` }
  }
  if (route.intent === 'recommend') {
    const r = await recommendAlternatives(q)
    return { kind: 'recommend', reply: r.text }
  }
  return { kind: route.intent || 'chat', reply: route.reply || '收到。' }
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
