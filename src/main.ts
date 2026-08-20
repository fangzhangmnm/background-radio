// BR v2 —— 全量重写（2026-08-20 开工；plan=vast-frolicking-shamir v2，spike-1..14 真机战例全部内化）。
// 旧 app（仓根 raw JS）= 现役 prod，cutover 前不碰；本 app 构建进 dev/（/background-radio/dev/）。
//
// 骨架：@internal/store v0.2.0 正式收货（tgz file: 依赖，不再 spike 特权 src 打包）。
//   字节路径 = SW range 代理（store ./sw 网关）；边界/护栏/自愈决策 = player-logic 纯函数（48 断言 mock 测）。
// 复播规则（2026-08-20 user 拍板）：点曲/接曲/循环/自愈一律从 0；唯一中间复播 = 新开 app 恢复上次。
// UI（2026-08-20 user）：v1 排版整套回归（shell/顶栏/滚动列表/seek 行/Win8 tile 控制格/右滑抽屉菜单，
//   iPhone SE2 基准）；命名对齐旧版（Background Radio / Radio），版本号不上脸；图标走家族共享库；纯中文。
import { createStore, createOneDriveProvider, type FolderSnapshot } from "@internal/store";
import { startSwAuthBridge } from "@internal/store/sw";
import { CLIENT_ID, AUTHORITY, SCOPES, APP_VERSION } from "./config.ts";
import { nextOf, resolveAvail, classifyNextReady, decideBoundary, decideStartPlayback, decideHeal, decideRecovery, retryDelayMs, type NextReady } from "./player-logic.ts";

const APP_ID = "br";
const DB_NAME = `${APP_ID}.defaultStore`;
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac"]);
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── 调试日志（真机排障命脉，折叠在页脚 details 里）──────────────────────────
const logEl = $("log");
function log(msg: string): void {
  const t = new Date();
  const line = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}.${String(t.getMilliseconds()).padStart(3, "0")} ${msg}`;
  const div = document.createElement("div");
  div.textContent = line;
  logEl.prepend(div);
  while (logEl.childNodes.length > 300) logEl.lastChild!.remove();
  console.log("[br]", msg);
}
const statusEl = $("status");
const setStatus = (msg: string): void => { statusEl.textContent = msg; };

// ── provider + store ────────────────────────────────────────────────────
const { provider, auth } = createOneDriveProvider({
  clientId: CLIENT_ID, authority: AUTHORITY, scopes: SCOPES,
  msalUrl: "../vendor/msal/msal-browser.min.js",
});
const store = createStore({
  appId: APP_ID, provider,
  validateAdopt: (plain: Blob) => sniffAudio(plain),
  signedIn: () => auth.isSignedIn(),
  autoCacheOpenedFile: false,   // 流式消费 app：open 过路不留；留离线只走 keepOffline
  readOnlyFiles: true,          // BR = 只读 mp3 镜像（ADR-0022 G2 变体）：files 只读，collections 照常可写
  ui: {
    busy: async <T>(label: string, fn: () => Promise<T>): Promise<T> => { log(`⏳ ${label}`); try { return await fn(); } finally { log(`✓ ${label}`); } },
    resolveConflict: async ({ name }: { name: string }) => { log(`⚠ 冲突面被触发（${name}）——只读镜像不该发生`); return "cancel" as const; },
    reportError: (err: unknown, level?: string) => { if (level !== "log") log(`🛑 ${String((err as Error)?.message ?? err)}`); else console.log("[store]", err); },
    onReplayStatus: () => {},
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
// 设备态（per-device，local-only collection：永不上云）：上次播放 = 唯一的「中间复播」来源。
const deviceState = store.collection("device-state", { local: true });
interface PlaybackState { folder: string; current: string | null; position: number; duration?: number; mode: "folder" | "single" }

// ── SW 注册 + 等接管（spike-3 战例：强刷后 SW 不控页 → 软刷接回）───────────────
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
  if ((reg.active || reg.waiting) && !sessionStorage.getItem("sw-reclaim")) {
    sessionStorage.setItem("sw-reclaim", "1");
    log("强刷后 SW 未控本页 → 自动软刷一次接回");
    location.reload();
    await new Promise<never>(() => { /* 等 reload */ });
  }
  log("⚠ SW 未接管（流播不可用）——普通刷新一次试试");
}

// ── 播放器状态 ───────────────────────────────────────────────────────────
const audio = $("audio") as unknown as HTMLAudioElement;
const nowTitle = $("nowTitle");
const statusScope = $("statusScope");
function renderScope(): void {
  statusScope.textContent = (auth.isSignedIn() ? "" : "未登录 · ") + "/" + currentFolder;
}
let mode: "folder" | "single" = "folder";
let currentFolder = "";
let tracks: string[] = [];            // 当前夹音频文件（列表序）
let current: string | null = null;
let nextReady: NextReady = null;      // 边界备战 flag（ended 零异步可判；full=离线也可接）

const fileOf = (name: string) => store.file(name, { isZip: false, mode: "existing" });
const HEAD_READY_BYTES = 512 * 1024;
const shortName = (name: string): string => name.split("/").pop()!.replace(/\.[^.]+$/, "");

// 边界备战三级（本地/coverage 零网络离线可判 → 现拉预取兜底；spike-8「循环乙」谜底的修复）。
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
      lvl = classifyNextReady(await resolveAvail(f), HEAD_READY_BYTES);
      if (lvl === "need-fetch") { log(`边界备战：预拉后头部仍不足（${next}）→ 届时降级 loop`); return; }
    }
    nextReady = { name: next, full: lvl === "ready-full" };
    log(`边界备战：${next} ${nextReady.full ? "全量可接（离线也行）" : "头部就绪（在线可接）"}`);
  } catch (e) { log(`边界备战异常：${String((e as Error).message)} → 届时降级 loop`); }
}

// 起播护栏（只拦「有洞的部分缓存」；无缓存直接试——iOS onLine 有说谎前科，spike 二轮战例）。
async function play(name: string, opts?: { resumeAt?: number }): Promise<void> {
  if (!navigator.onLine) {
    const d = decideStartPlayback({ online: false, avail: await resolveAvail(fileOf(name)) });
    if (!d.allow) {
      log(`⛔ 离线起播拒绝：${name}（${d.why}）`);
      setStatus(`⛔ 离线不可播：${shortName(name)}（${d.why}）`);
      return;
    }
    if (d.note) log(`离线起播放行：${name}（${d.note}）`);
  }
  startPlayback(name, opts);
}
function startPlayback(name: string, opts?: { resumeAt?: number }): void {
  current = name;
  audio.loop = mode === "single";
  audio.src = streamUrl(name);
  if (opts?.resumeAt && opts.resumeAt > 3) {   // 唯一中间复播点：新开 app 恢复上次（2026-08-20 拍板）
    const at = opts.resumeAt;
    audio.addEventListener("loadedmetadata", () => { try { audio.currentTime = at; } catch { /* 设不上就从头 */ } }, { once: true });
  }
  void audio.play().then(() => log(`▶ 播放：${name}`)).catch((e) => log(`play() 拒绝：${e.message}`));
  nowTitle.textContent = `▶ ${shortName(name)}`;
  setStatus("");
  $("resumeBtn").hidden = true;   // 开机继续键：一旦播了任何东西就退场
  setMediaSession(name);
  void prefetchNextHead(name);
  savePlayback();
  renderList();
  renderControls();
}

// ── 边界（★后台主角：ended 零异步，决策纯函数已 mock 测）────────────────────
audio.addEventListener("ended", () => {
  const d = decideBoundary({ mode, current, tracks, nextReady, online: navigator.onLine });
  log(`★边界决策：${d.action}${d.action === "advance" ? `→${d.to}` : d.action === "loop" ? `（${d.reason}）` : ""}` +
      `（备战=${nextReady ? `${nextReady.name}·${nextReady.full ? "全量" : "仅头"}` : "无"}，online=${navigator.onLine}）`);
  if (d.action === "advance") {
    current = d.to; nextReady = null;
    audio.src = streamUrl(d.to);                              // 同步换 src + play：SW 答头部 → 声音先响 → 页面复活
    void audio.play().then(() => log(`▶ 自动步进成功：${d.to}`)).catch((e) => log(`步进 play() 拒绝：${e.message}`));
    nowTitle.textContent = `▶ ${shortName(d.to)}`;
    setMediaSession(d.to);
    void prefetchNextHead(d.to);
    savePlayback();
    renderList();
  } else if (d.action === "loop") {
    audio.loop = true;                                        // 降级单曲循环（loop=true 后 ended 不再触发 → 靠自愈解除）
    void audio.play().catch(() => {});
    log("★降级 audio.loop 单曲循环——自愈解除");
  }
});
for (const ev of ["error", "stalled", "waiting", "playing", "pause"] as const) {
  audio.addEventListener(ev, () => log(`audio 事件：${ev}${ev === "error" ? ` code=${audio.error?.code}` : ""}`));
}
audio.addEventListener("error", () => {
  if (current) setStatus(`⚠ 播放失败：${shortName(current)}（${navigator.onLine ? "拿不到字节，云端不可达？" : "离线且机上无此曲字节"}）——回线自动重试`);
});
audio.addEventListener("playing", () => { renderControls(); });
audio.addEventListener("pause", () => { renderControls(); savePlayback(); });

// ── 错误恢复升级链（spike-11：退避重试 SW → 同源探针 → 页面直下 blob 降级）────────
const MIME_BLOB: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg" };
let recFailures = 0, recProbeOk: boolean | null = null, recBlobTried = false, recNextAt = 0, blobUrl: string | null = null;
audio.addEventListener("playing", () => {
  if (recFailures || recBlobTried) log("播放已续上——恢复链计数归零");
  recFailures = 0; recProbeOk = null; recBlobTried = false; recNextAt = 0;
});
function recoverPlayback(reason: string): void {
  if (!current) return;
  log(`自愈：重建播放（${reason}，从头播）：${current}`);
  audio.src = streamUrl(current);
  void audio.play().then(() => { log("自愈：播放已续上"); nowTitle.textContent = `▶ ${shortName(current!)}`; setStatus(""); }).catch((e) => log(`自愈 play() 拒绝：${e.message}`));
}
async function escalateRecovery(trigger: string): Promise<void> {
  if (Date.now() < recNextAt) return;
  const plan = decideRecovery({ online: navigator.onLine, failures: recFailures, probeOk: recProbeOk, blobTried: recBlobTried });
  if (plan.action === "retry-sw") {
    recFailures++;
    recNextAt = Date.now() + retryDelayMs(recFailures);
    recoverPlayback(`${trigger}：重试 SW 路（第 ${recFailures} 次，退避 ${retryDelayMs(recFailures) / 1000}s）`);
  } else if (plan.action === "probe") {
    recNextAt = Date.now() + 8000;
    try { recProbeOk = (await fetch(`./manifest.webmanifest?heal-probe=${Date.now()}`, { cache: "no-store" })).ok; }
    catch { recProbeOk = false; }
    log(`探针：同源拉取${recProbeOk ? "通——页面网络活着，SW fetch 僵死 → 走 blob 降级" : "不通——真断网（onLine 在说谎），等网络"}`);
  } else if (plan.action === "blob-fallback") {
    recBlobTried = true;
    recNextAt = Date.now() + 8000;
    await blobFallbackPlay();
  } else {
    recNextAt = Date.now() + 60_000;
    log(`恢复暂缓：${plan.reason}（60s 后重启恢复链）`);
    recProbeOk = null;
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
    const bytes = await h.read(0, h.totalSize);               // 页面拉字节（tee 回 staging，SW 复活后受益）
    h.close();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: MIME_BLOB[current.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" }));
    audio.src = blobUrl;
    void audio.play().then(() => log("降级成功：blob 播放（从头播）")).catch((e) => log(`降级 play() 拒绝：${e.message}`));
  } catch (e) { log(`降级异常：${(e as Error).message}`); }
}

// ── 自愈（回前台/回线事件 + 8s 看门狗；决策纯函数已 mock 测）────────────────────
let lastMediaWall = 0;
audio.addEventListener("timeupdate", () => { lastMediaWall = Date.now(); throttledSavePlayback(); });
function applyHeal(trigger: string): void {
  const acts = decideHeal({ online: navigator.onLine, current, mode, hasError: !!audio.error, loopEngaged: audio.loop, nextReady });
  if (!acts.length) return;
  if (acts.length === 1 && acts[0] === "rebuild" && Date.now() < recNextAt) return;   // 退避窗内静默
  log(`自愈（${trigger}）：${acts.join("+")}`);
  if (acts.includes("rebuild")) void escalateRecovery(trigger);
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
  if (!current) return;
  if (navigator.onLine && !audio.error && !audio.paused) {
    const wall0 = lastMediaWall;
    setTimeout(() => {
      if (!navigator.onLine || !current || audio.paused) return;
      if (lastMediaWall === wall0) recoverPlayback("回线 2.5s 无播放进度（stall）");
      else log("自愈检查：播放在走，无需重建");
    }, 2500);
  }
  applyHeal(trigger);
}
addEventListener("online", () => healCheck("online 事件"));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) healCheck("回前台");
  else savePlayback();   // 退后台立存进度（iOS 随时可能杀 app——「继续上次」的数据源）
});
let stallStrikes = 0, lastWallSeen = -1;
setInterval(() => {   // 看门狗（spike 二轮战例：亮屏回 wifi 时 online/visibility 事件全没来）
  if (!current) return;
  applyHeal("watchdog");
  if (navigator.onLine && !audio.paused && !audio.error) {
    if (lastMediaWall === lastWallSeen) { if (++stallStrikes >= 2) { stallStrikes = 0; recoverPlayback("watchdog：≥16s 无播放进度"); } }
    else stallStrikes = 0;
    lastWallSeen = lastMediaWall;
  } else stallStrikes = 0;
}, 8000);

// ── seek 行：时间 + 点条 seek（SW range 代理天然支持跳播）────────────────────
const progressWrap = $("progressWrap");
const progressBar = $("progressBar");
const posCur = $("posCur");
const posDur = $("posDur");
const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function renderProgress(): void {
  const dur = audio.duration;
  if (!current || !Number.isFinite(dur) || dur <= 0) { progressBar.style.width = "0"; posCur.textContent = "0:00"; posDur.textContent = "0:00"; return; }
  progressBar.style.width = `${(audio.currentTime / dur) * 100}%`;
  posCur.textContent = fmtTime(audio.currentTime);
  posDur.textContent = fmtTime(dur);
  if ("mediaSession" in navigator) {   // 锁屏进度条（best-effort，老 Safari 没有 setPositionState）
    try { navigator.mediaSession.setPositionState?.({ duration: dur, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, dur) }); } catch { /* 无妨 */ }
  }
}
audio.addEventListener("timeupdate", renderProgress);
audio.addEventListener("durationchange", renderProgress);
progressWrap.onclick = (e) => {
  const dur = audio.duration;
  if (!current || !Number.isFinite(dur) || dur <= 0) return;
  const r = progressWrap.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  audio.currentTime = frac * dur;
  log(`seek → ${fmtTime(frac * dur)}`);
};

// ── Media Session（锁屏/蓝牙键）────────────────────────────────────────────
function setMediaSession(name: string): void {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: shortName(name), artist: "Background Radio" });
    navigator.mediaSession.setActionHandler("play", () => void audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => { const n = current && nextOf(tracks, current); if (n) void play(n); });
    navigator.mediaSession.setActionHandler("previoustrack", () => { const p = prevOf(tracks, current); if (p) void play(p); });
    navigator.mediaSession.setActionHandler("seekbackward", (e) => { audio.currentTime = Math.max(0, audio.currentTime - (e.seekOffset || REWIND_SECS)); });
    navigator.mediaSession.setActionHandler("seekforward", (e) => {
      const t = audio.currentTime + (e.seekOffset || FORWARD_SECS);
      audio.currentTime = Number.isFinite(audio.duration) ? Math.min(audio.duration, t) : t;
    });
  } catch { /* 部分 handler 不支持无妨 */ }
}

// ── 设备态持久化（local-only；节流 5s）──────────────────────────────────────
let lastSaveAt = 0;
function savePlayback(): void {
  try {
    deviceState.setItem("playback", {
      folder: currentFolder, current, position: Math.floor(audio.currentTime || 0),
      duration: Number.isFinite(audio.duration) ? Math.floor(audio.duration) : 0, mode,
    } satisfies PlaybackState);
    lastSaveAt = Date.now();
  } catch { /* init 前的调用忽略 */ }
}
function throttledSavePlayback(): void { if (Date.now() - lastSaveAt > 5000) savePlayback(); }

// ── 列表 + 徽章 ─────────────────────────────────────────────────────────
const listEl = $("list");
let unwatch: (() => void) | null = null;
let lastSnap: FolderSnapshot | null = null;
function watch(folder: string): void {
  unwatch?.();
  currentFolder = folder;
  renderScope();
  unwatch = store.files.watchFolder(folder, (snap) => {
    lastSnap = snap;
    tracks = snap.items.map((i) => i.path).filter((p) => AUDIO_EXT.has(p.split(".").pop()!.toLowerCase()));
    log(`列举帧：${snap.items.length} 项 ${snap.folders.length} 夹${snap.stale ? "（stale 首帧）" : ""}${snap.complete ? "（云端权威）" : ""}`);
    renderList();
    if (current && mode === "folder") void prefetchNextHead(current);   // 列表变了 → 重备战（防陈 flag）
  });
}
const pinProgress = new Map<string, string>();
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
        txt = !cov ? "" : cov.complete ? "已缓存" : `缓存${Math.round((cov.bytes / cov.totalBytes) * 100)}%`;
      }
      if ((covBadge.get(it.path) ?? "") !== txt) { txt ? covBadge.set(it.path, txt) : covBadge.delete(it.path); changed = true; }
    }
    if (changed) renderList();
  } finally { covRefreshing = false; }
}
function renderList(): void {
  if (!lastSnap) return;
  listEl.innerHTML = "";
  if (currentFolder) addNavRow("back", "返回上级", () => watch(currentFolder.includes("/") ? currentFolder.slice(0, currentFolder.lastIndexOf("/")) : ""));
  for (const f of lastSnap.folders) addNavRow("folder", f.split("/").pop()!, () => watch(f));
  for (const it of lastSnap.items) {
    const name = it.path;
    if (!AUDIO_EXT.has(name.split(".").pop()!.toLowerCase())) continue;   // 只读 mp3 镜像：非音频不上列表
    const row = document.createElement("div");
    row.className = "row" + (name === current ? " playing" : "");
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = shortName(name);
    label.onclick = () => void play(name);
    const badge = document.createElement("span");
    badge.className = "badge";
    const kept = it.syncState !== "cloud-only";
    badge.textContent = kept ? "已离线" : (pinProgress.get(name) ?? covBadge.get(name) ?? "");
    const pin = document.createElement("button");
    pin.className = "pinbtn";
    pin.innerHTML = kept ? `<svg class="ic"><use href="#x"/></svg>` : `<svg class="ic"><use href="#download"/></svg>`;
    pin.title = kept ? "移除离线" : "留离线";
    pin.onclick = async () => {
      const f = fileOf(name);
      try {
        if (kept) { try { await f.offload(); log(`已移除离线：${name}`); } catch (e) { log(`offload 拒绝：${(e as Error).message}`); setStatus(`移除离线被拒：${(e as Error).message}`); } }
        else {
          log(`留离线开始：${name}`);
          const t0 = Date.now();
          await f.keepOffline({ onProgress: (d, t) => { pinProgress.set(name, `${Math.round((d / t) * 100)}%`); renderList(); } });
          pinProgress.delete(name);
          if (await f.isKeptOffline()) log(`留离线完成：${name}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
          else { log(`⚠ 留离线未完成：${name}（原因见上方 🛑 行）`); setStatus(`留离线未完成：${shortName(name)}`); }
        }
      } catch (e) { log(`🛑 留离线/移除异常：${name}：${(e as Error).message}`); pinProgress.delete(name); }
      renderList();
      if (current && mode === "folder") void prefetchNextHead(current);   // 可用性变了 → 重备战（防陈 flag）
    };
    row.append(label, badge, pin);
    listEl.append(row);
  }
  void refreshCovBadges();
}
function addNavRow(icon: string, text: string, onclick: () => void): void {
  const row = document.createElement("div");
  row.className = "row folder";
  const label = document.createElement("div");
  label.className = "label";
  label.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg> `;
  label.append(text);
  label.onclick = onclick;
  row.append(label);
  listEl.append(row);
}

// ── 控件（v1 tile 格：回退10s/上一曲 | 大播放键 | 前进30s/下一曲 | 音量条）──────
const bigPlay = $("bigPlay");
const bigPlayIcon = $("bigPlayIcon") as unknown as SVGUseElement;
const REWIND_SECS = 10, FORWARD_SECS = 30;
const prevOf = (list: string[], cur: string | null): string | null => {
  if (!list.length) return null;
  const i = cur ? list.indexOf(cur) : -1;
  return i <= 0 ? list[list.length - 1] : list[i - 1];
};
function renderControls(): void {
  bigPlayIcon.setAttribute("href", audio.paused ? "#play" : "#pause");
  const r = document.querySelector<HTMLInputElement>(`input[name="loop"][value="${mode}"]`);
  if (r) r.checked = true;
}
bigPlay.onclick = () => {
  if (!audio.paused) { audio.pause(); return; }
  if (current) { void audio.play(); return; }
  if (tracks.length) void play(tracks[0]);
  else setStatus("本夹没有可播的曲子——点开一个文件夹");
};
$("nextBtn").onclick = () => { const n = current ? nextOf(tracks, current) : tracks[0]; if (n) void play(n); };
$("prevBtn").onclick = () => { const p = prevOf(tracks, current); if (p) void play(p); };   // 复播规则：点曲从 0
$("rewindBtn").onclick = () => { if (current) audio.currentTime = Math.max(0, audio.currentTime - REWIND_SECS); };
$("forwardBtn").onclick = () => {
  if (!current) return;
  const t = audio.currentTime + FORWARD_SECS;
  audio.currentTime = Number.isFinite(audio.duration) ? Math.min(audio.duration, t) : t;
};
// 音量（iOS audio.volume 只读 → 整条藏掉，v1 同款检测；音量暂不持久化——落 device-state 需走持久化同意流程）
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
if (IS_IOS) document.body.classList.add("no-volume");
const volumeBar = $("volumeBar") as unknown as HTMLInputElement;
audio.volume = 0.8;
volumeBar.oninput = () => { audio.volume = Number(volumeBar.value) / 100; };
// 循环模式（抽屉 radio，v1 语言）
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="loop"]')) {
  r.onchange = () => {
    mode = r.value === "single" ? "single" : "folder";
    audio.loop = mode === "single";
    log(`模式 → ${mode === "single" ? "单曲循环" : "顺序循环"}`);
    savePlayback();
    if (mode === "folder" && current) void prefetchNextHead(current);
  };
}

// ── 抽屉菜单（v1 语言：☰ 开、backdrop/✕ 收、动作后自动收）────────────────────
const menuDrawer = $("menuDrawer");
const menuBackdrop = $("menuBackdrop");
let bridgeStop: ((opts?: { wipe?: boolean }) => void) | null = null;
function renderCloud(): void {
  const signed = auth.isSignedIn();
  $("cloudWho").textContent = signed ? String((auth.getActiveAccount() as { username?: string })?.username ?? "已登录") : "未登录";
  $("authLabel").textContent = signed ? "登出" : "登录";
  renderScope();
}
function openMenu(): void {
  menuDrawer.classList.add("open");
  menuBackdrop.classList.add("show");
  menuDrawer.setAttribute("aria-hidden", "false");
  renderCloud();
  // 缓存占用（origin 级估算，含 staging/本地副本/壳缓存）
  void navigator.storage?.estimate?.().then((est) => {
    if (est?.usage != null) $("usageNote").textContent = `本机占用约 ${(est.usage / 1048576).toFixed(0)} MB`;
  }).catch(() => {});
}
function closeMenu(): void {
  menuDrawer.classList.remove("open");
  menuBackdrop.classList.remove("show");
  menuDrawer.setAttribute("aria-hidden", "true");
}
$("menuToggle").onclick = openMenu;
$("menuClose").onclick = closeMenu;
menuBackdrop.onclick = closeMenu;
$("refreshBtn").onclick = () => { log("手动刷新列表"); watch(currentFolder); };
$("authBtn").onclick = () => {
  closeMenu();
  if (auth.isSignedIn()) {
    void (async () => {
      bridgeStop?.({ wipe: true });
      await auth.signOut();
      log("已登出（本 app 缓存已清，不踢微软会话）");
      renderCloud();
    })();
    return;
  }
  // 真 signIn（loginRedirect）：**同步调、前面零 await**（iOS user-gesture 要求，auth.ts:199 注）。
  // redirectUri = 本页 origin+pathname → Azure 注册 …/background-radio/dev/（2026-08-20 user 已加）。
  // 失败只明说，不迂回旧版页（2026-08-20 user：dev channel 对 prod 无知）。
  try {
    void Promise.resolve(auth.signIn()).catch((e) => { log(`signIn 失败：${(e as Error).message}`); setStatus(`登录失败：${(e as Error).message}`); });
  } catch (e) { log(`signIn 同步抛错：${(e as Error).message}`); setStatus(`登录失败：${(e as Error).message}`); }
};

// ── boot ────────────────────────────────────────────────────────────────
navigator.serviceWorker.addEventListener("message", (e) => { const m = (e.data as { br2log?: string })?.br2log; if (m) log(`[SW] ${m}`); });
let booted = false;
function proceedSignedIn(): void {
  if (booted) return;
  booted = true;
  log(`已登录：${String((auth.getActiveAccount() as { username?: string })?.username ?? "")}`);
  renderCloud();
  const bridge = startSwAuthBridge({ dbName: DB_NAME, getToken: () => auth.getToken() });   // 三层堵洞①：页面活着就续凭据给 SW
  bridgeStop = bridge.stop;
  void bridge.ready.then(() => log("凭据桥就绪（SW 可取 token）"));
  watch(currentFolder);
}
(async () => {
  log(`Background Radio v${APP_VERSION} 启动`);
  renderControls();
  await ensureSw();
  await deviceState.init();
  // 恢复上次（唯一中间复播点）：先恢复夹/模式，播放等用户点绿色继续键（iOS 也要手势才让响）。
  const saved = deviceState.getItem<PlaybackState>("playback");
  if (saved) {
    currentFolder = saved.folder ?? "";
    mode = saved.mode === "single" ? "single" : "folder";
    renderControls();
    if (saved.current) {
      const btn = $("resumeBtn");
      const pos = saved.position ?? 0;
      btn.textContent = `▶ 继续上次：${shortName(saved.current)}（${fmtTime(pos)}）`;
      btn.hidden = false;
      btn.onclick = () => { btn.hidden = true; void play(saved.current!, { resumeAt: pos }); };
      // 开机就把上次进度画在条上（2026-08-20 user：回到车里大脑音频记忆能对上「断在哪」）
      nowTitle.textContent = `⏸ ${shortName(saved.current)}（上次）`;
      posCur.textContent = fmtTime(pos);
      if (saved.duration && saved.duration > 0) {
        progressBar.style.width = `${Math.min(100, (pos / saved.duration) * 100)}%`;
        posDur.textContent = fmtTime(saved.duration);
      }
    }
  }
  const st = await auth.initAuth();
  if (st.signedIn || await auth.retrySilentSignIn()) { proceedSignedIn(); return; }
  renderCloud();
  log("未登录：点右上云按钮登录；已缓存/已离线内容照常可播");
  watch(currentFolder);   // 未登录也给本地帧（已离线的照常可见可播）
  const retry = async (): Promise<void> => {
    if (booted) return;
    if (await auth.retrySilentSignIn()) { log("检测到登录态，接上了"); proceedSignedIn(); }
  };
  addEventListener("focus", () => void retry());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void retry(); });
})();
