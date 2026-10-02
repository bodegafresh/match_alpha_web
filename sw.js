/* Match Alpha service worker (Fase A.6).
 *
 * - Same-origin GET assets: stale-while-revalidate.
 * - API GET /api/v1/web/* (read endpoints only): network-first with cache fallback
 *   (served "stale" when offline, flagged with the x-ma-offline header so the page can
 *   show "Sin conexión — mostrando último dato"). Responses are refreshed on every
 *   successful request.
 * - Never cached: non-GET, requests carrying an Authorization or X-Internal-Key header
 *   (internal/job keys travel there), non-/web/ API paths, non-OK or non-JSON responses.
 * - Caches are capped (MAX_API_ENTRIES / MAX_ASSET_ENTRIES), oldest entries evicted first.
 *
 * Registered with a relative URL/scope, so it works under the GitHub Pages prefix.
 */
const VERSION = 'v20261002h2h';
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

async function apiNetworkFirst(request) {
  const cache = await caches.open(API_CACHE);
  // Cache key without auth: the URL only (read-only public data).
  const key = new Request(request.url, { method: 'GET' });
  try {
    const response = await fetch(request);
    const type = response.headers.get('content-type') || '';
    if (response.ok && type.includes('application/json')) {
      await cache.put(key, response.clone());
      trimCache(API_CACHE, MAX_API_ENTRIES);
    }
    return response;
  } catch (error) {
    const hit = await cache.match(key);
    if (!hit) throw error;
    notifyOffline();
    const headers = new Headers(hit.headers);
    headers.set('x-ma-offline', '1');
    return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
  }
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
    event.respondWith(apiNetworkFirst(request));
    return;
  }
  if (url.origin === self.location.origin) event.respondWith(assetStaleWhileRevalidate(event));
});
