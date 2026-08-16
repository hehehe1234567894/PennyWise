/* PennyWise Service Worker：应用壳缓存 + 分享接收（截图/文本直达账本，无需快捷指令） */
const CACHE = 'pennywise-v22'
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg']

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
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // 分享入口：截图/文本 → 本地账本 → 回到应用
  if (e.request.method === 'POST' && url.pathname === '/share') {
    e.respondWith(handleShare(e.request))
    return
  }
  if (e.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/')) return // 网络直通，不缓存
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit
      return fetch(e.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const clone = res.clone()
          caches.open(CACHE).then((c) => c.put(e.request, clone))
        }
        return res
      }).catch(() => (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))
    })
  )
})
