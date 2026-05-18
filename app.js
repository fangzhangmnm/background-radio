import {
  initAuth,
  signIn,
  signOut,
  getToken,
  isSignedIn,
  getActiveAccount,
} from "./auth.js";
import * as cache from "./cache.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const STATE_KEY = "br.state";
const POSITION_SAVE_INTERVAL_MS = 5000;
const REWIND_SECS = 10;
const FORWARD_SECS = 30;
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i;

// === State ===
const defaultState = {
  // browser navigation (only ids; names live in browseStack for display)
  browseStack: [{ id: "root", name: "" }], // top of stack = current folder
  // currently loaded track
  currentTrack: null, // { id, name, parentFolderId }
  // loop behavior on `ended`
  mode: "folder", // "single" | "folder" | "stop"
  // current track's last position (mirror of positions[currentTrack.id], kept for convenience)
  position: 0,
  // per-track resume position map (trackId -> seconds). Entry deleted once track plays to end.
  positions: {},
  // user-set audio volume, 0..1
  volume: 0.8,
  // 跨会话:这首曾经被加载过吗?Proposal 的 "首播不存盘、下次重播再 fetch" 触发器
  everPlayed: {},
  // "auto" | "day" | "night"。inline script 在 CSS 应用前就读出来设了 data-theme
  theme: "auto",
  // 缓存上限(MB)。cache.js 默认 250,这里持久化用户的覆盖值
  cacheCapMB: 250,
};
let state = structuredClone(defaultState);

// in-memory caches, not persisted
let currentFolderItems = [];   // raw driveItems for browse folder (used by UI)
let trackFolderItems = null;   // raw audio driveItems for current track's parent (used for advance)
let restorePositionOnLoadedMetadata = 0;
let offlineMode = false;       // true:MSAL/Graph 不可用,只走 IDB 缓存

// === DOM ===
const $ = (id) => document.getElementById(id);
const audio = $("audio");
const userEl = $("user-name");
const btnLogin = $("btn-login");
const btnLogout = $("btn-logout");
const btnPlay = $("btn-play");
const btnPrev = $("btn-prev");
const btnNext = $("btn-next");
const btnRewind = $("btn-rewind");
const btnForward = $("btn-forward");
const statusTrackEl = $("status-track");
const statusScopeEl = $("status-scope");
const posCurrentEl = $("pos-current");
const posDurationEl = $("pos-duration");
const seekBar = $("seek-bar");
const volumeBar = $("volume-bar");
const folderListEl = $("folder-list");
const menuToggle = $("menu-toggle");
const menuClose = $("menu-close");
const menuDrawer = $("menu-drawer");
const menuBackdrop = $("menu-backdrop");
const cacheInfoEl = $("cache-info");
const btnCacheClear = $("btn-cache-clear");
const cacheCapInput = $("cache-cap-input");
const loopRadios = document.querySelectorAll('input[name="loop"]');
const themeRadios = document.querySelectorAll('input[name="theme"]');
const logEl = $("log");

// === 文件名脱后缀(显示用,内部仍按完整名找文件)===
function displayName(name) {
  return String(name).replace(/\.(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i, "");
}

// === Scope 路径解析:Graph 给的 path 形如 "/drive/root:/Apps/<AppName>/folder1/folder2"
//     去掉前面那一坨技术前缀,留 "/folder1/folder2",root 显示 "/"
function scopeLabel(driveItem) {
  const p = driveItem.parentReference?.path;
  if (!p) return "";
  const m = p.match(/^\/[^/]+\/[^/]+:\/[^/]+\/[^/]+(\/.*)?$/);
  if (!m) return p;
  return m[1] || "/";
}

// === Logging ===
function log(...args) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  console.log(...args);
  if (!logEl) return;
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

// === Persistence ===
function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state = { ...defaultState, ...saved };
    if (!Array.isArray(state.browseStack) || state.browseStack.length === 0) {
      state.browseStack = [{ id: "root", name: "" }];
    }
    if (!state.positions || typeof state.positions !== "object") {
      state.positions = {};
    }
    // migration: 旧的 state 只有 state.position,补一份到 map
    if (
      state.currentTrack &&
      state.position > 0 &&
      state.positions[state.currentTrack.id] == null
    ) {
      state.positions[state.currentTrack.id] = state.position;
    }
    if (typeof state.volume !== "number" || state.volume < 0 || state.volume > 1) {
      state.volume = 0.8;
    }
    if (!state.everPlayed || typeof state.everPlayed !== "object") {
      state.everPlayed = {};
    }
    if (state.theme !== "day" && state.theme !== "night" && state.theme !== "auto") {
      state.theme = "auto";
    }
    if (typeof state.cacheCapMB !== "number" || state.cacheCapMB < 50) {
      state.cacheCapMB = 250;
    }
    cache.setCapMB(state.cacheCapMB);
  } catch (e) {
    log("loadState 失败:", e.message);
  }
}

function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {
    log("saveState 失败:", e.message);
  }
}

// === Graph ===
async function graphGet(path) {
  const token = await getToken();
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Graph ${r.status}: ${await r.text()}`);
  return r.json();
}

function isAudio(item) {
  if (!item.file) return false;
  if ((item.file.mimeType || "").startsWith("audio/")) return true;
  return AUDIO_EXT_RE.test(item.name);
}

async function listFolder(folderId) {
  const startPath =
    folderId === "root"
      ? "/me/drive/special/approot/children"
      : `/me/drive/items/${folderId}/children`;
  const all = [];
  let next = startPath;
  while (next) {
    const page = await graphGet(next);
    all.push(...page.value);
    next = page["@odata.nextLink"] || null;
  }
  return all;
}

async function fetchItem(itemId) {
  return graphGet(`/me/drive/items/${itemId}?$expand=thumbnails`);
}

// 从 driveItem 提取封面图 URL(OneDrive 自动提取 ID3 cover art 为 thumbnails)
function getCoverUrl(driveItem) {
  const thumb = driveItem?.thumbnails?.[0];
  return thumb?.large?.url || thumb?.medium?.url || thumb?.small?.url || null;
}

const browserSection = document.querySelector(".browser");

async function applyCoverBackground(driveItem) {
  if (!driveItem || !browserSection) return;
  let url = getCoverUrl(driveItem);
  // 列表里来的 driveItem 没有 thumbnails 字段(listFolder 没 expand)→ 单独问
  if (!url) {
    try {
      const resp = await graphGet(`/me/drive/items/${driveItem.id}/thumbnails`);
      const thumb = resp.value?.[0];
      url = thumb?.large?.url || thumb?.medium?.url || thumb?.small?.url || null;
    } catch (_) {}
  }
  if (url) {
    document.documentElement.style.setProperty("--cover-bg", `url("${url}")`);
    browserSection.classList.add("has-cover");
  } else {
    browserSection.classList.remove("has-cover");
  }
}

// === Display helpers ===
function formatTime(secs) {
  if (!isFinite(secs) || secs < 0) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function currentBrowseFolderId() {
  return state.browseStack[state.browseStack.length - 1].id;
}

function currentBrowsePath() {
  const parts = state.browseStack.map((s) => s.name).filter(Boolean);
  return "/" + (parts.length ? parts.join("/") + "/" : "");
}

// === Browser rendering ===
function pinStateOf(trackId, cacheStatusMap, pinnedStatusMap) {
  if (!cacheStatusMap.get(trackId)) return "empty";
  return pinnedStatusMap.get(trackId) ? "pinned" : "cached";
}

function pinIconHtml(state) {
  const titles = {
    empty: "点击下载并锁定离线",
    cached: "已缓存(点击锁定为不可淘汰)",
    pinned: "已锁定(点击解锁)",
  };
  return `<button class="pin-btn" data-pin-state="${state}" aria-label="${titles[state]}" title="${titles[state]}"></button>`;
}

async function renderBrowser() {
  // 三种情形:offline / 未登录 / 在线
  if (offlineMode) {
    return renderBrowserFromCache();
  }
  if (!isSignedIn()) {
    folderListEl.innerHTML = '<li class="entry empty">未登录</li>';
    return;
  }
  folderListEl.innerHTML = '<li class="entry empty">加载中…</li>';
  try {
    currentFolderItems = await listFolder(currentBrowseFolderId());
  } catch (e) {
    log("列目录失败,fallback 到本地缓存:", e.message);
    offlineMode = true;
    document.body.classList.add("offline");
    return renderBrowserFromCache();
  }

  const rows = [];
  if (state.browseStack.length > 1) {
    rows.push({ kind: "up" });
  }
  const folders = currentFolderItems.filter((i) => i.folder);
  const audios = currentFolderItems.filter(isAudio);
  folders.sort((a, b) => a.name.localeCompare(b.name));
  audios.sort((a, b) => a.name.localeCompare(b.name));
  for (const f of folders) rows.push({ kind: "folder", item: f });
  for (const a of audios) rows.push({ kind: "file", item: a });

  if (rows.length === 0) {
    folderListEl.innerHTML = '<li class="entry empty">空目录</li>';
    return;
  }

  // 并发查所有 audio 的 cache + pinned 状态
  const cacheStatus = new Map();
  const pinnedStatus = new Map();
  await Promise.all(
    audios.map(async (a) => {
      try {
        const m = await cache.getMeta(a.id);
        cacheStatus.set(a.id, !!m);
        pinnedStatus.set(a.id, !!(m && m.pinned));
      } catch (_) {
        cacheStatus.set(a.id, false);
        pinnedStatus.set(a.id, false);
      }
    })
  );

  folderListEl.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "entry";

    if (row.kind === "up") {
      li.innerHTML = `<span class="icon">↰</span><span class="name">..</span>`;
      li.addEventListener("click", goUp);
    } else if (row.kind === "folder") {
      li.innerHTML = `<span class="icon">▦</span><span class="name">${escapeHtml(row.item.name)}</span>`;
      li.addEventListener("click", () => navigateInto(row.item));
    } else {
      const dur =
        row.item.audio?.duration != null
          ? formatTime(row.item.audio.duration / 1000)
          : "";
      const ps = pinStateOf(row.item.id, cacheStatus, pinnedStatus);
      li.dataset.trackId = row.item.id;
      li.innerHTML =
        `<span class="icon">♪</span>` +
        `<span class="name">${escapeHtml(displayName(row.item.name))}</span>` +
        (dur ? `<span class="meta">${dur}</span>` : "") +
        pinIconHtml(ps);
      if (ps !== "empty") li.classList.add("cached");
      if (ps === "pinned") li.classList.add("pinned");
      if (state.currentTrack && state.currentTrack.id === row.item.id) {
        li.classList.add("active");
      }
      const pinBtn = li.querySelector(".pin-btn");
      pinBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        handlePinClick(row.item, li);
      });
      li.addEventListener("click", () => playTrack(row.item));
      attachLongPress(li, () => handleLongPressDelete(row.item, li));
    }
    folderListEl.appendChild(li);
  }
}

// 离线模式:从 cache.meta 派生一个 flat list,只显示已缓存的曲
async function renderBrowserFromCache() {
  folderListEl.innerHTML = '<li class="entry empty">加载本地缓存…</li>';
  let all;
  try {
    all = await cache.listAllMeta();
  } catch (e) {
    folderListEl.innerHTML = `<li class="entry empty">读缓存失败: ${escapeHtml(e.message)}</li>`;
    return;
  }
  if (all.length === 0) {
    folderListEl.innerHTML = '<li class="entry empty">离线模式 · 无缓存可放</li>';
    return;
  }
  all.sort((a, b) =>
    (a.parentFolderName || "").localeCompare(b.parentFolderName || "") ||
    (a.name || "").localeCompare(b.name || "")
  );

  folderListEl.innerHTML = "";
  for (const m of all) {
    const li = document.createElement("li");
    li.className = "entry cached" + (m.pinned ? " pinned" : "");
    li.dataset.trackId = m.trackId;
    const dur = m.duration != null ? formatTime(m.duration) : "";
    const folderTag = m.parentFolderName
      ? `<span class="meta">${escapeHtml(m.parentFolderName)}</span>`
      : "";
    const ps = m.pinned ? "pinned" : "cached";
    li.innerHTML =
      `<span class="icon">♪</span>` +
      `<span class="name">${escapeHtml(displayName(m.name || m.trackId))}</span>` +
      (dur ? `<span class="meta">${dur}</span>` : "") +
      folderTag +
      pinIconHtml(ps);
    if (state.currentTrack && state.currentTrack.id === m.trackId) {
      li.classList.add("active");
    }
    // 构造 driveItem-like,playTrack 会先查 cache.getBlob,命中即播
    const fakeItem = {
      id: m.trackId,
      name: m.name || m.trackId,
      parentReference: m.parentFolderId
        ? { id: m.parentFolderId, name: m.parentFolderName }
        : null,
    };
    const pinBtn = li.querySelector(".pin-btn");
    pinBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      handlePinClick(fakeItem, li);
    });
    li.addEventListener("click", () => playTrack(fakeItem));
    attachLongPress(li, () => handleLongPressDelete(fakeItem, li));
    folderListEl.appendChild(li);
  }
}

async function navigateInto(folderItem) {
  state.browseStack.push({ id: folderItem.id, name: folderItem.name });
  saveState();
  await renderBrowser();
}

async function goUp() {
  if (state.browseStack.length <= 1) return;
  state.browseStack.pop();
  saveState();
  await renderBrowser();
}

// === Playback ===
function setPlayGlyph() {
  btnPlay.classList.toggle("paused", audio.paused);
}

// 当前 audio.src 的来源,失败处理 / blob 释放都需要知道
let currentSrcKind = null; // "blob" | "downloadUrl" | null
let currentBlobUrl = null;
let prefetchTriggered = false; // 当前曲是否已触发过下一首 prefetch

function clearBlobUrl() {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

// 后台 fetch 整首入库 —— 不阻塞调用方
// 返回 true / false 让调用方知道有没有成功(让 pin 流程能根据结果决定是否 setPinned)
async function backgroundCacheTrack(driveItem, options = {}) {
  if (offlineMode) {
    log("offline: 跳过 background cache");
    return false;
  }
  try {
    if (await cache.isCached(driveItem.id)) {
      if (options.pinAfter) {
        await cache.setPinned(driveItem.id, true);
        refreshCachedMarkers().catch(() => {});
      }
      return true;
    }
    log(`后台缓存: ${driveItem.name}`);
    // downloadUrl 可能过期(列目录到现在 >1h),refetch 一次保证新鲜
    let dl = driveItem["@microsoft.graph.downloadUrl"];
    try {
      const fresh = await fetchItem(driveItem.id);
      dl = fresh["@microsoft.graph.downloadUrl"];
    } catch (_) {}
    if (!dl) throw new Error("无 downloadUrl");
    const resp = await fetch(dl);
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const blob = await resp.blob();
    const ok = await cache.set(driveItem.id, blob, {
      name: driveItem.name,
      duration: driveItem.audio?.duration
        ? driveItem.audio.duration / 1000
        : null,
      parentFolderId: driveItem.parentReference?.id ?? null,
      parentFolderName: driveItem.parentReference?.name ?? null,
      pinned: !!options.pinAfter,
    });
    if (!ok) {
      log(`未缓存(容量塞不下): ${driveItem.name} ${cache.formatBytes(blob.size)}`);
      return false;
    }
    log(`已缓存: ${driveItem.name} ${cache.formatBytes(blob.size)}${options.pinAfter ? " · pinned" : ""}`);
    refreshCachedMarkers().catch(() => {});
    refreshCacheInfo().catch(() => {});
    return true;
  } catch (e) {
    log(`后台缓存失败 ${driveItem.name}:`, e.message);
    return false;
  }
}

async function playTrack(driveItem, startAt = null) {
  // 切歌前把当前正在播的位置存进 map(模式如果允许后续恢复就用得上)
  // 但如果当前曲已经自然 ended,不要把"末尾位置"重新写回 map —— handleEnded 刚清掉它
  if (
    state.currentTrack &&
    state.currentTrack.id !== driveItem.id &&
    !audio.ended
  ) {
    persistPosition();
  }
  // startAt 语义:
  //   null  → 默认行为:单曲模式从 map 恢复,其它模式从 0
  //   0     → 显式从头(folder 自动 advance 时用)
  //   N>0   → 跳到 N(app-open resume 时用)
  if (startAt === null) {
    startAt = state.mode === "single"
      ? (state.positions[driveItem.id] ?? 0)
      : 0;
  }

  log(`load: ${driveItem.name} @ ${startAt}s`);
  state.currentTrack = {
    id: driveItem.id,
    name: driveItem.name,
    parentFolderId: driveItem.parentReference?.id ?? null,
  };
  state.position = startAt;
  saveState();

  statusTrackEl.textContent = displayName(driveItem.name);
  statusScopeEl.textContent = scopeLabel(driveItem);

  // Highlight in current folder list if visible
  for (const el of folderListEl.querySelectorAll(".entry.active")) {
    el.classList.remove("active");
  }
  const li = folderListEl.querySelector(`.entry[data-track-id="${driveItem.id}"]`);
  if (li) li.classList.add("active");

  // Refresh track-folder listing for advance logic
  // Online:从 Graph 拿;offline:从 cache.meta 派生同 parent 的曲
  if (state.currentTrack.parentFolderId) {
    if (offlineMode) {
      try {
        const allMeta = await cache.listAllMeta();
        trackFolderItems = allMeta
          .filter((m) => m.parentFolderId === state.currentTrack.parentFolderId)
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
          .map((m) => ({
            id: m.trackId,
            name: m.name,
            parentReference: { id: m.parentFolderId, name: m.parentFolderName },
          }));
      } catch (_) {
        trackFolderItems = null;
      }
    } else {
      try {
        const siblings = await listFolder(state.currentTrack.parentFolderId);
        trackFolderItems = siblings.filter(isAudio);
      } catch (e) {
        log("加载同级文件失败:", e.message);
        trackFolderItems = null;
      }
    }
  }

  // 释放上一首的 blob URL,prefetch flag 重置
  clearBlobUrl();
  prefetchTriggered = false;

  // 先查 cache。命中 → blob URL;未命中 → 在线 fallback 到 downloadUrl,离线放弃
  let cachedBlob = null;
  try {
    cachedBlob = await cache.getBlob(driveItem.id);
  } catch (e) {
    log("cache.getBlob 失败:", e.message);
  }

  if (cachedBlob) {
    currentBlobUrl = URL.createObjectURL(cachedBlob);
    audio.src = currentBlobUrl;
    currentSrcKind = "blob";
    log(`cache 命中: ${driveItem.name}`);
    cache.touch(driveItem.id).catch(() => {});
  } else if (offlineMode) {
    log(`offline 且无缓存:${driveItem.name} 无法播`);
    return;
  } else {
    const dl = driveItem["@microsoft.graph.downloadUrl"];
    if (!dl) {
      log("⚠️ 该 item 没有 downloadUrl,试着 refetch...");
      try {
        const fresh = await fetchItem(driveItem.id);
        audio.src = fresh["@microsoft.graph.downloadUrl"];
      } catch (e) {
        log("refetch 失败:", e.message);
        return;
      }
    } else {
      audio.src = dl;
    }
    currentSrcKind = "downloadUrl";

    // "首播不存盘、下次重播再 fetch" —— 用 state.everPlayed 当 2nd-play 触发器
    if (state.everPlayed[driveItem.id]) {
      // 之前听过这首 + 这次又点了 + 没缓存 → 背景灌入
      backgroundCacheTrack(driveItem);
    }
  }

  // 记下这首被加载过
  state.everPlayed[driveItem.id] = true;
  saveState();

  // 封面图作 listview 淡背景(异步,不阻塞,offline 跳过)
  if (!offlineMode) applyCoverBackground(driveItem).catch(() => {});

  restorePositionOnLoadedMetadata = startAt;

  try {
    await audio.play();
  } catch (e) {
    // 自动 play 可能被浏览器拒(尤其在 init resume 时无 gesture)
    log("autoplay 被拒,等用户点播放:", e.message);
  }
  setPlayGlyph();
}

async function refetchDownloadUrlAndResume() {
  if (!state.currentTrack) return;
  log("downloadUrl 可能过期,refetching...");
  try {
    const fresh = await fetchItem(state.currentTrack.id);
    const dl = fresh["@microsoft.graph.downloadUrl"];
    if (!dl) throw new Error("refetch 后仍无 downloadUrl");
    const wasPosition = state.position || audio.currentTime || 0;
    clearBlobUrl();
    audio.src = dl;
    currentSrcKind = "downloadUrl";
    restorePositionOnLoadedMetadata = wasPosition;
    await audio.play();
  } catch (e) {
    log("refetch 失败:", e.message);
  }
}

// === Folder-loop prefetch ===
// 当前曲剩 < PREFETCH_THRESHOLD_S 秒 + folder loop 模式 → 后台拉下一首入库
const PREFETCH_THRESHOLD_S = 60;
function maybePrefetchNext() {
  if (state.mode !== "folder") return;
  if (prefetchTriggered) return;
  if (!trackFolderItems || trackFolderItems.length < 2) return;
  if (!state.currentTrack) return;
  const dur = audio.duration;
  if (!isFinite(dur) || dur <= 0) return;
  if (dur - audio.currentTime > PREFETCH_THRESHOLD_S) return;

  const idx = trackFolderItems.findIndex((t) => t.id === state.currentTrack.id);
  if (idx === -1) return;
  const nextIdx = idx === trackFolderItems.length - 1 ? 0 : idx + 1;
  const next = trackFolderItems[nextIdx];
  if (!next) return;
  prefetchTriggered = true;
  backgroundCacheTrack(next);
}

// === Cache UI ===
async function refreshCachedMarkers() {
  const lis = folderListEl.querySelectorAll(".entry[data-track-id]");
  for (const li of lis) {
    const id = li.dataset.trackId;
    const m = await cache.getMeta(id);
    const cached = !!m;
    const pinned = !!(m && m.pinned);
    li.classList.toggle("cached", cached);
    li.classList.toggle("pinned", pinned);
    const btn = li.querySelector(".pin-btn");
    if (btn) {
      const ps = !cached ? "empty" : pinned ? "pinned" : "cached";
      btn.dataset.pinState = ps;
    }
  }
}

// 点 pin icon:在 empty → caching/pinned → unpin → cached 之间循环
async function handlePinClick(driveItem, li) {
  const m = await cache.getMeta(driveItem.id);
  if (!m) {
    // empty → 触发下载 + pin。需要网络
    if (offlineMode) {
      log("offline 不能 pin 未缓存的曲");
      return;
    }
    const btn = li.querySelector(".pin-btn");
    if (btn) btn.dataset.pinState = "loading";
    const ok = await backgroundCacheTrack(driveItem, { pinAfter: true });
    if (!ok && btn) btn.dataset.pinState = "empty";
  } else if (!m.pinned) {
    // cached → pinned
    await cache.setPinned(driveItem.id, true);
    log(`pin: ${driveItem.name}`);
    refreshCachedMarkers().catch(() => {});
    refreshCacheInfo().catch(() => {});
  } else {
    // pinned → unpinned (仍 cached)
    await cache.setPinned(driveItem.id, false);
    log(`unpin: ${driveItem.name}`);
    refreshCachedMarkers().catch(() => {});
    refreshCacheInfo().catch(() => {});
  }
}

async function handleLongPressDelete(driveItem, li) {
  if (!(await cache.isCached(driveItem.id))) return;
  const ok = confirm(`从本地缓存删除「${driveItem.name}」?\n(不影响 OneDrive)`);
  if (!ok) return;
  try {
    // 如果正在播这首 + 当前 src 是 blob:online 切回 downloadUrl 不掉链子;
    // offline 没救,但 audio element 已经载入了 blob 数据可以继续放完,只是不能重启
    if (
      state.currentTrack?.id === driveItem.id &&
      currentSrcKind === "blob" &&
      !offlineMode
    ) {
      log("正在播这首,切回 downloadUrl 再删 cache");
      const wasPosition = audio.currentTime;
      const wasPlaying = !audio.paused;
      clearBlobUrl();
      const fresh = await fetchItem(driveItem.id);
      audio.src = fresh["@microsoft.graph.downloadUrl"];
      currentSrcKind = "downloadUrl";
      restorePositionOnLoadedMetadata = wasPosition;
      if (wasPlaying) audio.play().catch(() => {});
    }
    await cache.del(driveItem.id);
    li.classList.remove("cached");
    li.classList.remove("pinned");
    const btn = li.querySelector(".pin-btn");
    if (btn) btn.dataset.pinState = "empty";
    refreshCacheInfo().catch(() => {});
    log(`已从缓存删除: ${driveItem.name}`);
  } catch (e) {
    log("删除失败:", e.message);
  }
}

// 简陋但够用的长按:鼠标 / 触摸都接;一旦触发了 long-press,屏蔽紧随的 click
function attachLongPress(el, handler, ms = 600) {
  let timer = null;
  let fired = false;
  const start = () => {
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      handler();
    }, ms);
  };
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
  el.addEventListener("touchmove", cancel);
  el.addEventListener("mousedown", start);
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
  el.addEventListener(
    "click",
    (e) => {
      if (fired) {
        e.stopPropagation();
        e.preventDefault();
        fired = false;
      }
    },
    true
  );
}

// startAt: 0 = 显式从头(folder auto-advance 用),null = 跟模式决定(用户点 prev/next 用)
async function advance(direction, startAt = null) {
  if (!state.currentTrack || !trackFolderItems || trackFolderItems.length === 0) {
    audio.pause();
    setPlayGlyph();
    return;
  }
  const idx = trackFolderItems.findIndex((t) => t.id === state.currentTrack.id);
  if (idx === -1) {
    await playTrack(trackFolderItems[0], startAt);
    return;
  }
  const lastIdx = trackFolderItems.length - 1;
  let nextIdx;
  if (direction === "next") {
    nextIdx = idx === lastIdx ? 0 : idx + 1;
  } else {
    nextIdx = idx === 0 ? lastIdx : idx - 1;
  }
  await playTrack(trackFolderItems[nextIdx], startAt);
}

function handleEnded() {
  log(`ended; mode=${state.mode}`);
  // 这首播完了:map 项删除 + state.position 归 0(避免 reload 后从近末尾恢复又立刻 ended)
  if (state.currentTrack) {
    delete state.positions[state.currentTrack.id];
    state.position = 0;
    saveState();
  }
  if (state.mode === "single") {
    audio.currentTime = 0;
    audio.play().catch((e) => log("repeat play 失败:", e.message));
  } else if (state.mode === "folder") {
    advance("next", 0);  // 显式从头:folder 自动 advance 永远新开
  } else {
    // stop
    audio.pause();
    setPlayGlyph();
  }
}

// === Seek bar ===
let seekDragging = false;
function updateSeekDisplay() {
  if (seekDragging) return;
  const dur = audio.duration;
  posCurrentEl.textContent = formatTime(audio.currentTime);
  posDurationEl.textContent = formatTime(dur);
  if (isFinite(dur) && dur > 0) {
    seekBar.value = String(Math.round((audio.currentTime / dur) * 1000));
  }
}

seekBar.addEventListener("input", () => {
  seekDragging = true;
  const dur = audio.duration;
  if (isFinite(dur)) {
    posCurrentEl.textContent = formatTime((Number(seekBar.value) / 1000) * dur);
  }
});

seekBar.addEventListener("change", () => {
  const dur = audio.duration;
  if (isFinite(dur)) {
    audio.currentTime = (Number(seekBar.value) / 1000) * dur;
    updateMediaSessionPosition();
  }
  seekDragging = false;
});

// === Media Session API ===
// 让锁屏 / 系统媒体浮层 / 蓝牙耳机按键 / 方向盘控件能控制播放。
// 仅在浏览器实现了 mediaSession 时才接,失败 setActionHandler 用 try 包好。
function hasMediaSession() {
  return "mediaSession" in navigator;
}

function updateMediaSessionMetadata() {
  if (!hasMediaSession() || !state.currentTrack) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: displayName(state.currentTrack.name),
    artist: "Background Radio",
    album: currentBrowsePath() || "/",
  });
}

function setMSHandler(action, handler) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch (_) {
    // 某些浏览器不支持某些 action,忽略
  }
}

function updateMediaSessionHandlers() {
  if (!hasMediaSession()) return;
  setMSHandler("play", () => audio.play().catch(() => {}));
  setMSHandler("pause", () => audio.pause());
  setMSHandler("seekbackward", (e) => {
    audio.currentTime = Math.max(0, audio.currentTime - (e.seekOffset || REWIND_SECS));
    updateMediaSessionPosition();
  });
  setMSHandler("seekforward", (e) => {
    const target = audio.currentTime + (e.seekOffset || FORWARD_SECS);
    audio.currentTime = isFinite(audio.duration)
      ? Math.min(audio.duration, target)
      : target;
    updateMediaSessionPosition();
  });
  setMSHandler("seekto", (e) => {
    if (e.seekTime != null) {
      audio.currentTime = e.seekTime;
      updateMediaSessionPosition();
    }
  });
  setMSHandler("previoustrack", () => advance("prev"));
  setMSHandler("nexttrack", () => advance("next"));
}

function updateMediaSessionPosition() {
  if (!hasMediaSession()) return;
  const dur = audio.duration;
  if (!isFinite(dur) || dur <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: dur,
      position: Math.min(audio.currentTime, dur),
      playbackRate: audio.playbackRate || 1,
    });
  } catch (_) {
    // 某些版本对参数挑剔,忽略
  }
}

// === Audio events ===
audio.addEventListener("loadedmetadata", () => {
  if (restorePositionOnLoadedMetadata > 0) {
    audio.currentTime = restorePositionOnLoadedMetadata;
    restorePositionOnLoadedMetadata = 0;
  }
  updateSeekDisplay();
  updateMediaSessionMetadata();
  updateMediaSessionHandlers();
  updateMediaSessionPosition();
});
audio.addEventListener("timeupdate", () => {
  updateSeekDisplay();
  maybePrefetchNext();
});
audio.addEventListener("play", () => {
  setPlayGlyph();
  if (hasMediaSession()) navigator.mediaSession.playbackState = "playing";
  updateMediaSessionPosition();
});
audio.addEventListener("pause", () => {
  setPlayGlyph();
  if (hasMediaSession()) navigator.mediaSession.playbackState = "paused";
});
audio.addEventListener("ended", handleEnded);
audio.addEventListener("error", () => {
  const code = audio.error?.code;
  log(`audio error code=${code} (1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED)`);
  if (currentSrcKind === "blob") {
    // 缓存 blob 出错(罕见)—— 丢弃,回退 downloadUrl 重播
    log("blob 失败,丢弃 cache 并 fallback 到 downloadUrl");
    if (state.currentTrack) cache.del(state.currentTrack.id).catch(() => {});
  }
  // downloadUrl 失败最可能是过期;blob 失败 fallback 也走这条
  refetchDownloadUrlAndResume();
});

window.addEventListener("beforeunload", clearBlobUrl);

function persistPosition() {
  if (!state.currentTrack) return;
  state.position = audio.currentTime;
  state.positions[state.currentTrack.id] = audio.currentTime;
  saveState();
}

setInterval(() => {
  if (!state.currentTrack || audio.paused) return;
  persistPosition();
}, POSITION_SAVE_INTERVAL_MS);

window.addEventListener("beforeunload", () => {
  if (state.currentTrack) persistPosition();
});

audio.addEventListener("pause", persistPosition);

// === Controls wiring ===
btnPlay.addEventListener("click", async () => {
  if (!state.currentTrack) return;
  if (audio.paused) {
    if (!audio.src) {
      // resume after reload: 先试 cache,失败再上 downloadUrl,offline 只走 cache
      const blob = await cache.getBlob(state.currentTrack.id).catch(() => null);
      if (blob) {
        currentBlobUrl = URL.createObjectURL(blob);
        audio.src = currentBlobUrl;
        currentSrcKind = "blob";
        restorePositionOnLoadedMetadata =
          state.positions[state.currentTrack.id] ?? state.position ?? 0;
        cache.touch(state.currentTrack.id).catch(() => {});
      } else if (offlineMode) {
        log("offline 且当前曲无缓存,无法 resume");
        return;
      } else {
        try {
          const fresh = await fetchItem(state.currentTrack.id);
          audio.src = fresh["@microsoft.graph.downloadUrl"];
          currentSrcKind = "downloadUrl";
          restorePositionOnLoadedMetadata =
            state.positions[state.currentTrack.id] ?? state.position ?? 0;
          if (state.currentTrack.parentFolderId) {
            try {
              const siblings = await listFolder(state.currentTrack.parentFolderId);
              trackFolderItems = siblings.filter(isAudio);
            } catch (e) {
              log("加载同级文件失败:", e.message);
            }
          }
        } catch (e) {
          log("无法获取 downloadUrl:", e.message);
          return;
        }
      }
    }
    audio.play().catch((e) => log("play 失败:", e.message));
  } else {
    audio.pause();
  }
});

btnRewind.addEventListener("click", () => {
  if (!audio.src) return;
  audio.currentTime = Math.max(0, audio.currentTime - REWIND_SECS);
  updateMediaSessionPosition();
});

btnForward.addEventListener("click", () => {
  if (!audio.src) return;
  const dur = audio.duration;
  const target = audio.currentTime + FORWARD_SECS;
  audio.currentTime = isFinite(dur) ? Math.min(dur, target) : target;
  updateMediaSessionPosition();
});

btnPrev.addEventListener("click", () => advance("prev"));
btnNext.addEventListener("click", () => advance("next"));

function applyModeUi() {
  for (const r of loopRadios) {
    r.checked = r.value === state.mode;
  }
  // prev/next 任何模式都显示;Media Session handler 也总在
  updateMediaSessionHandlers();
}

for (const r of loopRadios) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    state.mode = r.value;
    saveState();
    applyModeUi();
    log(`loop mode → ${state.mode}`);
  });
}

// === Theme ===
function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.theme);
  for (const r of themeRadios) {
    r.checked = r.value === state.theme;
  }
}

for (const r of themeRadios) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    state.theme = r.value;
    saveState();
    applyTheme();
    log(`theme → ${state.theme}`);
  });
}

// === Volume ===
function applyVolume() {
  audio.volume = state.volume;
  volumeBar.value = String(Math.round(state.volume * 100));
}

volumeBar.addEventListener("input", () => {
  state.volume = Number(volumeBar.value) / 100;
  audio.volume = state.volume;
});
volumeBar.addEventListener("change", saveState);

// === Auth controls ===
btnLogin.addEventListener("click", async () => {
  log("跳转登录...");
  try {
    await signIn();
  } catch (e) {
    log("signIn 失败:", e.message);
  }
});

btnLogout.addEventListener("click", async () => {
  await signOut();
  userEl.textContent = "";
  btnLogin.hidden = false;
  btnLogout.hidden = true;
  folderListEl.innerHTML = '<li class="entry empty">未登录</li>';
  log("已登出(仅本地缓存)");
});

// === Menu drawer ===
function openMenu() {
  menuDrawer.classList.add("open");
  menuBackdrop.classList.add("show");
  menuDrawer.setAttribute("aria-hidden", "false");
  refreshCacheInfo().catch(() => {});
}
function closeMenu() {
  menuDrawer.classList.remove("open");
  menuBackdrop.classList.remove("show");
  menuDrawer.setAttribute("aria-hidden", "true");
}
menuToggle.addEventListener("click", openMenu);
menuClose.addEventListener("click", closeMenu);
menuBackdrop.addEventListener("click", closeMenu);

// === Cache info / clear all ===
async function refreshCacheInfo() {
  try {
    const s = await cache.stats();
    const pinnedHint = s.pinnedCount ? ` · ${s.pinnedCount} pinned` : "";
    cacheInfoEl.textContent =
      `${s.count} 首 · ${cache.formatBytes(s.totalBytes)} / ${cache.formatBytes(s.capBytes)}${pinnedHint}`;
  } catch (e) {
    cacheInfoEl.textContent = "无法读取";
  }
  if (cacheCapInput && document.activeElement !== cacheCapInput) {
    cacheCapInput.value = String(state.cacheCapMB);
  }
}

// 缓存上限输入(MB)。回车或失焦保存,validate 50–8192
cacheCapInput?.addEventListener("change", () => {
  const v = parseInt(cacheCapInput.value, 10);
  if (!isFinite(v) || v < 50) {
    cacheCapInput.value = String(state.cacheCapMB);
    return;
  }
  const clamped = Math.min(Math.max(v, 50), 8192);
  state.cacheCapMB = clamped;
  cache.setCapMB(clamped);
  saveState();
  cacheCapInput.value = String(clamped);
  log(`缓存上限 → ${clamped} MB`);
  refreshCacheInfo().catch(() => {});
});

btnCacheClear.addEventListener("click", async () => {
  const s = await cache.stats();
  if (s.count === 0) {
    log("缓存空,无需清除");
    return;
  }
  if (!confirm(`清除全部本地缓存(${s.count} 首,${cache.formatBytes(s.totalBytes)})?\n不影响 OneDrive。`)) return;
  // 正在播的如果是 blob,online 切回 downloadUrl,offline 让 audio 用已载入数据继续放完
  if (currentSrcKind === "blob" && state.currentTrack && !offlineMode) {
    try {
      const wasPosition = audio.currentTime;
      const wasPlaying = !audio.paused;
      clearBlobUrl();
      const fresh = await fetchItem(state.currentTrack.id);
      audio.src = fresh["@microsoft.graph.downloadUrl"];
      currentSrcKind = "downloadUrl";
      restorePositionOnLoadedMetadata = wasPosition;
      if (wasPlaying) audio.play().catch(() => {});
    } catch (e) {
      log("切回 downloadUrl 失败:", e.message);
    }
  }
  await cache.clearAll();
  await refreshCachedMarkers();
  await refreshCacheInfo();
  log("已清除全部缓存");
});

// === Init ===
const tapOverlay = $("tap-overlay");
const tapTitleEl = $("tap-title");

function showTapOverlay(title) {
  tapTitleEl.textContent = title;
  tapOverlay.hidden = false;
}
function hideTapOverlay() {
  tapOverlay.hidden = true;
}

// 注意:audio.play() 必须在用户 gesture 同步路径里调,所以不要在 await 后头调
tapOverlay.addEventListener("click", () => {
  hideTapOverlay();
  audio.play().catch((e) => {
    log("点 overlay 后 play 仍失败:", e.message);
    // 多半是 src 未就绪;给用户回个失败提示后再让大 ▶ 接管
  });
});

async function restoreSession() {
  if (!state.currentTrack) return;
  statusTrackEl.textContent = displayName(state.currentTrack.name);
  statusScopeEl.textContent = `恢复 @ ${formatTime(state.position)}`;
  posCurrentEl.textContent = formatTime(state.position);
  log("恢复:", state.currentTrack.name, "@", formatTime(state.position));

  // 先查 cache。命中 → blob URL,立刻可以播;不命中 + online → 拉 downloadUrl;不命中 + offline → 放弃
  const blob = await cache.getBlob(state.currentTrack.id).catch(() => null);
  if (blob) {
    currentBlobUrl = URL.createObjectURL(blob);
    audio.src = currentBlobUrl;
    currentSrcKind = "blob";
    restorePositionOnLoadedMetadata =
      state.positions[state.currentTrack.id] ?? state.position ?? 0;
    cache.touch(state.currentTrack.id).catch(() => {});
    // siblings 取自 cache(offline 或在线都先这样,够 prev/next 用)
    if (state.currentTrack.parentFolderId) {
      try {
        const allMeta = await cache.listAllMeta();
        trackFolderItems = allMeta
          .filter((m) => m.parentFolderId === state.currentTrack.parentFolderId)
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
          .map((m) => ({
            id: m.trackId,
            name: m.name,
            parentReference: { id: m.parentFolderId, name: m.parentFolderName },
          }));
      } catch (_) {}
    }
  } else if (offlineMode) {
    log("offline 且当前曲无缓存,无法 resume play");
    return;
  } else {
    try {
      const fresh = await fetchItem(state.currentTrack.id);
      audio.src = fresh["@microsoft.graph.downloadUrl"];
      currentSrcKind = "downloadUrl";
      restorePositionOnLoadedMetadata =
        state.positions[state.currentTrack.id] ?? state.position ?? 0;
      if (state.currentTrack.parentFolderId) {
        try {
          const siblings = await listFolder(state.currentTrack.parentFolderId);
          trackFolderItems = siblings.filter(isAudio);
        } catch (e) {
          log("加载同级文件失败:", e.message);
        }
      }
    } catch (e) {
      log("resume 预拉失败:", e.message);
      return;
    }
  }

  // 试 autoplay。Chrome/Edge PWA 攒了 engagement 会放行;iOS 必拒,这时弹蒙层
  try {
    await audio.play();
    log("autoplay 成功");
  } catch (e) {
    log("autoplay 被拒,弹 tap overlay:", e.message);
    showTapOverlay(displayName(state.currentTrack.name));
  }
}

async function main() {
  loadState();
  applyTheme();
  applyModeUi();
  applyVolume();

  log("加载 MSAL...");
  let result;
  try {
    result = await initAuth();
  } catch (e) {
    log("auth init 失败:", e.message);
    return;
  }

  if (result.offline) {
    log("auth 离线模式(MSAL CDN 未加载):", result.msalError || "");
    offlineMode = true;
    document.body.classList.add("offline");
    btnLogin.hidden = true;
    btnLogout.hidden = true;
    userEl.textContent = "离线 · 仅缓存可用";
    await renderBrowser();
    await restoreSession();
    return;
  }

  if (result.signedIn) {
    userEl.textContent = result.account.username;
    btnLogin.hidden = true;
    btnLogout.hidden = false;
    log("已登录(本 app 已授权):", result.account.username);
    await renderBrowser();
    await restoreSession();
  } else {
    if (result.probedAccount) {
      log("检测到缓存账号但本 app 未授权,点登录授权:", result.probedAccount.username);
    } else {
      log("未登录,点登录开始");
    }
    btnLogin.hidden = false;
    btnLogout.hidden = true;
  }
}

main().catch((e) => log("启动失败:", e.message));

// === Service worker 注册 + auto-update toast ===
// SW 后台 revalidate;ETag/length 变了就 postMessage,我们弹 toast,用户点刷新才 reload
// (永不自动 reload,可能正在放歌)
const updateToast = $("update-toast");
const btnUpdateReload = $("btn-update-reload");
const btnUpdateDismiss = $("btn-update-dismiss");

function showUpdateToast() {
  updateToast.hidden = false;
}
function hideUpdateToast() {
  updateToast.hidden = true;
}

btnUpdateDismiss?.addEventListener("click", hideUpdateToast);
btnUpdateReload?.addEventListener("click", async () => {
  hideUpdateToast();
  try {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "skip-waiting" });
    }
  } catch (_) {}
  // 持久化位置,reload 之后 resume 接着放
  if (state.currentTrack) persistPosition();
  location.reload();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .then((reg) => log("SW 已注册 scope=", reg.scope))
      .catch((e) => log("SW 注册失败:", e.message));
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "asset-updated") {
      log("SW 报告:", event.data.url, "有新版本");
      showUpdateToast();
    }
  });
}
