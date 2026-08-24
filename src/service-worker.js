/* MixelParse PWA service worker.
 * Strategy:
 *  - App shell (index.html): NETWORK-FIRST with cache fallback, so a frequently
 *    updated app never serves a stale build while online, but still opens offline.
 *  - Same-origin static (icons, manifest): cache-first.
 *  - CDN libs + fonts (jsdelivr, Google Fonts): cache-first (versioned URLs).
 *  - Supabase REST / Edge Functions / auth: NEVER cached — always network, so data
 *    is live and never leaks between sessions in the cache.
 * Bump CACHE_VERSION on any shell/asset change to roll caches.
 */
const CACHE_VERSION = 'mixelparse-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isSupabase(url) {
  return url.hostname.endsWith('supabase.co');   // REST, Edge Functions, auth, storage — all dynamic
}
function isCacheableCDN(url) {
  return url.hostname === 'cdn.jsdelivr.net'
      || url.hostname === 'fonts.googleapis.com'
      || url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                // never touch writes
  const url = new URL(req.url);

  // Supabase data/auth: straight to network, no caching.
  if (isSupabase(url)) return;

  // Navigations / the HTML shell: network-first, fall back to cache offline.
  if (req.mode === 'navigate' || (url.origin === self.location.origin && req.destination === 'document')) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Cacheable CDN libs/fonts + same-origin static: cache-first, populate on miss.
  if (isCacheableCDN(url) || url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }
  // everything else: default network
});
