// 生成 iOS「快捷指令」文件（bplist 二进制 plist）：银行短信 → 自动 POST 到 PennyWise
// 用户导入后，在"快捷指令 App → 自动化 → 收到信息"里选择发卡银行号码并运行本指令，即可 0 点击自动记账。

function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

function intObj(n) {
  const b = Buffer.alloc(9)
  b[0] = 0x13 // int64
  b.writeBigInt64BE(BigInt(n), 1)
  return b
}

function strObjUTF16(s) {
  // Apple 惯例：UTF-16BE 字符串带 BOM
  const units = [0xfeff]
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0)
    if (cp <= 0xffff) units.push(cp)
    else {
      const v = cp - 0x10000
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    }
  }
  const byteLen = units.length * 2
  const head = byteLen < 15 ? Buffer.from([0x60 + byteLen]) : Buffer.concat([Buffer.from([0x6f]), intObj(byteLen)])
  const body = Buffer.alloc(byteLen)
  units.forEach((u, i) => body.writeUInt16BE(u, i * 2))
  return Buffer.concat([head, body])
}

function strObjAscii(s) {
  const bytes = Buffer.from(String(s), 'latin1')
  const n = bytes.length
  const head = n < 15 ? Buffer.from([0x50 + n]) : Buffer.concat([Buffer.from([0x5f]), intObj(n)])
  return Buffer.concat([head, bytes])
}

function arrObj(refs) {
  const n = refs.length
  const head = n < 15 ? Buffer.from([0xa0 + n]) : Buffer.concat([Buffer.from([0xaf]), intObj(n)])
  const body = Buffer.concat(refs.map(u64))
  return Buffer.concat([head, body])
}

function dictObj(entryRefs) {
  // entryRefs: [keyRef, valueRef, keyRef, valueRef, ...]
  const n = entryRefs.length / 2
  const head = n < 15 ? Buffer.from([0xd0 + n]) : Buffer.concat([Buffer.from([0xdf]), intObj(n)])
  const body = Buffer.concat(entryRefs.map(u64))
  return Buffer.concat([head, body])
}

function encodePlist(root) {
  const objects = []
  const seen = new Map()

  function add(obj) {
    const idx = objects.length
    objects.push(obj)
    return idx
  }
  function visit(v) {
    if (v === null || v === undefined) return add(Buffer.from([0x00]))
    switch (typeof v) {
      case 'boolean': return add(Buffer.from([v ? 0x09 : 0x08]))
      case 'number': return add(Number.isInteger(v) ? intObj(v) : Buffer.concat([Buffer.from([0x23]), (() => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b })()]))
      case 'string': return add(strObjUTF16(v))
    }
    if (seen.has(v)) return seen.get(v)
    const idx = objects.length
    seen.set(v, idx)
    objects.push(null) // 占位
    if (Array.isArray(v)) {
      const refs = v.map(visit)
      objects[idx] = arrObj(refs)
    } else {
      const entryRefs = []
      for (const k of Object.keys(v)) {
        entryRefs.push(add(strObjAscii(k)), visit(v[k]))
      }
      objects[idx] = dictObj(entryRefs)
    }
    return idx
  }

  const topIdx = visit(root)
  const offsets = []
  let out = Buffer.from('bplist00', 'ascii')
  for (const o of objects) {
    offsets.push(out.length)
    out = Buffer.concat([out, o])
  }
  const tableStart = out.length
  for (const off of offsets) out = Buffer.concat([out, u64(off)])
  const trailer = Buffer.alloc(32)
  // 5 字节保留 + sortVersion + offsetIntSize + objectRefSize + 三个 u64
  trailer.writeUInt8(0, 5)
  trailer.writeUInt8(8, 6) // offsetIntSize
  trailer.writeUInt8(8, 7) // objectRefSize
  trailer.writeBigUInt64BE(BigInt(objects.length), 8)
  trailer.writeBigUInt64BE(BigInt(topIdx), 16)
  trailer.writeBigUInt64BE(BigInt(tableStart), 24)
  return Buffer.concat([out, trailer])
}

// 快捷指令内容：接收短信文本 → POST 到服务器 → 通知
export function shortcutFile(serverUrl, token) {
  const inputRef = { Value: { Type: 'ExtensionInput' }, WFSerializationType: 'WFTextTokenAttachment' }
  const actions = [
    {
      WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl',
      WFWorkflowActionParameters: {
        WFURL: serverUrl + '/api/sms',
        WFHTTPMethod: 'POST',
        WFHTTPBodyType: 'File',
        WFHTTPBody: inputRef,
        WFHTTPHeaders: { 'X-Auth-Token': token },
      },
    },
    {
      WFWorkflowActionIdentifier: 'is.workflow.actions.notification',
      WFWorkflowActionParameters: {
        WFNotificationActionBody: '已发送到 PennyWise 记账',
        WFNotificationActionTitle: 'PennyWise',
        WFNotificationActionSound: false,
      },
    },
  ]
  return encodePlist({
    WFWorkflowClientVersion: '2800.0.1',
    WFWorkflowClientRelease: '3.0',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 3981346047, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowImportQuestions: [],
    WFWorkflowInputContentItemClasses: ['WFStringContentItem'],
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowTypes: [],
    WFWorkflowActions: actions,
  })
}
