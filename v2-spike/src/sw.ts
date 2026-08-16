// BR v2 spike 的 Service Worker——只干一件事：把 ./stream/<name> 答成 206（store SW 网关）。
// 不缓存 app shell（spike 无此需求）；其余请求全 passthrough。
import { createSwStreamGateway } from "../../../20260813 internal-store/src/sw/gateway.ts";

const sw = self as unknown as ServiceWorkerGlobalScope;
const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg" };
const gw = createSwStreamGateway({
  dbName: "br-spike.defaultStore",
  streamPrefix: new URL("./stream/", sw.registration.scope).pathname,
  contentType: (n) => MIME[n.split(".").pop()!.toLowerCase()] ?? "application/octet-stream",   // 内容知识在 app 侧（store 网关保持内容盲）
});

sw.addEventListener("install", () => { void sw.skipWaiting(); });
sw.addEventListener("activate", (e) => { e.waitUntil(sw.clients.claim()); });
sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (gw.matches(url)) e.respondWith(gw.handle(e.request));
});
