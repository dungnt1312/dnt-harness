/**
 * Service worker template. The Vite build (`pwa-plugin.ts`) replaces the two
 * placeholders below with the build version and the app-shell file list, so
 * every client build ships a new worker that drops the previous caches.
 *
 * Strategy: the API and SSE streams are always live and never touched here;
 * navigations are network-first with the cached shell as offline fallback;
 * hashed build assets are cache-first.
 *
 * Precache is best-effort per file. `cache.addAll` is all-or-nothing and also
 * rejects any response a reverse proxy marks `Vary: *` (typical once gzip is
 * on) or redirects. One such response used to abort install, so the worker
 * never controlled the page and browsers hid the install icon everywhere
 * except a proxy-free localhost.
 */
const VERSION = '__PWA_VERSION__'
const PRECACHE = /** @type {string[]} */ (__PWA_PRECACHE__)
const CACHE_PREFIX = 'dnt-harness-'
/** Caches written before the rename from mini-dsh; dropped on activation. */
const LEGACY_CACHE_PREFIX = 'mini-dsh-'
const CACHE = `${CACHE_PREFIX}${VERSION}`

/** Whether the Cache API will accept this response. Opaque, errored, and `Vary: *` bodies are not. */
function cacheable(response) {
  if (!response || !response.ok || response.type === 'opaque') return false
  const vary = response.headers.get('vary')
  if (vary !== null && vary.split(',').some((part) => part.trim() === '*')) return false
  return true
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(
        PRECACHE.map(async (path) => {
          try {
            const response = await fetch(path, { cache: 'reload' })
            if (cacheable(response)) await cache.put(path, response)
          } catch {
            // A missing shell file must not block install; the page stays network-backed.
          }
        }),
      )
      await self.skipWaiting()
    }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => (key.startsWith(CACHE_PREFIX) && key !== CACHE) || key.startsWith(LEGACY_CACHE_PREFIX)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html').then((shell) => shell ?? Response.error())))
    return
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            // The server answers unknown paths with the HTML shell; never cache that as an asset.
            const isShell = (response.headers.get('content-type') ?? '').startsWith('text/html')
            if (cacheable(response) && !isShell) {
              const copy = response.clone()
              void caches.open(CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
  }
})

/**
 * Web Push from the host (automation results, approvals waiting). The payload
 * is `{ title, body, url, tag }`; `url` is a same-origin app path.
 */
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = typeof data.title === 'string' && data.title !== '' ? data.title : 'dnt-harness'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
    }),
  )
})

/** Focus an open app window on the target path, or open one. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (open !== undefined) {
        await open.focus()
        if ('navigate' in open) {
          try {
            await open.navigate(target)
            return
          } catch {
            // Uncontrolled windows refuse navigate(); fall through to a new one.
          }
        }
      }
      await self.clients.openWindow(target)
    }),
  )
})
