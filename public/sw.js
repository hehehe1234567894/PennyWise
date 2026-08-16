/* PennyWise Service Worker v28（极简版）
   - 不再缓存任何文件：页面请求全部直连服务器，永远是最新界面（历史缓存曾导致旧版界面卡死）
   - 安装/激活时清空全部历史缓存，并把已打开的旧页面自动刷新一次
   - 只保留分享接收（POST /share → 本地镜像 → 回到应用） */
function uidGen() {
  return (crypto.randomUUID && crypto.randomUUID()) || 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

// 写入与 app.js 共用的本地镜像（pw-mirror）：交易 + 待同步队列
function saveShared(entry) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('pw-mirror', 1)
    r.onupgradeneeded = () => {
      const d = r.result
      if (!d.objectStoreNames.contains('tx')) d.createObjectStore('tx', { keyPath: 'uid' })
      if (!d.objectStoreNames.contains('ops')) d.createObjectStore('ops', { keyPath: 'uid' })
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' })
    }
    r.onsuccess = () => {
      const db = r.result
      const t = db.transaction(['tx', 'ops'], 'readwrite')
      t.objectStore('tx').put(entry.tx)
      t.objectStore('ops').put(entry.op)
      t.oncomplete = () => { db.close(); resolve() }
      t.onerror = () => { db.close(); reject(t.error) }
    }
    r.onerror = () => reject(r.error)
  })
}

async function handleShare(req) {
  try {
    const fd = await req.formData()
    const text = String(fd.get('text') || fd.get('title') || '').trim()
    const file = fd.get('file')
    const now = new Date().toISOString()
    const uid = uidGen()
    const base = {
      uid, ts: now, created_at: now, amount: null, currency: 'CNY', direction: 'expense',
      merchant: '', goods_name: '', category: '其他', account: 'other',
      raw_text: text, raw_image: null, status: 'pending', confidence: null, note: '',
    }
    if (file && file.size > 0 && String(file.type).startsWith('image/')) {
      const buf = await file.arrayBuffer()
      const b64 = bufToB64(buf)
      const tx = Object.assign({}, base, { source: 'image', local_image: b64, local_mime: file.type })
      await saveShared({ tx, op: { uid, type: 'put', data: Object.assign({}, tx, { image_base64: b64 }), updated_at: now } })
      return Response.redirect('/?shared=image', 303)
    }
    if (text) {
      const tx = Object.assign({}, base, { source: 'text' })
      await saveShared({ tx, op: { uid, type: 'put', data: tx, updated_at: now } })
      return Response.redirect('/?shared=text', 303)
    }
    return Response.redirect('/?shared=0', 303)
  } catch (e) {
    return Response.redirect('/?shared=0', 303)
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 清空全部历史缓存
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k)))
    await self.clients.claim()
    // 救援旧页面：新版页面自己决定是否刷新；没响应的（旧代码已崩溃）1.2 秒后强制刷新
    const cs = await self.clients.matchAll({ type: 'window' })
    for (const c of cs) {
      try {
        let responded = false
        const channel = new MessageChannel()
        const timer = setTimeout(() => { if (!responded) c.navigate(c.url).catch(() => {}) }, 1200)
        channel.port1.onmessage = () => { responded = true; clearTimeout(timer) }
        c.postMessage({ type: 'pw-update' }, [channel.port2])
      } catch { /* 页面不可达则忽略 */ }
    }
  })())
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // 只接管分享入口，其余请求一律不拦截 → 直连服务器，永远最新
  if (e.request.method === 'POST' && url.pathname === '/share') {
    e.respondWith(handleShare(e.request))
    return
  }
})
