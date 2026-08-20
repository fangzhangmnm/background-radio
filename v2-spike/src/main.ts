// BR v2 spike（2026-08-15 user 拍板 ad hoc 踩坑）——真机验证包，**不碰旧 app**。
// 验的就是计划 v2 的头号未知：① iOS PWA 里 SW 答 206 给 <audio>；② 后台 ended 同步换曲（活性接力）；
// ③ 降级 audio.loop；④ keepOffline 进度 + 先播后 pin 不重下；⑤ 断网 stall→复网自愈。
// 全部结果落屏上日志区（反煤气灯：真机现象自己会说话）。
// spike-9（2026-08-18 iPad 战报回炉，user 拍板）：① staging 透明护栏——三态徽章 + 离线起播「能播=能播完」
// + 播中撞洞 surface；② 边界备战三级（本地/coverage/预拉，前两级离线可判——「循环乙」谜底=预拉离线必败）；
// ③ 回前台/回线自愈（解除降级循环 + stall/error 重建）；④ 日志毫秒戳 + 边界决策日志。
// spike-10（2026-08-19 iPad 二轮战报）：① 自愈加 8s 看门狗（战例：前台亮屏开回 wifi，online/visibility
// 事件全没来 → 谁都没触发自愈）；② 护栏收窄——「无缓存」不拦直接试（没缓存不存在先响后卡死；
// iOS onLine 有说谎前科，拦了会误伤真在线）；③ 接曲 flag 带全量/仅头语义 + pin/移除后重备战
// （战例：备战后被移除离线 → 陈 flag 盲步进到零字节曲 → 播放挂死）。
// spike-11（2026-08-19 三轮战报）：连 wifi 前台 SW fetch 抛 Load failed（iOS 网络切换后遗症/URL 过期 throw），
// 看门狗无退避刷屏 → 错误恢复改升级链（退避重试 SW → 同源探针分辨真断网 vs SW 僵死 → 页面直下整曲
// 播 blob = 计划内建降级链补全）；SW 网关 fetch throw 也走换 URL 重试（store 侧）。
import { createStore, createOneDriveProvider } from "../../../20260813 internal-store/src/index.ts";
import { startSwAuthBridge } from "../../../20260813 internal-store/src/sw/bridge.ts";
import { CLIENT_ID, AUTHORITY, SCOPES } from "../../config.js";
import { nextOf, resolveAvail, classifyNextReady, decideBoundary, decideStartPlayback, decideHeal, decideRecovery, retryDelayMs, type NextReady } from "./player-logic.ts";

const SPIKE_V = "spike-14 · 2026-08-20";
const APP_ID = "br-spike";
const DB_NAME = `${APP_ID}.defaultStore`;
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac"]);

// ── 屏上日志（真机测量仪表；也镜像 console）──────────────────────────────
const logEl = document.getElementById("log")!;
function log(msg: string): void {
  const t = new Date();
  const line = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}.${String(t.getMilliseconds()).padStart(3, "0")} ${msg}`;
  const div = document.createElement("div");
  div.textContent = line;
  logEl.prepend(div);
  while (logEl.childNodes.length > 200) logEl.lastChild!.remove();
  console.log("[spike]", msg);
}

// ── provider + store ────────────────────────────────────────────────────
const { provider, auth } = createOneDriveProvider({
  clientId: CLIENT_ID, authority: AUTHORITY, scopes: SCOPES,
  msalUrl: "../vendor/msal/msal-browser.min.js",   // 复用旧 BR vendored MSAL（同 origin 同 clientId → 静默复用登录态）
});
const store = createStore({
  appId: APP_ID, provider,
  validateAdopt: (plain: Blob) => sniffAudio(plain),
  signedIn: () => auth.isSignedIn(),
  autoCacheOpenedFile: false,   // 流式消费 app：open 过路不留；留离线只走 keepOffline / openStream.keep
  offlineUploadReplay: "auto",  // 离线/未登录时播的种，登录后 drainOfflineQueue 自动补推上云
  ui: {
    busy: async <T>(label: string, fn: () => Promise<T>): Promise<T> => { log(`⏳ ${label}`); try { return await fn(); } finally { log(`✓ ${label}`); } },
    resolveConflict: async ({ name }: { name: string }) => { log(`⚠ 冲突面被触发（${name}）——spike 不该发生，选 cancel`); return "cancel" as const; },
    reportError: (err: unknown, level?: string) => { if (level !== "log") log(`🛑 ${String((err as Error)?.message ?? err)}`); else console.log("[store]", err); },
    onReplayStatus: (evt: { phase: string; name?: string; done: number; total: number }) => log(`补推 ${evt.phase}${evt.name ? `：${evt.name}` : ""}（${evt.done}/${evt.total}）`),
  },
});
async function sniffAudio(plain: Blob): Promise<boolean> {
  const head = new Uint8Array(await plain.slice(0, 12).arrayBuffer());
  const s = String.fromCharCode(...head.subarray(0, 4));
  if (s.startsWith("ID3") || s === "RIFF" || s === "fLaC" || s === "OggS") return true;
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true;   // 裸 mp3 帧同步
  if (s.startsWith("<") || s.startsWith("<!")) return false;        // captive-portal HTML
  return head.length > 0;                                           // 其余（m4a ftyp 等）放行
}

// ── SW 注册 + 等接管 ─────────────────────────────────────────────────────
const streamPrefix = new URL("./stream/", location.href).pathname;
const streamUrl = (name: string): string => streamPrefix + name.split("/").map(encodeURIComponent).join("/");
async function ensureSw(): Promise<void> {
  const reg = await navigator.serviceWorker.register("./sw.js");
  if (navigator.serviceWorker.controller) { sessionStorage.removeItem("sw-reclaim"); log("SW 已接管"); return; }
  log("SW 已注册，等接管…");
  const claimed = await Promise.race([
    new Promise<boolean>((r) => navigator.serviceWorker.addEventListener("controllerchange", () => r(true), { once: true })),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1200)),
  ]);
  if (claimed) { sessionStorage.removeItem("sw-reclaim"); log("SW 接管完成"); return; }
  // 强刷（Ctrl+Shift+R）后的「SW 活着但不控本页」态：controllerchange 永远不来 → 软刷一次接回（sessionStorage 防循环）
  if ((reg.active || reg.waiting) && !sessionStorage.getItem("sw-reclaim")) {
    sessionStorage.setItem("sw-reclaim", "1");
    log("强刷后 SW 未控本页 → 自动软刷一次接回");
    location.reload();
    await new Promise<never>(() => { /* 等 reload */ });
  }
  log("⚠ SW 未接管（流播不可用）——普通刷新一次试试");
}

// ── 播放器 ──────────────────────────────────────────────────────────────
const audio = document.getElementById("audio") as HTMLAudioElement;
const nowEl = document.getElementById("now")!;
let mode: "single" | "folder" | "stop" = "folder";
let currentFolder = "";
let tracks: string[] = [];            // 当前夹音频文件（列表序）
let current: string | null = null;
let nextReady: NextReady = null;   // 边界备战 flag（ended 里零异步可判；full=离线也可接。语义见 player-logic）

const fileOf = (name: string) => store.file(name, { isZip: false, mode: "existing" });
const HEAD_READY_BYTES = 512 * 1024;   // 头部备到这个量就算「在线可接」（≈几秒声，够页面复活接力）
// 边界备战（决策纯函数在 player-logic，已 mock 测）：本地/coverage 零网络离线可判 → 现拉预取兜底。
// spike-8 战例：预拉只走云端 fetchMeta 离线必败 → 下一曲明明全在机上也降级 loop（「循环乙」谜底）。
async function prefetchNextHead(name: string): Promise<void> {
  const next = nextOf(tracks, name);
  nextReady = null;
  if (!next || mode !== "folder") return;
  try {
    const f = fileOf(next);
    let lvl = classifyNextReady(await resolveAvail(f), HEAD_READY_BYTES);
    if (lvl === "need-fetch") {
      const h = await f.openStream();
      if (!h) { log(`边界备战失败：${next} 拿不到（${navigator.onLine ? "云端解析失败" : "离线且无缓存"}）→ 届时降级 loop`); return; }
      await h.prefetch(0, 768 * 1024);
      h.close();
      lvl = classifyNextReady(await resolveAvail(f), HEAD_READY_BYTES);   // 预拉后重判（小文件可能已全量入缓存）
      if (lvl === "need-fetch") { log(`边界备战：预拉后头部仍不足（${next}）→ 届时降级 loop`); return; }
    }
    nextReady = { name: next, full: lvl === "ready-full" };
    log(`边界备战：${next} ${nextReady.full ? "全量可接（离线也行）" : "头部就绪（在线可接）"}`);
  } catch (e) { log(`边界备战异常：${String((e as Error).message)} → 届时降级 loop`); }
}
// 离线起播护栏（决策在 player-logic.decideStartPlayback，已 mock 测）：只拦「有洞的部分缓存」；
// 无缓存直接试（没缓存不存在先响后卡死；iOS onLine 有说谎前科，拦了会误伤真在线——spike-9 二轮战例）。
async function play(name: string): Promise<void> {
  if (!navigator.onLine) {
    const d = decideStartPlayback({ online: false, avail: await resolveAvail(fileOf(name)) });
    if (!d.allow) {
      log(`⛔ 离线起播拒绝：${name}（${d.why}）`);
      nowEl.textContent = `⛔ 离线不可播：${name.split("/").pop()}（${d.why}）`;
      return;
    }
    if (d.note) log(`离线起播放行：${name}（${d.note}）`);
  }
  startPlayback(name);
}
function startPlayback(name: string): void {
  current = name;
  audio.loop = mode === "single";
  audio.src = streamUrl(name);
  void audio.play().then(() => log(`▶ 播放：${name}`)).catch((e) => log(`play() 拒绝：${e.message}`));
  nowEl.textContent = `▶ ${name}`;
  setMediaSession(name);
  void prefetchNextHead(name);
  renderList();
}
audio.addEventListener("ended", () => {                       // ★被测主角：后台边界。此处**零异步**（决策纯函数已 mock 测）。
  const d = decideBoundary({ mode, current, tracks, nextReady, online: navigator.onLine });
  log(`★边界决策：${d.action}${d.action === "advance" ? `→${d.to}` : d.action === "loop" ? `（${d.reason}）` : ""}` +
      `（备战=${nextReady ? `${nextReady.name}·${nextReady.full ? "全量" : "仅头"}` : "无"}，online=${navigator.onLine}）`);
  if (d.action === "advance") {
    current = d.to; nextReady = null;
    audio.src = streamUrl(d.to);                              // 同步换 src + play：SW 从 staging/本地答头部 → 声音先响 → 页面复活
    void audio.play().then(() => log(`▶ 自动步进成功：${d.to}`)).catch((e) => log(`步进 play() 拒绝：${e.message}`));
    nowEl.textContent = `▶ ${d.to}`;
    setMediaSession(d.to);
    void prefetchNextHead(d.to);
    renderList();
  } else if (d.action === "loop") {
    audio.loop = true;                                        // 降级：单曲循环（loop=true 后 ended 不再触发 → 只能靠自愈解除）
    void audio.play().catch(() => {});
    log("★降级 audio.loop 单曲循环——自愈解除");
  }
});
for (const ev of ["error", "stalled", "waiting", "playing", "pause"] as const) {
  audio.addEventListener(ev, () => log(`audio 事件：${ev}${ev === "error" ? ` code=${audio.error?.code}` : ""}`));
}
// 播放失败 surface（护栏漏网的最后一道）：说人话，绝不静默停。回线后 watchdog/事件自愈会重建。
audio.addEventListener("error", () => {
  if (current) nowEl.textContent = `⚠ 播放失败：${current.split("/").pop()}（${navigator.onLine ? "拿不到字节，云端不可达？" : "离线且机上无此曲字节"}）——回线自动重试`;
});

// ── 自愈（spike-9）：回前台 / 回线统一检查 ─────────────────────────────────
//   spike-8 战例「回 wifi 前台不自愈」的根：① 降级 audio.loop=true 后 ended 永不再触发，降级循环
//   一进就出不来；② 离线期间 stall/error 的 <audio> 回线不会自己重建。都得靠事件驱动的检查拉回来。
let lastMediaWall = 0;
audio.addEventListener("timeupdate", () => { lastMediaWall = Date.now(); });
// 复播规则（2026-08-20 user 拍板）：点曲/接曲/循环/自愈重建一律**从 0 开始**；唯一的「中间复播」
// = 新开 app 恢复上次位置（BR 正式版做，spike 不做）。中途保位置复播已判定是坏 feature，删。
function recoverPlayback(reason: string): void {
  if (!current) return;
  log(`自愈：重建播放（${reason}，从头播）：${current}`);
  audio.src = streamUrl(current);
  void audio.play().then(() => { log("自愈：播放已续上"); nowEl.textContent = `▶ ${current}`; }).catch((e) => log(`自愈 play() 拒绝：${e.message}`));
}
// ── 错误恢复升级链（spike-11；决策 player-logic.decideRecovery，已 mock 测）────────────────
//   战例：连 wifi 前台 SW fetch 抛 Load failed，看门狗无退避每 8s 重试同一条死路刷屏。
//   链：退避重试 SW 路 → 同源探针（分辨真断网 vs SW fetch 僵死）→ 页面直下整曲播 blob（计划内建
//   降级链「SW 媒体失败→等整下再播 blob」的补全；页面 fetch 走 MSAL 不经 SW，恰好绕开僵死面）。
const MIME_BLOB: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg" };
let recFailures = 0, recProbeOk: boolean | null = null, recBlobTried = false, recNextAt = 0, blobUrl: string | null = null;
audio.addEventListener("playing", () => {
  if (recFailures || recBlobTried) log("播放已续上——恢复链计数归零");
  recFailures = 0; recProbeOk = null; recBlobTried = false; recNextAt = 0;
});
async function escalateRecovery(trigger: string): Promise<void> {
  if (Date.now() < recNextAt) return;                         // 退避窗内不动（防刷屏）
  const plan = decideRecovery({ online: navigator.onLine, failures: recFailures, probeOk: recProbeOk, blobTried: recBlobTried });
  if (plan.action === "retry-sw") {
    recFailures++;
    recNextAt = Date.now() + retryDelayMs(recFailures);
    recoverPlayback(`${trigger}：重试 SW 路（第 ${recFailures} 次，退避 ${retryDelayMs(recFailures) / 1000}s）`);
  } else if (plan.action === "probe") {
    recNextAt = Date.now() + 8000;
    try { recProbeOk = (await fetch(`./manifest.webmanifest?heal-probe=${Date.now()}`, { cache: "no-store" })).ok; }
    catch { recProbeOk = false; }
    log(`探针：同源拉取${recProbeOk ? "通——页面网络活着，SW fetch 僵死（iOS 网络切换后遗症）→ 走 blob 降级" : "不通——真断网（onLine 在说谎），等网络"}`);
  } else if (plan.action === "blob-fallback") {
    recBlobTried = true;
    recNextAt = Date.now() + 8000;
    await blobFallbackPlay();
  } else {
    recNextAt = Date.now() + 60_000;
    log(`恢复暂缓：${plan.reason}（60s 后重启恢复链）`);
    recProbeOk = null;                                        // 下一轮重探（网络可能已变）
    if (recBlobTried) { recFailures = 0; recBlobTried = false; }
  }
}
async function blobFallbackPlay(): Promise<void> {
  if (!current) return;
  log(`降级：页面直下整曲播 blob：${current}`);
  try {
    const h = await fileOf(current).openStream();
    if (!h) { log("降级失败：openStream 拿不到（页面侧也解析不到）"); return; }
    if (h.totalSize > 64 * 1024 * 1024) { h.close(); log(`降级放弃：${Math.round(h.totalSize / 1048576)}MB 太大不整下（继续等 SW 活）`); return; }
    const bytes = await h.read(0, h.totalSize);               // 页面拉字节（顺手 tee 回 staging，SW 复活后受益）
    h.close();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: MIME_BLOB[current.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" }));
    audio.src = blobUrl;
    void audio.play().then(() => log("降级成功：blob 播放（从头播——2026-08-20 复播规则）")).catch((e) => log(`降级 play() 拒绝：${e.message}`));
  } catch (e) { log(`降级异常：${(e as Error).message}`); }
}

// 自愈动作执行器（决策在 player-logic.decideHeal，已 mock 测；此处只翻译成副作用，幂等）。
function applyHeal(trigger: string): void {
  const acts = decideHeal({ online: navigator.onLine, current, mode, hasError: !!audio.error, loopEngaged: audio.loop, nextReady });
  if (!acts.length) return;
  if (acts.length === 1 && acts[0] === "rebuild" && Date.now() < recNextAt) return;   // 退避窗内静默（防日志刷屏）
  log(`自愈（${trigger}）：${acts.join("+")}`);
  if (acts.includes("rebuild")) void escalateRecovery(trigger);   // 错误态恢复走升级链（退避/探针/blob），不再裸重试
  if (acts.includes("unloop")) { audio.loop = false; log("自愈：解除降级单曲循环 → 恢复顺序接曲"); }
  if (acts.includes("re-arm") && current) {
    void prefetchNextHead(current).then(() => {
      const again = decideHeal({ online: navigator.onLine, current, mode, hasError: !!audio.error, loopEngaged: audio.loop, nextReady });
      if (again.includes("unloop")) { audio.loop = false; log("自愈：备战完成 → 解除降级单曲循环"); }
    });
  }
}
function healCheck(trigger: string): void {
  log(`自愈检查（${trigger}，online=${navigator.onLine}）`);
  if (navigator.onLine && lastSnap) watch(currentFolder);     // 重订阅拿新云帧（列表/徽章归真）
  if (!current || mode === "stop") return;
  if (navigator.onLine && !audio.error && !audio.paused) {
    const wall0 = lastMediaWall;                              // 观察窗：回线 2.5s 仍无播放进度 = stall 死了 → 重建
    setTimeout(() => {
      if (!navigator.onLine || !current || audio.paused) return;
      if (lastMediaWall === wall0) recoverPlayback("回线 2.5s 无播放进度（stall）");
      else log("自愈检查：播放在走，无需重建");
    }, 2500);
  }
  applyHeal(trigger);
}
addEventListener("online", () => healCheck("online 事件"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) healCheck("回前台"); });
// 8s 看门狗（spike-9 二轮战例：前台亮屏开回 wifi，online/visibility 事件全没来 → 谁都没触发自愈）。
// 决策幂等：稳态空转零动作；另带播放无进度监工（在线、非暂停、连续两拍无 timeupdate → 重建）。
let stallStrikes = 0, lastWallSeen = -1;
setInterval(() => {
  if (!current || mode === "stop") return;
  applyHeal("watchdog");
  if (navigator.onLine && !audio.paused && !audio.error) {
    if (lastMediaWall === lastWallSeen) { if (++stallStrikes >= 2) { stallStrikes = 0; recoverPlayback("watchdog：≥16s 无播放进度"); } }
    else stallStrikes = 0;
    lastWallSeen = lastMediaWall;
  } else stallStrikes = 0;
}, 8000);
function setMediaSession(name: string): void {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: name.split("/").pop(), artist: "BR spike" });
    navigator.mediaSession.setActionHandler("play", () => void audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => { const n = current && nextOf(tracks, current); if (n) void play(n); });
  } catch { /* 部分 handler 不支持无妨 */ }
}

// ── 列表 UI ─────────────────────────────────────────────────────────────
const listEl = document.getElementById("list")!;
let unwatch: (() => void) | null = null;
let lastSnap: { items: { path: string; syncState: string }[]; folders: string[]; stale?: true; complete: boolean } | null = null;
function watch(folder: string): void {
  unwatch?.();
  currentFolder = folder;
  unwatch = store.files.watchFolder(folder, (snap) => {
    lastSnap = snap;
    tracks = snap.items.map((i) => i.path).filter((p) => AUDIO_EXT.has(p.split(".").pop()!.toLowerCase()));
    log(`列举帧：${snap.items.length} 项 ${snap.folders.length} 夹${snap.stale ? "（stale 首帧）" : ""}${snap.complete ? "（云端权威）" : ""}`);
    renderList();
  });
}
const pinProgress = new Map<string, string>();
// 三态徽章（spike-9 透明护栏①）：已钉（syncState 非 cloud-only）/ 已缓存·缓存n%（staging 账本）/ 无。
const covBadge = new Map<string, string>();
let covRefreshing = false;
async function refreshCovBadges(): Promise<void> {
  if (!lastSnap || covRefreshing) return;
  covRefreshing = true;
  try {
    let changed = false;
    for (const it of lastSnap.items) {
      let txt = "";
      if (it.syncState === "cloud-only") {
        const cov = await fileOf(it.path).stagingCoverage();
        txt = !cov ? "" : cov.complete ? "已缓存可离线" : `缓存${Math.round((cov.bytes / cov.totalBytes) * 100)}%有洞`;
      }
      if ((covBadge.get(it.path) ?? "") !== txt) { txt ? covBadge.set(it.path, txt) : covBadge.delete(it.path); changed = true; }
    }
    if (changed) renderList();
  } finally { covRefreshing = false; }
}
function renderList(): void {
  if (!lastSnap) return;
  listEl.innerHTML = "";
  if (currentFolder) addRow("⬆ 返回上级", () => watch(currentFolder.includes("/") ? currentFolder.slice(0, currentFolder.lastIndexOf("/")) : ""));
  for (const f of lastSnap.folders) addRow(`📁 ${f.split("/").pop()}`, () => watch(f));
  for (const it of lastSnap.items) {
    const name = it.path;
    const isAudio = AUDIO_EXT.has(name.split(".").pop()!.toLowerCase());
    const row = document.createElement("div");
    row.className = "row" + (name === current ? " playing" : "");
    const label = document.createElement("span");
    const extra = pinProgress.get(name) ?? covBadge.get(name);
    label.textContent = `${isAudio ? "🎵" : "📄"} ${name.split("/").pop()}（${it.syncState}${extra ? "·" + extra : ""}）`;
    label.onclick = () => { if (isAudio) void play(name); };
    row.append(label);
    const pin = document.createElement("button");
    const kept = it.syncState !== "cloud-only";
    pin.textContent = kept ? "✕离线" : "留离线";
    pin.onclick = async () => {
      const f = store.file(name, { isZip: false, mode: "existing" });
      try {
        if (kept) { try { await f.offload(); log(`已移除离线：${name}`); } catch (e) { log(`offload 拒绝：${(e as Error).message}`); } }
        else {
          log(`留离线开始：${name}`);   // spike-12 埋点（四轮战报「已缓存点留离线没反应」——下次日志说话）
          const t0 = Date.now();
          await f.keepOffline({ onProgress: (d, t) => { pinProgress.set(name, `${Math.round((d / t) * 100)}%`); renderList(); } });
          pinProgress.delete(name);
          // keepOffline 失败走 reportError 吞掉后照常 resolve → 必须复核事实再报，别谎报完成（五轮战报打回）
          if (await f.isKeptOffline()) log(`留离线完成：${name}（${((Date.now() - t0) / 1000).toFixed(1)}s）★若先播过/已缓存应快（只补缺口）`);
          else log(`⚠ 留离线未完成：${name}（原因见上方 🛑 行）`);
        }
      } catch (e) { log(`🛑 留离线/移除异常：${name}：${(e as Error).message}`); pinProgress.delete(name); }
      renderList();
      // 可用性变了 → 重新边界备战（spike-9 二轮战例：备战后被移除离线 → 陈 flag 盲步进到零字节曲挂死）
      if (current && mode === "folder") void prefetchNextHead(current);
    };
    row.append(pin);
    listEl.append(row);
  }
  void refreshCovBadges();   // 异步补徽章（有变化才重画一轮；covRefreshing 防递归风暴）
}
function addRow(text: string, onclick: () => void): void {
  const row = document.createElement("div");
  row.className = "row folder";
  row.textContent = text;
  row.onclick = onclick;
  listEl.append(row);
}

// ── 模式切换 ────────────────────────────────────────────────────────────
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  r.addEventListener("change", () => {
    mode = r.value as typeof mode;
    audio.loop = mode === "single";
    log(`模式 → ${mode}`);
    if (mode === "folder" && current) void prefetchNextHead(current);
  });
}

// ── 播种测试音频（桌面按一次；不同频率正弦波 → 换曲耳朵能听出来）────────────
document.getElementById("seed")!.addEventListener("click", async () => {
  const specs: [string, number, number][] = [["甲-10秒-440Hz", 10, 440], ["乙-12秒-660Hz", 12, 660], ["丙-90秒-330Hz", 90, 330]];
  // 批次后缀（spike-12）：每次点播种得到全新一组名字 → 天然的「无缓存」测试材料（配方：播种→✕离线→cloud-only 零缓存）
  const t = new Date();
  const batch = `${String(t.getHours()).padStart(2, "0")}${String(t.getMinutes()).padStart(2, "0")}`;
  for (const [label, secs, freq] of specs) {
    const name = `spike-test/${label}-${batch}.wav`;
    try {
      const r = await store.file(name, { isZip: false, mode: "new" }).save(makeWav(secs, freq));
      log(`播种 ${name}：${r.pushed ? "已上云" : `只落本地（${r.reason}）`}`);
    } catch {
      // 撞名（比如上次未登录只落了本地）→ existing 覆盖保存再推（字节 idempotent；登录后重按播种即可补上云）
      try {
        const r = await store.file(name, { isZip: false, mode: "existing" }).save(makeWav(secs, freq));
        log(`播种 ${name}（已有→补推）：${r.pushed ? "已上云" : `仍只在本地（${r.reason}）`}`);
      } catch (e2) { log(`播种 ${name} 失败：${(e2 as Error).message}`); }
    }
  }
  watch("spike-test");
});
function makeWav(secs: number, freq: number): Uint8Array {
  const rate = 44100, n = rate * secs;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 2000, (n - i) / 2000);                       // 去爆音
    const beep = Math.sin((2 * Math.PI * freq * i) / rate) * (Math.floor(i / rate) % 2 ? 1 : 0.4);   // 每秒强弱交替（听得出进度）
    v.setInt16(44 + i * 2, Math.round(beep * env * 12000), true);
  }
  return new Uint8Array(buf);
}

// ── boot ────────────────────────────────────────────────────────────────
document.getElementById("ver")!.textContent = SPIKE_V;
navigator.serviceWorker.addEventListener("message", (e) => { const m = (e.data as { br2log?: string })?.br2log; if (m) log(`[SW] ${m}`); });
let booted = false;
function proceedSignedIn(): void {
  if (booted) return;
  booted = true;
  log(`已登录：${String((auth.getActiveAccount() as { username?: string })?.username ?? "")}`);
  document.getElementById("login")!.hidden = true;
  const bridge = startSwAuthBridge({ dbName: DB_NAME, getToken: () => auth.getToken() });   // 三层堵洞①：页面活着就续凭据给 SW
  void bridge.ready.then(() => log("凭据桥就绪（SW 可取 token）"));
  void store.files.drainOfflineQueue().then(() => log("离线补推队列已排空")).catch((e) => log(`补推异常：${(e as Error).message}`));
  watch("");
}
(async () => {
  log(`BR v2 ${SPIKE_V} 启动`);
  await ensureSw();
  const st = await auth.initAuth();
  if (st.signedIn || await auth.retrySilentSignIn()) { proceedSignedIn(); return; }
  // 未登录。spike 页交互登录必死（本页 URL 没在 Azure 注册 redirectUri）→ 唯一正路 = 旧 BR 页登录 + 本页静默复用。
  log("未登录：点下面按钮开旧 BR 页登录一次，回本页后会自动接上（同 clientId 静默复用）");
  const btn = document.getElementById("login")!;
  btn.textContent = "去旧 BR 登录（登录完回本页）";
  btn.hidden = false;
  btn.addEventListener("click", () => { window.open("../", "_blank"); });
  const retry = async (): Promise<void> => {
    if (booted) return;
    if (await auth.retrySilentSignIn()) { log("检测到登录态，接上了"); proceedSignedIn(); }
  };
  addEventListener("focus", () => void retry());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void retry(); });
  watch("");   // 未登录也先给本地帧（播种过的本地文件能看、能播——SW 本地面已修）
})();
