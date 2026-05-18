// Background Radio service worker.
// 模式:cache-first + 后台 revalidate + ETag/content-length diff 检测 → 通知页面"有新版本",
// 页面非阻塞 toast,用户点刷新才 skipWaiting + reload(永不自动 reload,跟 WebXiaoHeiWu 同套路)。
//
// 改了任何 precache 文件之后,bump CACHE_VERSION;activate 会清掉旧 cache。
// skipWaiting + clients.claim 让新 SW 在下次刷新时立即接管。

const CACHE_VERSION = "v13-2026-05-18-manual-cache-only";
const CACHE_NAME = `br-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./auth.js",
  "./cache.js",
  "./config.js",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("br-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Cache-first with background revalidate.
// 命中 cache 立即返回;同时后台 fetch 网络新版本,若 ETag(或 content-length 兜底)与缓存不同,
// post message "asset-updated" 到所有页面。页面 toast 提示用户刷新。
// 永不自动 reload —— 用户可能在听一首歌中间,reload 会重置 audio 状态。

let updateAnnouncedThisLoad = false;

async function notifyUpdate(url) {
  if (updateAnnouncedThisLoad) return;
  updateAnnouncedThisLoad = true;
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clientsList) {
    client.postMessage({ type: "asset-updated", url });
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 跨源(Graph、MSAL CDN、OneDrive 下载)→ passthrough,不 cache(SSOT 原则)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);

      const networkFetch = fetch(req)
        .then((response) => {
          if (response && response.ok) {
            if (cached) {
              const cachedEtag = cached.headers.get("etag");
              const freshEtag = response.headers.get("etag");
              const cachedLen = cached.headers.get("content-length");
              const freshLen = response.headers.get("content-length");
              const changed =
                (cachedEtag && freshEtag && cachedEtag !== freshEtag) ||
                (!cachedEtag && cachedLen && freshLen && cachedLen !== freshLen);
              if (changed) {
                notifyUpdate(req.url).catch(() => {});
              }
            }
            cache.put(req, response.clone()).catch(() => {});
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        // 拿到 cache 先返回,网络 fetch 在后台跑(不能 await,会破坏 cache-first 的快)
        networkFetch.catch(() => {});
        return cached;
      }

      // cache miss:必须等网络
      const response = await networkFetch;
      if (response) return response;

      // 离线 + 没缓存:navigation 兜底到 index.html;其它返回 503
      if (req.mode === "navigate") {
        const fallback = await cache.match("./index.html");
        if (fallback) return fallback;
      }
      return new Response("offline & not cached", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") {
    self.skipWaiting();
  }
});
