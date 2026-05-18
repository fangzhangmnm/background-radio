// Background Radio service worker — option 1: passthrough + static cache only.
// 不缓存任何 Graph metadata / MSAL CDN / OneDrive 下载流。OneDrive 是 SSOT。
//
// 改了静态文件之后,bump CACHE_VERSION 让旧 cache 失效。
const CACHE_VERSION = "v1";
const CACHE_NAME = `br-static-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./auth.js",
  "./config.js",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 跨源:Graph、MSAL CDN、OneDrive 下载、Microsoft 登录页 —— 全部 passthrough,不参与 SW
  if (url.origin !== self.location.origin) return;

  // 同源 GET:cache-first;若 cache 未命中走网络,但不主动写回 cache(避免缓存意外资源)
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).catch(() => {
        // 离线且未缓存:对 navigation 请求兜底到 index.html(让 app shell 起来)
        if (req.mode === "navigate") {
          return caches.match("./index.html");
        }
        // 其它资源:返回 503 让前端自己处理
        return new Response("offline", { status: 503, statusText: "offline" });
      });
    })
  );
});
