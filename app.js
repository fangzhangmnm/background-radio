import {
  initAuth,
  signIn,
  signOut,
  getToken,
  isSignedIn,
  getActiveAccount,
} from "./auth.js";

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
};
let state = structuredClone(defaultState);

// in-memory caches, not persisted
let currentFolderItems = [];   // raw driveItems for browse folder (used by UI)
let trackFolderItems = null;   // raw audio driveItems for current track's parent (used for advance)
let restorePositionOnLoadedMetadata = 0;

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
const playGlyph = $("play-glyph");
const trackNameEl = $("track-name");
const scopeLabelEl = $("scope-label");
const posCurrentEl = $("pos-current");
const posDurationEl = $("pos-duration");
const seekBar = $("seek-bar");
const volumeBar = $("volume-bar");
const folderListEl = $("folder-list");
const loopSelect = $("loop-select");
const logEl = $("log");

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
  return graphGet(`/me/drive/items/${itemId}`);
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
async function renderBrowser() {
  if (!isSignedIn()) {
    folderListEl.innerHTML = '<li class="entry empty">未登录</li>';
    return;
  }
  folderListEl.innerHTML = '<li class="entry empty">加载中…</li>';
  try {
    currentFolderItems = await listFolder(currentBrowseFolderId());
  } catch (e) {
    log("列目录失败:", e.message);
    folderListEl.innerHTML = `<li class="entry empty">列目录失败: ${escapeHtml(e.message)}</li>`;
    return;
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
      li.innerHTML =
        `<span class="icon">♪</span>` +
        `<span class="name">${escapeHtml(row.item.name)}</span>` +
        (dur ? `<span class="meta">${dur}</span>` : "");
      if (state.currentTrack && state.currentTrack.id === row.item.id) {
        li.classList.add("active");
      }
      li.addEventListener("click", () => playTrack(row.item));
    }
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
  playGlyph.textContent = audio.paused ? "▶" : "❚❚";
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

  trackNameEl.textContent = driveItem.name;
  scopeLabelEl.textContent = driveItem.parentReference?.path
    ? driveItem.parentReference.path.replace(/^.*?approot:/, "") || "/"
    : "";

  // Highlight in current folder list if visible
  for (const el of folderListEl.querySelectorAll(".entry.active")) {
    el.classList.remove("active");
  }
  // Try to find row by name (id not stored on DOM here)
  for (const li of folderListEl.querySelectorAll(".entry")) {
    if (li.querySelector(".name")?.textContent === driveItem.name) {
      li.classList.add("active");
    }
  }

  // Refresh track-folder listing for advance logic
  if (state.currentTrack.parentFolderId) {
    try {
      const siblings = await listFolder(state.currentTrack.parentFolderId);
      trackFolderItems = siblings.filter(isAudio);
    } catch (e) {
      log("加载同级文件失败:", e.message);
      trackFolderItems = null;
    }
  }

  // Set src with downloadUrl, prepare to restore position
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
    audio.src = dl;
    restorePositionOnLoadedMetadata = wasPosition;
    await audio.play();
  } catch (e) {
    log("refetch 失败:", e.message);
  }
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
    title: state.currentTrack.name,
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
audio.addEventListener("timeupdate", updateSeekDisplay);
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
  // 最可能是 downloadUrl 过期
  refetchDownloadUrlAndResume();
});

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
      // resume after reload: rebuild src from currentTrack
      try {
        const fresh = await fetchItem(state.currentTrack.id);
        audio.src = fresh["@microsoft.graph.downloadUrl"];
        restorePositionOnLoadedMetadata =
          state.positions[state.currentTrack.id] ?? state.position ?? 0;
        // 同时刷新一下 trackFolderItems,否则锁屏按 next 没目标
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
  loopSelect.value = state.mode;
  // prev/next 任何模式都显示;Media Session handler 也总在
  updateMediaSessionHandlers();
}

loopSelect.addEventListener("change", () => {
  state.mode = loopSelect.value;
  saveState();
  applyModeUi();
  log(`loop mode → ${state.mode}`);
});

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

// === Init ===
async function restoreSession() {
  if (!state.currentTrack) return;
  trackNameEl.textContent = state.currentTrack.name;
  scopeLabelEl.textContent = `恢复中:position=${formatTime(state.position)}`;
  posCurrentEl.textContent = formatTime(state.position);
  // Don't auto-set audio.src yet — iOS PWA can't autoplay without gesture anyway.
  // 点击 play 按钮再装载 src。
  log("恢复:", state.currentTrack.name, "@", formatTime(state.position));
}

async function main() {
  loadState();
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
