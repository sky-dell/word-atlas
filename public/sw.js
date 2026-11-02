/* Names belong to this application AND registration scope, not the whole origin. */
const PREFIX = `word-atlas:${self.registration.scope}:`;
const VERSION = "v2";
const SHELL = `${PREFIX}${VERSION}-shell`;
const MEDIA = `${PREFIX}${VERSION}-media`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== SHELL && k !== MEDIA).map((k) => caches.delete(k))))
      .then(async () => {
        // Older releases cached all same-origin GETs. Purge identity data from
        // every application scope, without deleting another application's cache.
        for (const name of await caches.keys()) {
          if (!name.startsWith('word-atlas:')) continue;
          const cache=await caches.open(name);
          for (const request of await cache.keys()) {
            const url=new URL(typeof request==='string'?request:request.url);
            if (/(?:^|\/)api(?:\/|$)/.test(url.pathname)) await cache.delete(request);
          }
        }
      })
      .then(() => self.clients.claim()),
  );
});

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (/(?:^|\/)api(?:\/|$)/.test(url.pathname)) return;
  if (url.origin !== location.origin || !url.href.startsWith(self.registration.scope)) return;
  const media = /\/atlas\/(img|thumb|audio)\//.test(url.pathname);
  const response = (async () => {
    let cache;
    try { cache = await caches.open(media ? MEDIA : SHELL); } catch { /* Network still works when storage is unavailable. */ }
    const match = async (key) => { try { return await cache?.match(key); } catch { return undefined; } };
    const hit = await match(req);
    if (media && hit) return hit;
    // App code, manifests and data must refresh even when their URL is unchanged.
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic" && cache && !/\bno-store\b/i.test(res.headers.get('Cache-Control') || '')) {
        const copy = res.clone();
        try {
          await cache.put(req, copy);
          if (req.mode === "navigate") await cache.put(self.registration.scope, res.clone());
          if (media) await trim(MEDIA, 1500);
        } catch { /* Quota/cache errors must not turn a successful fetch into an offline error. */ }
      }
      if (res.status >= 500 && hit) return hit;
      return res;
    } catch (error) {
      const fallback = hit || (req.mode === "navigate" && await match(self.registration.scope));
      if (fallback) return fallback;
      throw error;
    }
  })();
  event.respondWith(response);
  // Keep writes and trimming alive; register while the fetch event is dispatching.
  event.waitUntil(response.then(() => undefined, () => undefined));
});
