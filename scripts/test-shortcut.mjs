// 验证生成的 .shortcut 文件是合法 bplist 且结构正确
// 用法: node scripts/test-shortcut.mjs
import { shortcutFile } from '../server/shortcut.js'

function parsePlist(buf) {
  if (buf.slice(0, 8).toString('ascii') !== 'bplist00') throw new Error('bad magic')
  const trailer = buf.slice(buf.length - 32)
  const numObjects = Number(trailer.readBigUInt64BE(8))
  const topObject = Number(trailer.readBigUInt64BE(16))
  const tableStart = Number(trailer.readBigUInt64BE(24))
  const offSize = trailer.readUInt8(6)
  const offsets = []
  for (let i = 0; i < numObjects; i++) offsets.push(Number(buf.readBigUInt64BE(tableStart + i * offSize)))

  function readObject(idx) {
    const pos = offsets[idx]
    if (pos === undefined) throw new Error('bad ref ' + idx)
    const marker = buf[pos]
    const type = marker >> 4
    let len = marker & 0x0f
    let p = pos + 1
    const readLen = () => {
      if (len !== 0x0f) return len
      const n = 1 << (buf[p] & 0x03) // 长度整数的大小（1/2/4/8 字节）
      len = Number(n === 8 ? buf.readBigUInt64BE(p + 1) : buf.readUIntBE(p + 1, n))
      p += 1 + n
      return len
    }
    if (type === 0) {
      if (marker === 0x00) return null
      if (marker === 0x08) return false
      if (marker === 0x09) return true
      throw new Error('unknown primitive ' + marker)
    }
    if (type === 1) {
      const n = 1 << (marker & 0x03)
      return n === 8 ? Number(buf.readBigInt64BE(p)) : buf.readIntBE(p, n)
    }
    if (type === 2) {
      const n = 1 << (marker & 0x03)
      return n === 8 ? buf.readDoubleBE(p) : buf.readFloatBE(p)
    }
    if (type === 3 && marker === 0x33) {
      return new Date((buf.readDoubleBE(p) + 978307200) * 1000).toISOString()
    }
    if (type === 5) { const n = readLen(); return buf.toString('latin1', p, p + n) }
    if (type === 6) {
      const n = readLen()
      let s = ''
      for (let i = p + 2; i + 1 < p + n; i += 2) s += String.fromCharCode(buf.readUInt16BE(i)) // 跳过 BOM，大端
      return s
    }
    if (type === 10) {
      const n = readLen()
      const refs = []
      for (let i = 0; i < n; i++) { refs.push(readObject(Number(buf.readBigUInt64BE(p)))); p += 8 }
      return refs
    }
    if (type === 13) {
      const n = readLen()
      const out = {}
      for (let i = 0; i < n; i++) {
        const k = readObject(Number(buf.readBigUInt64BE(p))); p += 8
        const v = readObject(Number(buf.readBigUInt64BE(p))); p += 8
        out[k] = v
      }
      return out
    }
    throw new Error('unhandled type ' + type)
  }
  return readObject(topObject)
}

const buf = shortcutFile('http://100.99.123.56:8720', 'pw-test-token')
const top = parsePlist(buf)

const checks = []
const ck = (name, cond) => { checks.push([name, cond]); console.log((cond ? 'PASS  ' : 'FAIL  ') + name) }

ck('top-level is dict', top && typeof top === 'object' && !Array.isArray(top))
ck('has WFWorkflowActions', Array.isArray(top.WFWorkflowActions))
ck('two actions', top.WFWorkflowActions?.length === 2)
ck('first action is downloadurl', top.WFWorkflowActions?.[0]?.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl')
ck('url points to /api/sms', String(top.WFWorkflowActions?.[0]?.WFWorkflowActionParameters?.WFURL).endsWith('/api/sms'))
ck('POST method', top.WFWorkflowActions?.[0]?.WFWorkflowActionParameters?.WFHTTPMethod === 'POST')
ck('auth header embedded', top.WFWorkflowActions?.[0]?.WFWorkflowActionParameters?.WFHTTPHeaders?.['X-Auth-Token'] === 'pw-test-token')
const bodyRef = top.WFWorkflowActions?.[0]?.WFWorkflowActionParameters?.WFHTTPBody
ck('body is ExtensionInput ref', bodyRef?.Value?.Type === 'ExtensionInput' && bodyRef?.WFSerializationType === 'WFTextTokenAttachment')
ck('input class accepts text', Array.isArray(top.WFWorkflowInputContentItemClasses) && top.WFWorkflowInputContentItemClasses.includes('WFStringContentItem'))
ck('file size sane', buf.length > 500 && buf.length < 10000)

const failed = checks.filter(([, ok]) => !ok).length
console.log(`\nResult: ${checks.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
