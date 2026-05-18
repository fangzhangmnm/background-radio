// IndexedDB LRU 音频缓存。
//
// 两个 store:blobs(trackId → Blob)、meta(trackId → {size, type, name, duration,
//   lastPlayed, pinned, parentFolderId, parentFolderName})。
//
// pinned = true 的 entry:
//   - 永远不会被 LRU 淘汰
//   - 容量不够装下新 blob 时:如果非 pinned 部分腾不出空间 → 静默不写入(不抛、不淘汰 pinned)
//
// 容量默认 250 MB,用户在菜单可改。
// 失效检测:无 —— OneDrive 是 SSOT,缓存按 trackId 索引等同内容寻址;换文件 = 用户长按删手动失效。

const DB_NAME = "br-cache";
const DB_VERSION = 1;
const STORE_BLOBS = "blobs";
const STORE_META = "meta";

const DEFAULT_CAP_BYTES = 250 * 1024 * 1024;
let capBytes = DEFAULT_CAP_BYTES;

export function setCapMB(mb) {
  if (typeof mb !== "number" || !isFinite(mb) || mb < 50) return false;
  capBytes = Math.floor(mb) * 1024 * 1024;
  return true;
}
export function getCapMB() {
  return Math.round(capBytes / 1024 / 1024);
}
export function getCapBytes() {
  return capBytes;
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "trackId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getBlob(trackId) {
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, "readonly");
  return reqAsPromise(tx.objectStore(STORE_BLOBS).get(trackId));
}

export async function getMeta(trackId) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readonly");
  return reqAsPromise(tx.objectStore(STORE_META).get(trackId));
}

export async function isCached(trackId) {
  return !!(await getMeta(trackId));
}

export async function listAllMeta() {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readonly");
  return reqAsPromise(tx.objectStore(STORE_META).getAll());
}

export async function totalBytes() {
  const all = await listAllMeta();
  return all.reduce((acc, m) => acc + (m.size || 0), 0);
}

export async function touch(trackId) {
  const m = await getMeta(trackId);
  if (!m) return;
  m.lastPlayed = Date.now();
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readwrite");
  tx.objectStore(STORE_META).put(m);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function del(trackId) {
  const db = await openDb();
  const tx = db.transaction([STORE_BLOBS, STORE_META], "readwrite");
  tx.objectStore(STORE_BLOBS).delete(trackId);
  tx.objectStore(STORE_META).delete(trackId);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 试着腾够 reserveBytes 的空间。
// 规则:只淘汰非 pinned 的最老 entry。如果连把所有非 pinned 都删了还是不够,返回 false。
async function ensureRoom(reserveBytes) {
  const all = await listAllMeta();
  const pinned = all.filter((m) => m.pinned);
  const evictable = all.filter((m) => !m.pinned);

  const pinnedSize = pinned.reduce((a, m) => a + (m.size || 0), 0);
  // pinned 占的空间 + 这次要写的 > cap → 永远塞不进
  if (pinnedSize + reserveBytes > capBytes) return false;

  evictable.sort((a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0));
  let total = pinnedSize + evictable.reduce((a, m) => a + (m.size || 0), 0);
  for (const m of evictable) {
    if (total + reserveBytes <= capBytes) break;
    await del(m.trackId);
    total -= m.size || 0;
  }
  return true;
}

// 写入 blob;成功返回 true,容量塞不下返回 false(不抛错,调用方静默接受)
export async function set(trackId, blob, extraMeta = {}) {
  if (blob.size > capBytes) {
    return false; // 单首就比 cap 大,直接放弃
  }
  const ok = await ensureRoom(blob.size);
  if (!ok) return false; // pinned 太多,塞不下

  const meta = {
    trackId,
    size: blob.size,
    type: blob.type,
    lastPlayed: Date.now(),
    pinned: false,
    ...extraMeta,
  };
  const db = await openDb();
  const tx = db.transaction([STORE_BLOBS, STORE_META], "readwrite");
  tx.objectStore(STORE_BLOBS).put(blob, trackId);
  tx.objectStore(STORE_META).put(meta);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function setPinned(trackId, pinned) {
  const m = await getMeta(trackId);
  if (!m) return false;
  m.pinned = !!pinned;
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readwrite");
  tx.objectStore(STORE_META).put(m);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction([STORE_BLOBS, STORE_META], "readwrite");
  tx.objectStore(STORE_BLOBS).clear();
  tx.objectStore(STORE_META).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function stats() {
  const all = await listAllMeta();
  const total = all.reduce((acc, m) => acc + (m.size || 0), 0);
  const pinnedCount = all.filter((m) => m.pinned).length;
  const pinnedBytes = all
    .filter((m) => m.pinned)
    .reduce((acc, m) => acc + (m.size || 0), 0);
  return { count: all.length, totalBytes: total, capBytes, pinnedCount, pinnedBytes };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
