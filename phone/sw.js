'use strict';

const CACHE_PREFIX = 'dji-field-ui-';
const CACHE_NAME = 'dji-field-ui-v4';
const PAGE_URL = new URL('./index.html', self.location.href).href;
const ROOT_URL = new URL('./', self.location.href).href;
const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.mjs',
  './ble-client.mjs',
  './manifest.webmanifest',
  '../schema/actions.json',
  './icons/recorder.svg',
  './icons/recorder-192.png',
  './icons/recorder-512.png',
].map(path => new URL(path, self.location.href).href);
const STATIC_URLS = new Set(PRECACHE_URLS);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll commits one batch only after every required response succeeds.
    // A failed install cannot activate a partially populated app shell.
    await cache.addAll(PRECACHE_URLS.map(url => new Request(url, {
      cache: 'reload',
      redirect: 'error',
    })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function refreshStatic(url, cache) {
  // Only the explicit static shell is fetched/cached, never controller data.
  const response = await fetch(new Request(url, {
    cache: 'no-cache',
    redirect: 'error',
  }));
  if (response.ok && response.type === 'basic' &&
      new URL(response.url).origin === self.location.origin) {
    await cache.put(url, response.clone());
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  let cacheUrl = url.href;
  if (request.mode === 'navigate') {
    // Keep the visible query (including ?mock=1), but reuse the static page.
    url.search = '';
    url.hash = '';
    if (url.href !== ROOT_URL && url.href !== PAGE_URL) return;
    cacheUrl = PAGE_URL;
  } else if (!STATIC_URLS.has(cacheUrl)) {
    return;
  }

  // Register the lifetime promise synchronously, including the cache lookup.
  const response = (async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(cacheUrl);
    const refresh = refreshStatic(cacheUrl, cache);
    if (cached) {
      return { response: cached, refresh: refresh.catch(() => {}) };
    }
    return { response: await refresh };
  })();
  event.respondWith(response.then(result => result.response));
  event.waitUntil(response.then(result => result.refresh).catch(() => {}));
});
