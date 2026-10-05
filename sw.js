/* Match Alpha service worker (Fase A.6).
 *
 * - Same-origin GET assets: stale-while-revalidate.
 * - API GET /api/v1/web/* (read endpoints only): stale-while-revalidate (fresh copy < 60 s served
 *   at once; older copy served when the network is slow or down, flagged x-ma-stale / x-ma-offline so
 *   the page can say so). Responses are refreshed on every successful request.
 * - Never cached: non-GET, requests carrying an Authorization or X-Internal-Key header
 *   (internal/job keys travel there), non-/web/ API paths, non-OK or non-JSON responses.
 * - Caches are capped (MAX_API_ENTRIES / MAX_ASSET_ENTRIES), oldest entries evicted first.
 *
 * Registered with a relative URL/scope, so it works under the GitHub Pages prefix.
 */
const VERSION = 'v20261005st';
const ASSET_CACHE = `ma-assets-${VERSION}`;
const API_CACHE = 'ma-api-v1';
const MAX_API_ENTRIES = 80;
const MAX_ASSET_ENTRIES = 60;
const PRECACHE = ['./', './index.html', './manifest.json', './icons/icon.svg', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(ASSET_CACHE).then((cache) => cache.addAll(PRECACHE)).catch(() => null));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ma-assets-') && k !== ASSET_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

function isCacheableApi(request, url) {
  if (request.method !== 'GET') return false;
  if (request.headers.has('authorization') || request.headers.has('x-internal-key')) return false;
  return /\/api\/v1\/web\/[a-z-]+$/.test(url.pathname);
}

async function notifyOffline() {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => client.postMessage({ type: 'ma-offline-cache' }));
}

// API reads: stale-while-revalidate with a freshness window.
//   * cached copy younger than FRESH_MS → served immediately, refreshed in the background;
//   * older copy → network first, but if the network is slow (Render free tier waking up, > SLOW_MS) the
//     cached copy is served right away and the network response still updates the cache for next time;
//   * network failure → cached copy flagged x-ma-offline (banner "mostrando último dato").
const FRESH_MS = 60 * 1000;
const SLOW_MS = 4000;

async function putApi(cache, key, response) {
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.includes('application/json')) return;
  const headers = new Headers(response.headers);
  headers.set('x-ma-cached-at', String(Date.now()));
  await cache.put(key, new Response(await response.clone().blob(), { status: response.status, statusText: response.statusText, headers }));
  trimCache(API_CACHE, MAX_API_ENTRIES);
}

function flagged(hit, header) {
  return hit.blob().then((body) => {
    const headers = new Headers(hit.headers);
    headers.set(header, '1');
    return new Response(body, { status: hit.status, statusText: hit.statusText, headers });
  });
}

async function apiStaleWhileRevalidate(event) {
  const { request } = event;
  const cache = await caches.open(API_CACHE);
  // Cache key without auth: the URL only (read-only public data).
  const key = new Request(request.url, { method: 'GET' });
  const hit = await cache.match(key);
  const network = fetch(request).then(async (response) => {
    await putApi(cache, key, response);
    return response;
  });
  if (hit) {
    const age = Date.now() - Number(hit.headers.get('x-ma-cached-at') || 0);
    if (age < FRESH_MS) {
      event.waitUntil(network.catch(() => null));
      return hit;
    }
    const slow = new Promise((resolve) => setTimeout(resolve, SLOW_MS, 'slow'));
    try {
      const winner = await Promise.race([network, slow]);
      if (winner !== 'slow') return winner;
      event.waitUntil(network.catch(() => null));
      return flagged(hit, 'x-ma-stale');
    } catch {
      notifyOffline();
      return flagged(hit, 'x-ma-offline');
    }
  }
  return network;
}

async function assetStaleWhileRevalidate(event) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(event.request, { ignoreSearch: event.request.mode === 'navigate' });
  const network = fetch(event.request).then((response) => {
    if (response.ok && response.type === 'basic') {
      cache.put(event.request, response.clone()).then(() => trimCache(ASSET_CACHE, MAX_ASSET_ENTRIES));
    }
    return response;
  });
  if (hit) {
    event.waitUntil(network.catch(() => null));
    return hit;
  }
  try {
    return await network;
  } catch (error) {
    if (event.request.mode === 'navigate') {
      const shell = await cache.match('./index.html') || await cache.match('./');
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (isCacheableApi(request, url)) {
    event.respondWith(apiStaleWhileRevalidate(event));
    return;
  }
  if (url.origin === self.location.origin) event.respondWith(assetStaleWhileRevalidate(event));
});

// ─── Web Push (Fase H) ────────────────────────────────────────────────────────
// Payload (backend app/product/push.py): {title, body, url: "./?match=<uuid>", tag}. Only URLs inside this
// service worker's scope are opened (anything else falls back to the app root).
function scopedUrl(raw) {
  const scope = self.registration.scope;
  try {
    const url = new URL(String(raw || './'), scope);
    return url.href.startsWith(scope) ? url.href : scope;
  } catch {
    return scope;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = String(data.title || 'Match Alpha').slice(0, 120);
  const options = {
    body: String(data.body || 'Nuevo pick disponible').slice(0, 240),
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: String(data.tag || 'ma-pick').slice(0, 80),
    data: { url: scopedUrl(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = scopedUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((c) => c.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.navigate(target).catch(() => null);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
