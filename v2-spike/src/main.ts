// BR v2 spike（2026-08-15 user 拍板 ad hoc 踩坑）——真机验证包，**不碰旧 app**。
// 验的就是计划 v2 的头号未知：① iOS PWA 里 SW 答 206 给 <audio>；② 后台 ended 同步换曲（活性接力）；
// ③ 降级 audio.loop；④ keepOffline 进度 + 先播后 pin 不重下；⑤ 断网 stall→复网自愈。
// 全部结果落屏上日志区（反煤气灯：真机现象自己会说话）。
import { createStore, createOneDriveProvider } from "../../../20260813 internal-store/src/index.ts";
import { startSwAuthBridge } from "../../../20260813 internal-store/src/sw/bridge.ts";
import { CLIENT_ID, AUTHORITY, SCOPES } from "../../config.js";

const SPIKE_V = "spike-6 · 2026-08-15";
const APP_ID = "br-spike";
const DB_NAME = `${APP_ID}.defaultStore`;
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac"]);

// ── 屏上日志（真机测量仪表；也镜像 console）──────────────────────────────
const logEl = document.getElementById("log")!;
function log(msg: string): void {
  const t = new Date();
  const line = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")} ${msg}`;
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
let nextHeadReady: string | null = null;   // 「下一曲头部已 staged」同步 flag（ended 里零异步可判）

function nextOf(name: string): string | null {
  const i = tracks.indexOf(name);
  return i >= 0 && tracks.length > 0 ? tracks[(i + 1) % tracks.length] : null;
}
async function prefetchNextHead(name: string): Promise<void> {
  const next = nextOf(name);
  nextHeadReady = null;
  if (!next || mode !== "folder") return;
  try {
    const h = await store.file(next, { isZip: false, mode: "existing" }).openStream();
    if (!h) { log(`预拉下一曲失败（拿不到）：${next}`); return; }
    await h.prefetch(0, 768 * 1024);
    h.close();
    nextHeadReady = next;
    log(`下一曲头部已备好：${next}`);
  } catch (e) { log(`预拉下一曲异常：${String((e as Error).message)}`); }
}
function play(name: string): void {
  current = name;
  audio.loop = mode === "single";
  audio.src = streamUrl(name);
  void audio.play().then(() => log(`▶ 播放：${name}`)).catch((e) => log(`play() 拒绝：${e.message}`));
  nowEl.textContent = `▶ ${name}`;
  setMediaSession(name);
  void prefetchNextHead(name);
  renderList();
}
audio.addEventListener("ended", () => {                       // ★被测主角：后台边界。此处**零异步**。
  log(`ended（mode=${mode}，flag=${nextHeadReady ?? "无"}）`);
  if (mode !== "folder" || !current) return;
  const next = nextOf(current);
  if (next && nextHeadReady === next) {
    current = next; nextHeadReady = null;
    audio.src = streamUrl(next);                              // 同步换 src + play：SW 从 staging 答头部 → 声音先响 → 页面复活
    void audio.play().then(() => log(`▶ 自动步进成功：${next}`)).catch((e) => log(`步进 play() 拒绝：${e.message}`));
    nowEl.textContent = `▶ ${next}`;
    setMediaSession(next);
    void prefetchNextHead(next);
  } else {
    audio.loop = true;                                        // 降级：头部没备好 → 单曲循环，回前台自愈
    void audio.play().catch(() => {});
    log("★降级 audio.loop 单曲循环（下一曲头部未备好/无下一曲）");
  }
});
for (const ev of ["error", "stalled", "waiting", "playing", "pause"] as const) {
  audio.addEventListener(ev, () => log(`audio 事件：${ev}${ev === "error" ? ` code=${audio.error?.code}` : ""}`));
}
function setMediaSession(name: string): void {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: name.split("/").pop(), artist: "BR spike" });
    navigator.mediaSession.setActionHandler("play", () => void audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => { const n = current && nextOf(current); if (n) play(n); });
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
    label.textContent = `${isAudio ? "🎵" : "📄"} ${name.split("/").pop()}（${it.syncState}${pinProgress.has(name) ? " " + pinProgress.get(name) : ""}）`;
    label.onclick = () => { if (isAudio) play(name); };
    row.append(label);
    const pin = document.createElement("button");
    const kept = it.syncState !== "cloud-only";
    pin.textContent = kept ? "✕离线" : "留离线";
    pin.onclick = async () => {
      const f = store.file(name, { isZip: false, mode: "existing" });
      if (kept) { try { await f.offload(); log(`已移除离线：${name}`); } catch (e) { log(`offload 拒绝：${(e as Error).message}`); } }
      else {
        const t0 = Date.now();
        await f.keepOffline({ onProgress: (d, t) => { pinProgress.set(name, `${Math.round((d / t) * 100)}%`); renderList(); } });
        pinProgress.delete(name);
        log(`留离线完成：${name}（${((Date.now() - t0) / 1000).toFixed(1)}s）★若先播过应快（只补缺口）`);
      }
      renderList();
    };
    row.append(pin);
    listEl.append(row);
  }
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
  for (const [label, secs, freq] of specs) {
    const name = `spike-test/${label}.wav`;
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
