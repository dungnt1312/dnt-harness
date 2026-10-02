/**
 * Service worker template. The Vite build (`pwa-plugin.ts`) replaces the two
 * placeholders below with the build version and the app-shell file list, so
 * every client build ships a new worker that drops the previous caches.
 *
 * Strategy: the API and SSE streams are always live and never touched here;
 * navigations are network-first with the cached shell as offline fallback;
 * hashed build assets are cache-first.
 */
const VERSION = '__PWA_VERSION__'
const PRECACHE = /** @type {string[]} */ (__PWA_PRECACHE__)
const CACHE_PREFIX = 'dnt-harness-'
/** Caches written before the rename from mini-dsh; dropped on activation. */
const LEGACY_CACHE_PREFIX = 'mini-dsh-'
const CACHE = `${CACHE_PREFIX}${VERSION}`

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
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
            if (response.ok && !isShell) {
              const copy = response.clone()
              void caches.open(CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
  }
})
