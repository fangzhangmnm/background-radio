# Service Worker — 静态 cache、SWR、热更新 toast

## TL;DR

- SW 用 **cache-first + 后台 revalidate(SWR)**,而不是 cache-only 或 network-first。冷启动用 cache,后台 fetch 跟新版本对比,差异时**通知页面**。
- 静态 shell(HTML / JS / CSS / icons / manifest)全 precache。**跨源资源默认 passthrough**,除非明确知道是 immutable vendor lib(MSAL.js 钉版本是例外)。
- 热更新 toast 走 **3 条独立通路**,任一触发都弹:
  1. SW 后台 SWR 发现 ETag / content-length 变了 → postMessage `asset-updated`
  2. 注册时发现已有 `registration.waiting` 的新 SW + 当前还有 controller → 立刻弹
  3. `updatefound` + `statechange === "installed"` → 新 SW 刚装完那一刻弹
- **永不自动 reload**。toast 给用户"刷新"按钮,点了才 `postMessage skip-waiting` + `location.reload()`。用户可能正在听一首歌中间。
- `localhost` 跳过 SW 注册,本地 F5 是真刷新不被 cache 折腾。
- `cache.addAll` 整批失败会让 install 直接挂掉。**关键(同源)用 addAll,best-effort(跨源 vendor lib)用 Promise.all + catch**,失败不影响其它东西。

## CACHE_VERSION 命名

```js
const CACHE_VERSION = "v25-2026-05-19-unified-resume-position";
const CACHE_NAME = `br-${CACHE_VERSION}`;
```

带日期 + 简短描述。每改 precache 文件就 bump,activate 阶段把 `br-*` 旧 cache 删干净:

```js
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("br-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});
```

`skipWaiting + claim`:新 SW 一装完立即接管,不用关 tab 重开。但这只决定**SW 自己**的接管,**已经渲染的页面 DOM 不会重新加载**,要 reload 才能用上新 cached assets。

## 防御性 install

```js
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const sameOrigin = PRECACHE_URLS.filter((u) => !/^https?:/i.test(u));
    await cache.addAll(sameOrigin);   // 关键:全部成功才算 install
    const crossOrigin = PRECACHE_URLS.filter((u) => /^https?:/i.test(u));
    await Promise.all(crossOrigin.map((u) =>
      cache.add(u).catch((e) =>
        console.warn("[SW] precache 失败(忽略):", u, e?.message)
      )
    ));
    await self.skipWaiting();
  })());
});
```

为什么这样:`cache.addAll(crossOriginUrl)` 一旦失败(对方 CORS 抖一下、jsdelivr 短暂 503),**整个 install 失败,SW 不 activate**。用户卡在旧 SW + 旧代码上,体感"什么 update 都没生效"。把跨源单独剥出来 best-effort,失败只是 warn,SW 仍然装上,SWR 在下次实际 fetch 那个 URL 时补 cache。

## SWR fetch handler

```js
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 跨源默认 passthrough(SSOT 原则,不假装能 cache 上游 mutable state)
  // 例外:MSAL CDN 钉在 MSAL_VERSION 上,等同 vendor lib,可以 cache
  if (url.origin !== self.location.origin && !isMsalCdnRequest(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    const networkFetch = fetch(req).then((response) => {
      if (response && response.ok) {
        if (cached) {
          // 比对 ETag / content-length,变了通知页面有新版本
          const cE = cached.headers.get("etag");
          const fE = response.headers.get("etag");
          const cL = cached.headers.get("content-length");
          const fL = response.headers.get("content-length");
          const changed = (cE && fE && cE !== fE) ||
                          (!cE && cL && fL && cL !== fL);
          if (changed) notifyUpdate(req.url).catch(() => {});
        }
        cache.put(req, response.clone()).catch(() => {});
      }
      return response;
    }).catch(() => null);

    if (cached) {
      networkFetch.catch(() => {});  // 后台跑,不等
      return cached;                  // 立即返回缓存,瞬开
    }
    // cache miss → 等网络
    const response = await networkFetch;
    if (response) return response;
    // 离线兜底:navigate 给 index.html
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("offline & not cached", { status: 503 });
  })());
});
```

`notifyUpdate` 把 message 推到所有 client:

```js
let updateAnnouncedThisLoad = false;
async function notifyUpdate(url) {
  if (updateAnnouncedThisLoad) return;  // 本次 SW 生命周期内只弹一次
  updateAnnouncedThisLoad = true;
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clientsList) {
    client.postMessage({ type: "asset-updated", url });
  }
}
```

## 页面侧:3 通路触发 + skip-waiting handler

```js
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // 通路 (1):SW 发现 asset 内容变了
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "asset-updated") showUpdateToast();
  });

  window.addEventListener("load", async () => {
    let registration;
    try {
      registration = await navigator.serviceWorker.register("./service-worker.js");
    } catch (e) {
      console.warn("SW 注册失败:", e);
      return;
    }
    // 通路 (2):打开页面时已经有 waiting SW(上次会话装过新版)
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdateToast();
    }
    // 通路 (3):新 SW 在当前会话装完
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateToast();
        }
      });
    });
  });
}

// 用户点 toast 上"刷新"
btnUpdateReload.addEventListener("click", () => {
  hideToast();
  navigator.serviceWorker?.controller?.postMessage({ type: "skip-waiting" });
  if (state.currentTrack) persistPosition();  // reload 前存一下播放位置
  location.reload();
});
```

SW 端配对:

```js
self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
```

`updateDismissed` flag:用户点 ✕ 之后本会话不再骚扰。下次开 app 会重新评估。

## 为什么 3 条通路都要

| 通路 | 触发 | 不可替代之处 |
|---|---|---|
| (1) asset-updated postMessage | SW 后台 revalidate 对比 ETag | **页面已经载入了**,SW 才是发现新版本的人 |
| (2) registration.waiting + controller | register 时已经有 waiting SW | 上次会话浏览器装了新 SW 但没 activate,这次开发现 |
| (3) updatefound → statechange installed | 当前会话新 SW 刚装完 | **改 SW 文件本身**(不改 precache 内容)只走这条 |

只接 (1) 会漏:你改了 service-worker.js 但 precache 列表 / 内容没变 → ETag 没差 → SW 本身有新版但 toast 不弹。所以 (3) 必加。

## 跟普通 cache invalidation 的边界

SW cache 仅限**静态 shell + 你掌控版本的 vendor lib**。所有上游可变数据(Graph metadata、OneDrive listing、用户文件)都 **passthrough**。不要给"加速冷启动"这种理由说服自己 cache 这些 —— 缓存失效永远是坑。

例外要明确写出来。本项目就一条:MSAL CDN(钉 `MSAL_VERSION`,等同 npm tarball 的版本控制)。

## 坑

- **`cache.addAll` 是 all-or-nothing**。一个 URL 失败整批回滚,install 失败,旧 SW 继续工作。这通常**不是你想要的**,把易错的剥成 best-effort。
- **同一个 SW 文件 byte 一字不差时,浏览器认为没变**,不触发 update。CI 上偶尔输出有差异(BOM、换行)能"偶然触发"更新,但靠它不稳。每次有意 release 改一下 `CACHE_VERSION` 字符串,逻辑上没影响,但 byte 变了 → 触发更新。
- **`clients.claim()` 让新 SW 接管已有 page**,但 page 上的 DOM 不会变,只是后续 fetch 会过新 SW。视觉上看不出来,所以新 cached assets 要 page reload 才生效 —— toast + 用户刷新这一套就是为这个。
- **localhost 跳过 SW** 这条很重要。否则 dev 写代码,F5 看到的是 cache 上一次的版本,会怀疑自己改的没保存,排查掉时间。
- **`skipWaiting` 不调,新 SW 一直 waiting**,要等所有用旧 SW 的 page 都关掉它才 activate。开发体验灾难。装上就 skipWaiting + claim 是 SPA / PWA 的默认正确姿势。
- **`navigator.serviceWorker.controller` 为 null 的情况**:页面首次打开还没被任何 SW 控制(第一次访问,SW 还没装)。3 通路里 (2)(3) 都检查 `controller`,因为没 controller 的话"提示更新"是噪音(没旧版本可对比)。
