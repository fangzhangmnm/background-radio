// BR v2 Service Worker：① store SW 网关答 ./stream/<name> 206；② app shell 精简缓存（离线能开壳——
//   spike 六轮战报「离线刷新没了」的修复）。SW 归 app，store 只给薄件。
// shell 策略 = network-first + cache 兜底（dev 期改动即生效；prod cutover 时再换家族 content-hash bundle 模式）。
import { createSwStreamGateway } from "@internal/store/sw";

const sw = self as unknown as ServiceWorkerGlobalScope;
const SHELL_CACHE = "br2-shell-v1";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./icon-192.png", "../vendor/msal/msal-browser.min.js"];
const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg" };

function swLog(msg: string): void {
  void sw.clients.matchAll({ includeUncontrolled: true }).then((cs) => { for (const c of cs) c.postMessage({ br2log: msg }); });
}
const gw = createSwStreamGateway({
  dbName: "br.defaultStore",
  streamPrefix: new URL("./stream/", sw.registration.scope).pathname,
  contentType: (n) => MIME[n.split(".").pop()!.toLowerCase()] ?? "application/octet-stream",   // 内容知识在 app 侧（store 网关内容盲）
  onLog: swLog,
});

sw.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    for (const u of SHELL) { try { await c.add(new Request(u, { cache: "no-cache" })); } catch { /* 单件失败不拦 install（离线装 SW 时全失败也无妨） */ } }
    await sw.skipWaiting();
  })());
});
sw.addEventListener("activate", (e) => { e.waitUntil(sw.clients.claim()); });

async function shellNetworkFirst(req: Request): Promise<Response> {
  const c = await caches.open(SHELL_CACHE);
  try {
    const r = await fetch(req);
    if (r.ok) void c.put(req, r.clone());
    return r;
  } catch {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw new Error("离线且 shell 缓存无此件");
  }
}

sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (gw.matches(url)) { e.respondWith(gw.handle(e.request)); return; }
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // shell（本 scope 页面/资源 + 上级 vendor 的 MSAL）→ network-first + cache 兜底；其余 passthrough
  const inScope = url.pathname.startsWith(new URL("./", sw.registration.scope).pathname);
  const isMsal = url.pathname.includes("/vendor/msal/");
  if (inScope || isMsal) e.respondWith(shellNetworkFirst(e.request));
});
