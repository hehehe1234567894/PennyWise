import { db, nowIso } from './db.js'
import { ImapFlow } from 'imapflow'
import { detectImage, captureTextCore, captureImageCore } from './capture-core.js'

// ================= 邮箱记账（给自己发邮件 = 记账，自动回复结果） =================

// 处理一封邮件：附件截图 → 视觉识别；正文文本 → 文本解析；返回回复内容
export async function processMailMessage({ subject, text, attachments }, threshold) {
  const img = (attachments || []).find((a) => detectImage(a.content))
  if (img) {
    const mime = detectImage(img.content)
    const { transaction, parse } = await captureImageCore(img.content, mime, null, 'email', threshold)
    if (parse.code === 'ok') {
      return transaction.status === 'confirmed'
        ? { kind: 'captured', reply: `已自动记账 ✓ ${transaction.merchant} ¥${transaction.amount}（置信度 ${Math.round((transaction.confidence || 0) * 100)}%）` }
        : { kind: 'captured', reply: `已记账待确认：${transaction.merchant} ¥${transaction.amount ?? '?'}（置信度 ${Math.round((transaction.confidence || 0) * 100)}%），请打开 PennyWise 确认` }
    }
    return { kind: 'captured', reply: `图片已收到，但 AI 识别失败（${parse.error || parse.code}），请在 PennyWise 手动填写` }
  }
  if (text && text.trim()) {
    const { transaction, parse } = await captureTextCore(text.trim(), null, 'email', threshold)
    if (parse.code === 'ok') {
      return transaction.status === 'confirmed'
        ? { kind: 'captured', reply: `已自动记账 ✓ ${transaction.merchant} ¥${transaction.amount}（置信度 ${Math.round((transaction.confidence || 0) * 100)}%）` }
        : { kind: 'captured', reply: `已记账待确认：${transaction.merchant} ¥${transaction.amount ?? '?'}，请打开 PennyWise 确认` }
    }
    return { kind: 'captured', reply: `已收到，但 AI 解析失败（${parse.error || parse.code}），请在 PennyWise 手动填写` }
  }
  return { kind: 'ignore', reply: '没有收到可记账的内容：请把交易文本写在正文，或附上支付截图' }
}

function seenUids() {
  try { return new Set(JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'mail_seen_uids'").get()?.v || '[]')) } catch { return new Set() }
}
function saveSeen(set) {
  const arr = [...set].slice(-300)
  db.prepare("INSERT INTO meta (k, v) VALUES ('mail_seen_uids', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(arr))
}

// 轮询邮箱：只处理"自己发给自己"的邮件，处理过的 uid 不重复
export async function pollMailCapture(cfg, threshold) {
  if (!cfg.imapConfigured) return { processed: 0, error: '未配置邮箱 IMAP（MAIL_USER/MAIL_PASS）' }
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
    for await (const msg of client.fetch({ since }, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
      if (seen.has(msg.uid)) continue
      seen.add(msg.uid)
      const from = (msg.envelope.from || []).map((f) => f.address || '').join('').trim().toLowerCase()
      if (from !== String(cfg.user || '').trim().toLowerCase()) continue // 只处理自己发来的
      const atts = []
      for (const att of msg.attachments || []) {
        if (!att.filename) continue
        try { atts.push({ filename: att.filename, content: await client.download(att, msg.uid) }) } catch { /* 单个附件失败忽略 */ }
      }
      const text = (msg.text || '').toString()
      try {
        const r = await processMailMessage({ subject: msg.envelope.subject || '', text, attachments: atts }, threshold)
        results.push({ uid: msg.uid, subject: msg.envelope.subject || '', ...r })
      } catch (e) {
        results.push({ uid: msg.uid, subject: msg.envelope.subject || '', kind: 'error', reply: '处理失败' })
      }
    }
  } finally {
    lock.release()
    await client.logout()
    saveSeen(seen)
  }
  return { processed: results.length, results, error: '' }
}

export function lastCaptureRunNote() {
  return nowIso()
}
