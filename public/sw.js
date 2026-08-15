/* PennyWise Service Worker：应用壳离线缓存；/api 请求永远走网络（失败由页面离线队列兜底） */
const CACHE = 'pennywise-v5'
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg']

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
