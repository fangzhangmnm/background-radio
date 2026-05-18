// IndexedDB LRU 音频缓存。
//
// 两个 store:blobs(trackId → Blob)、meta(trackId → {size, type, name, duration, lastPlayed})。
// Blob 常驻 IndexedDB,**不要长期挂在 JS 变量上**,iOS 会把它算成不可回收内存。
//
// 容量:CAP_BYTES。set() 前 evict 最老的 lastPlayed 直到留够空间。
// 失效检测:无 —— OneDrive 是 SSOT,但缓存按 trackId 索引,等同于内容寻址;
//   要换文件:用户长按删除手动失效。

const DB_NAME = "br-cache";
const DB_VERSION = 1;
const STORE_BLOBS = "blobs";
const STORE_META = "meta";

export const CAP_BYTES = 800 * 1024 * 1024;

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

// 留至少 reserveBytes 字节的空间;淘汰最老的 lastPlayed 直到总占用 ≤ CAP - reserve
async function ensureRoom(reserveBytes) {
  let all = await listAllMeta();
  let total = all.reduce((a, m) => a + (m.size || 0), 0);
  if (total + reserveBytes <= CAP_BYTES) return;

  all.sort((a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0));
  for (const m of all) {
    if (total + reserveBytes <= CAP_BYTES) break;
    await del(m.trackId);
    total -= m.size || 0;
  }
}

export async function set(trackId, blob, extraMeta = {}) {
  if (blob.size > CAP_BYTES) {
    throw new Error(`blob (${blob.size}) 超过 cap (${CAP_BYTES})`);
  }
  await ensureRoom(blob.size);
  const meta = {
    trackId,
    size: blob.size,
    type: blob.type,
    lastPlayed: Date.now(),
    ...extraMeta,
  };
  const db = await openDb();
  const tx = db.transaction([STORE_BLOBS, STORE_META], "readwrite");
  tx.objectStore(STORE_BLOBS).put(blob, trackId);
  tx.objectStore(STORE_META).put(meta);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
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
  return { count: all.length, totalBytes: total, capBytes: CAP_BYTES };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
