var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../../20260813 internal-store/src/substrate.ts
async function toU8(x) {
  if (x == null) return new Uint8Array(0);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (typeof x === "string") return new TextEncoder().encode(x);
  if (typeof x.arrayBuffer === "function") return new Uint8Array(await x.arrayBuffer());
  throw new Error("Store: \u65E0\u6CD5\u8BC6\u522B\u7684 bytes \u7C7B\u578B");
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function createSubstrate() {
  let _editVersion = 0;
  let _savedVersion = 0;
  const edits = {
    mark: () => {
      _editVersion++;
    },
    version: () => _editVersion,
    markSaved: (v) => {
      _savedVersion = v == null ? _editVersion : v;
    },
    localDirty: () => _editVersion !== _savedVersion
  };
  const _chain = /* @__PURE__ */ new Map();
  function serialize(name, fn) {
    const prev = _chain.get(name) || Promise.resolve();
    const next = prev.then(fn, fn);
    _chain.set(name, next.then(() => {
    }, () => {
    }));
    return next;
  }
  function serialize2(a, b, fn) {
    const prev = Promise.all([_chain.get(a) || Promise.resolve(), _chain.get(b) || Promise.resolve()]);
    const next = prev.then(fn, fn);
    const tail = next.then(() => {
    }, () => {
    });
    _chain.set(a, tail);
    _chain.set(b, tail);
    return next;
  }
  function createCoalescer() {
    let pending = null;
    let inFlight = null;
    let startVer = 0;
    let doLocal = async () => {
    }, doPush = async () => {
    };
    function configure(fns = {}) {
      if (fns.doLocal) doLocal = fns.doLocal;
      if (fns.doPush) doPush = fns.doPush;
    }
    async function _run(type) {
      inFlight = type;
      startVer = _editVersion;
      try {
        if (type === "push") await doPush();
        else await doLocal();
      } finally {
        inFlight = null;
        if (pending) {
          const next = pending;
          pending = null;
          _run(next);
        }
      }
    }
    function request(type) {
      if (!inFlight) {
        _run(type);
        return;
      }
      const hasNewEdits = _editVersion !== startVer;
      const shouldQueue = inFlight === "local" && type === "push" ? true : hasNewEdits;
      if (!shouldQueue) return;
      if (type === "push" || pending !== "push") pending = type;
    }
    return { configure, request, state: () => ({ pending, inFlight, startVer }) };
  }
  const session = createCoalescer();
  return { edits, session, serialize, serialize2 };
}

// ../../20260813 internal-store/src/local-head.ts
var BypassError = class extends Error {
  code = "BYPASS";
  constructor(name) {
    super(`local-head: "${name}" dirty \u4F46\u7F3A parentBase\uFF08\u7F16\u8F91\u6CA1\u8D70 recordEdit \u6B63\u95E8\uFF0C\u62D2\u7EDD\u53EF\u80FD\u9759\u9ED8\u8986\u76D6\u7684\u63A8\u9001\uFF09`);
    this.name = "BypassError";
  }
};
function createLocalHead({ kv, getCloudEtag, setCloudEtag, keyPrefix = "head" }) {
  const _base = /* @__PURE__ */ new Map();
  const _parent = /* @__PURE__ */ new Map();
  const _dirtyMem = /* @__PURE__ */ new Map();
  const dirtyKey = (n) => `${keyPrefix}.dirty:${n}`;
  function isDirty2(name) {
    if (_dirtyMem.has(name)) return _dirtyMem.get(name);
    return kv.get(dirtyKey(name)) === "1";
  }
  function isDirtyAnywhere(name) {
    return kv.get(dirtyKey(name)) === "1" || isDirty2(name);
  }
  function _setDirty(name, d) {
    _dirtyMem.set(name, d);
    if (d) kv.set(dirtyKey(name), "1");
    else kv.remove(dirtyKey(name));
  }
  function seenBase(name) {
    return _base.has(name) ? _base.get(name) : getCloudEtag(name);
  }
  function ifMatchFor(name) {
    if (isDirty2(name)) {
      if (_parent.has(name)) return _parent.get(name);
      const b = _base.has(name) ? _base.get(name) : null;
      if (b != null) throw new BypassError(name);
      return null;
    }
    return _parent.has(name) ? _parent.get(name) : seenBase(name);
  }
  function recordEdit(name) {
    if (!isDirty2(name)) {
      _parent.set(name, _base.has(name) ? _base.get(name) : null);
    }
    _setDirty(name, true);
  }
  function markSeen(name, etag) {
    _base.set(name, etag);
    if (isDirty2(name) && !_parent.has(name)) _parent.set(name, etag);
  }
  function markSynced(name, etag) {
    _base.set(name, etag);
    _setDirty(name, false);
    _parent.delete(name);
    setCloudEtag?.(name, etag);
  }
  function onPushed(name, newEtag, dirtyAfter) {
    if (newEtag == null && !dirtyAfter) {
      throw new Error(`local-head: "${name}" onPushed(null etag, dirtyAfter=false) \u2014\u2014 \u843D\u5730\u672A\u786E\u8BA4\u4E0D\u5F97\u6E05 dirty`);
    }
    if (newEtag != null) _base.set(name, newEtag);
    if (dirtyAfter) {
      _setDirty(name, true);
      _parent.set(name, newEtag ?? null);
    } else {
      _setDirty(name, false);
      _parent.delete(name);
    }
  }
  function forget(name) {
    _base.delete(name);
    _parent.delete(name);
    _dirtyMem.delete(name);
    kv.remove(dirtyKey(name));
    setCloudEtag?.(name, null);
  }
  return { ifMatchFor, seenBase, isDirty: isDirty2, isDirtyAnywhere, recordEdit, markSeen, markSynced, onPushed, forget };
}

// ../../20260813 internal-store/src/error-handling.ts
var reporter = null;
function setStoreErrorReporter(fn) {
  reporter = fn;
}
function reportStoreError(err, level = "error") {
  reporter?.(err, level);
}

// ../../20260813 internal-store/src/seal.ts
var LockedError = class extends Error {
  code = "LOCKED";
  constructor(name) {
    super(`\u300C${name}\u300D\u5DF2\u52A0\u5BC6\u4E14\u672A\u89E3\u9501\uFF08\u9700\u8981\u5BC6\u7801\uFF09`);
    this.name = "LockedError";
  }
};
function createSeal(cfg) {
  const { looksContainer, pack, unpack, getPassword, getPrev, makePeek, ext } = cfg;
  function isContainer(bytes) {
    return looksContainer(bytes);
  }
  async function withPassword(name, attempt) {
    const pw = getPassword(name);
    if (!pw) return null;
    try {
      return await attempt(pw);
    } catch (e) {
      if (e?.code === "WRONG_PASSWORD") return null;
      throw e;
    }
  }
  async function sealForWrite(name, plain) {
    if (await looksContainer(plain)) return plain;
    const prev = await getPrev(name);
    if (!prev || !await looksContainer(prev)) return plain;
    const pw = getPassword(name);
    if (!pw) throw new LockedError(name);
    let peek = null;
    if (makePeek) {
      try {
        peek = await makePeek(new Blob([plain]));
      } catch (e) {
        reportStoreError(e, "log");
        peek = null;
      }
    }
    const container = await pack({ dataBytes: plain, fileName: name, ext, peek, password: pw });
    return await toU8(container);
  }
  async function unsealForRead(name, bytes) {
    if (!await looksContainer(bytes)) return bytes;
    const res = await withPassword(name, (pw) => unpack(bytes, pw));
    return res ? res.dataBlob : null;
  }
  return { isContainer, sealForWrite, unsealForRead, withPassword };
}

// ../../20260813 internal-store/src/crypto-container.ts
var _codec = null;
function configureCryptoCodec(c) {
  _codec = c;
}
function codec() {
  if (!_codec) throw new Error("\u52A0\u5BC6\u672A\u914D\u7F6E\uFF1AcreateStore config \u672A\u63D0\u4F9B crypto codec(zip/7z)");
  return _codec;
}
var SEVENZ_MAGIC = [55, 122, 188, 175, 39, 28];
var ZIP_MAGIC = [80, 75, 3, 4];
function _startsWith(u8, sig) {
  if (u8.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (u8[i] !== sig[i]) return false;
  return true;
}
var PEEK_MAGIC = [158, 87, 80, 84, 72, 13, 10, 26];
var PEEK_VER = 1;
var PEEK_HEADER_LEN = 8 + 1 + 16 + 12 + 4;
var PEEK_MAX_LEN = 8 * 1024 * 1024;
var PBKDF2_ITERS = 25e4;
var PEEK_TAIL_WINDOW = 98304;
var ENC_PEEK_MIME = "application/x-sync-store-enc-peek";
var CONTAINER_PEEK_ENTRY = "peek";
var CONTAINER_PEEK_ENTRIES = [CONTAINER_PEEK_ENTRY];
var META_MAGIC = "WPMETA1\n";
function makeGuid() {
  return globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 3 | 8).toString(16);
  });
}
var _keyCache = /* @__PURE__ */ new Map();
function _hex(u8) {
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function _deriveKey(password, salt) {
  const cacheKey = `${password}\0${_hex(salt)}`;
  const hit = _keyCache.get(cacheKey);
  if (hit) return hit;
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERS },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  _keyCache.set(cacheKey, key);
  return key;
}
async function encryptPeek(bytes, password) {
  const plain = bytes && bytes.length ? bytes : new Uint8Array(0);
  const salt = new Uint8Array(16), iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);
  const key = await _deriveKey(password, salt);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(PEEK_HEADER_LEN + ct.length);
  out.set(PEEK_MAGIC, 0);
  out[8] = PEEK_VER;
  out.set(salt, 9);
  out.set(iv, 25);
  new DataView(out.buffer).setUint32(37, ct.length, true);
  out.set(ct, PEEK_HEADER_LEN);
  return out;
}
function scanEncPeekFromEnd(u8) {
  const n = u8.length;
  outer: for (let i = n - PEEK_HEADER_LEN; i >= 0; i--) {
    for (let k = 0; k < 8; k++) if (u8[i + k] !== PEEK_MAGIC[k]) continue outer;
    const ver = u8[i + 8];
    if (ver !== PEEK_VER) continue;
    const len = new DataView(u8.buffer, u8.byteOffset + i + 37, 4).getUint32(0, true);
    if (len < 16 || len > PEEK_MAX_LEN || i + PEEK_HEADER_LEN + len > n) continue;
    return {
      start: i,
      end: i + PEEK_HEADER_LEN + len,
      ver,
      salt: u8.slice(i + 9, i + 25),
      iv: u8.slice(i + 25, i + 37),
      ct: u8.slice(i + PEEK_HEADER_LEN, i + PEEK_HEADER_LEN + len)
    };
  }
  return null;
}
async function decryptPeek(parsed, password) {
  const key = await _deriveKey(password, parsed.salt);
  try {
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: parsed.iv }, key, parsed.ct));
  } catch (e) {
    const err = new Error("\u5BC6\u7801\u4E0D\u5BF9");
    err.code = "WRONG_PASSWORD";
    throw err;
  }
}
async function _tailBytes(blobOrBytes, window2 = PEEK_TAIL_WINDOW) {
  if (blobOrBytes instanceof Uint8Array) {
    return blobOrBytes.length <= window2 ? blobOrBytes : blobOrBytes.slice(blobOrBytes.length - window2);
  }
  const blob = blobOrBytes.slice(Math.max(0, blobOrBytes.size - window2));
  return new Uint8Array(await blob.arrayBuffer());
}
async function looksEncryptedContainer(blobOrBytes) {
  try {
    const head = blobOrBytes instanceof Uint8Array ? blobOrBytes.slice(0, 6) : new Uint8Array(await blobOrBytes.slice(0, 6).arrayBuffer());
    if (_startsWith(head, SEVENZ_MAGIC)) return true;
    return scanEncPeekFromEnd(await _tailBytes(blobOrBytes)) != null;
  } catch (e) {
    reportStoreError(e, "log");
    return false;
  }
}
async function packContainer({ dataBytes, fileName, ext = "bin", guid: guid2, peek = null, password }) {
  if (!password) throw new Error("\u6CA1\u6709\u5BC6\u7801\uFF0C\u65E0\u6CD5\u52A0\u5BC6");
  const metaJson = JSON.stringify({ v: 1, name: fileName || null, ext });
  const payloadBytes = await codec().pack7z([
    { path: "data.bin", data: dataBytes },
    { path: "meta.bin", data: META_MAGIC + metaJson }
  ], password);
  const peekEnc = await encryptPeek(peek, password);
  return await codec().zipPack([
    { path: guid2 || makeGuid(), data: payloadBytes },
    { path: CONTAINER_PEEK_ENTRY, data: peekEnc }
  ]);
}
function _pickData(inner) {
  if (inner["data.bin"]) return inner["data.bin"];
  const names = Object.keys(inner).filter((n) => n !== "meta.bin");
  return names.length ? inner[names[0]] : null;
}
function _readMeta(inner) {
  if (!inner["meta.bin"]) return null;
  try {
    const text = new TextDecoder().decode(inner["meta.bin"]);
    if (text.startsWith(META_MAGIC)) return JSON.parse(text.slice(META_MAGIC.length));
  } catch (e) {
    reportStoreError(e, "log");
  }
  return null;
}
async function unpackContainer(blob, password) {
  const whole = blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());
  let payload = null, guid2 = "";
  if (_startsWith(whole, ZIP_MAGIC)) {
    try {
      const outer = await codec().zipUnpack(blob instanceof Blob ? blob : new Blob([whole]));
      const g = Object.keys(outer).find((n) => !CONTAINER_PEEK_ENTRIES.includes(n));
      if (g && outer[g] && (_startsWith(outer[g], SEVENZ_MAGIC) || _startsWith(outer[g], ZIP_MAGIC))) {
        payload = outer[g];
        guid2 = g;
      }
    } catch (e) {
      reportStoreError(e, "log");
    }
  }
  const inner = await codec().unpack7z(payload ?? whole, password);
  const data = _pickData(inner);
  if (!data) throw new Error("\u52A0\u5BC6\u6587\u4EF6\u91CC\u6CA1\u6709\u53EF\u8BFB\u5185\u5BB9");
  return { dataBlob: new Blob([data], { type: "application/zip" }), meta: _readMeta(inner), guid: guid2 };
}

// ../../20260813 internal-store/src/safe-resolve.ts
function createSafeResolve(cfg) {
  const {
    cloud,
    local,
    head,
    localDirty = () => false,
    validateAdopt,
    unseal = (_n, blob) => Promise.resolve(blob),
    onReplacing = () => {
    },
    looksEncrypted = () => Promise.resolve(false)
  } = cfg;
  async function safePull(name, { adopt } = {}) {
    onReplacing(true);
    try {
      let backupName;
      if (head.isDirty(name) || localDirty()) {
        try {
          backupName = await local.backup(name);
        } catch (e) {
          reportStoreError(e, "warning");
          return { ok: false, reason: "backup-failed", error: e };
        }
      }
      const r = await cloud.pull(name);
      if (!r) return { ok: false, reason: "cloud-vanished", backupName };
      const plain = await unseal(name, r.blob);
      const ok = plain != null ? await validateAdopt(plain) : await looksEncrypted(r.blob);
      if (!ok) return { ok: false, reason: "invalid-cloud-bytes", backupName };
      await local.save(name, r.blob);
      head.markSynced(name, r.item?.eTag ?? null);
      if (adopt && plain != null) await adopt(plain, name);
      return { ok: true, backupName };
    } finally {
      onReplacing(false);
    }
  }
  async function tryHeal(name, bytes) {
    let pulled;
    try {
      pulled = await cloud.pull(name);
    } catch (e) {
      reportStoreError(e, "log");
      return false;
    }
    if (!pulled) return false;
    if (bytesEqual(await toU8(pulled.blob), bytes)) {
      head.markSynced(name, pulled.item?.eTag ?? null);
      return true;
    }
    return false;
  }
  async function weakOverride(name, bytes) {
    const r = await cloud.weakOverride(name, bytes, { encrypted: await looksEncrypted(bytes) });
    head.markSynced(name, r.item?.eTag ?? null);
    return { backedUp: r.backedUp };
  }
  async function resolveConflict(name, choice, ctx = {}) {
    if (choice === "takeCloud") {
      const r = await safePull(name, { adopt: ctx.adopt });
      return r.ok ? { status: "resolved", resolution: "takeCloud", backupName: r.backupName } : { status: "unresolved", reason: r.reason, backupName: r.backupName };
    }
    if (choice === "keepMine" && ctx.bytes != null) {
      const r = await weakOverride(name, ctx.bytes);
      return { status: "resolved", resolution: "keepMine", backedUp: r.backedUp };
    }
    return { status: "cancelled" };
  }
  return { safePull, tryHeal, weakOverride, resolveConflict };
}

// ../../20260813 internal-store/src/push.ts
var passBusy = (_l, fn) => fn();
var isConflict = (e) => !!e && (e.name === "CloudConflictError" || e.status === 412);
function retriable(e) {
  const x = e;
  const s = x?.status;
  return (s == null || s === 429 || s >= 500 && s <= 599) && x?.name !== "CloudConflictError" && x?.name !== "CloudNameCollisionError";
}
function createPush(cfg) {
  const {
    cloud,
    head,
    seal,
    safeResolve,
    serialize,
    editVersion,
    busy = passBusy,
    maxAttempts = 4,
    backoffMs = 200,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = cfg;
  async function doPush(name, { encode: encode2, getEditVersion = editVersion, onConflict, adopt, surfaceCollision = false }) {
    const ifMatch = head.ifMatchFor(name);
    const v0 = getEditVersion();
    const bytes = await seal.sealForWrite(name, await toU8(await encode2()));
    const isEnc = await seal.isContainer(bytes);
    return busy("\u6B63\u5728\u540C\u6B65\u2026", async () => {
      let attempt = 0, lastErr;
      while (attempt < maxAttempts) {
        attempt++;
        try {
          const { item } = await cloud.push(name, bytes, { baseEtag: ifMatch, encrypted: isEnc });
          if (!(item && item.eTag)) return { status: "deferred", dirtyAfter: true };
          const dirtyAfter = getEditVersion() !== v0;
          head.onPushed(name, item.eTag, dirtyAfter);
          return { status: "pushed", dirtyAfter };
        } catch (e) {
          if (isConflict(e)) {
            if (await safeResolve.tryHeal(name, bytes)) {
              const dirtyAfter = getEditVersion() !== v0;
              if (dirtyAfter) head.recordEdit(name);
              return { status: "healed", dirtyAfter };
            }
            const choice = onConflict ? await onConflict({ name }) : "cancel";
            return await safeResolve.resolveConflict(name, choice, { bytes, adopt });
          }
          if (surfaceCollision && e?.name === "CloudNameCollisionError") {
            const choice = onConflict ? await onConflict({ name }) : "cancel";
            return await safeResolve.resolveConflict(name, choice, { bytes, adopt });
          }
          if (retriable(e) && attempt < maxAttempts) {
            lastErr = e;
            await sleep(backoffMs * attempt);
            continue;
          }
          throw e;
        }
      }
      throw lastErr;
    });
  }
  function push(name, opts) {
    return serialize(name, () => doPush(name, opts));
  }
  return { push, doPush };
}

// ../../20260813 internal-store/src/freshness.ts
var passBusy2 = (_l, fn) => fn();
function createFreshness(cfg) {
  const { cloud, head, safeResolve, busy: _busy = passBusy2 } = cfg;
  async function open(name, opts = {}) {
    const { isOnline = () => true, probe, onNewer, adopt, localDirty, busy = passBusy2 } = opts;
    if (!isOnline()) return { source: "local", reason: "offline" };
    return busy("\u68C0\u67E5\u4E91\u7AEF\u2026", async () => {
      let meta;
      if (probe) {
        const raced = await Promise.race([
          cloud.fetchMeta(name).then((m) => ({ k: "meta", m }), (e) => ({ k: "err", e })),
          Promise.resolve(probe).then(() => ({ k: "skip" }))
        ]);
        if (raced.k === "skip") return { source: "local", reason: "skipped" };
        if (raced.k === "err") return { source: "local", reason: "cloud-error" };
        meta = raced.m;
      } else {
        try {
          meta = await cloud.fetchMeta(name);
        } catch (e) {
          reportStoreError(e, "log");
          return { source: "local", reason: "cloud-error" };
        }
      }
      if (!meta) return { source: "local", reason: "cloud-absent" };
      const base = head.seenBase(name);
      if (!base || meta.etag === base) {
        if (base != null) head.markSeen(name, meta.etag);
        return { source: "local", reason: "in-sync" };
      }
      const dirty = head.isDirty(name) || (localDirty ? localDirty() : false);
      if (!dirty) {
        const r = await safeResolve.safePull(name, { adopt });
        return r.ok ? { source: "fast-forwarded", backupName: r.backupName } : { source: "local", reason: r.reason, error: r.error };
      }
      const choice = onNewer ? await onNewer({ name, cloudEtag: meta.etag, baseEtag: base, cloudTime: meta.lastModified }) : "cancel";
      if (choice === "takeCloud") {
        const r = await safeResolve.safePull(name, { adopt });
        return r.ok ? { source: "pulled", backupName: r.backupName } : { source: "local", reason: r.reason, backupName: r.backupName, error: r.error };
      }
      return { source: "local", reason: "kept" };
    });
  }
  async function refresh(name, opts = {}) {
    const { isOnline = () => true, adopt, localDirty, onReplaceStart, busy = passBusy2 } = opts;
    if (!isOnline()) return { status: "offline" };
    if (head.isDirty(name) || localDirty && localDirty()) return { status: "dirty-skip" };
    return busy("\u68C0\u67E5\u4E91\u7AEF\u2026", async () => {
      let meta;
      try {
        meta = await cloud.fetchMeta(name);
      } catch (e) {
        reportStoreError(e, "log");
        return { status: "cloud-error" };
      }
      if (!meta) return { status: "cloud-absent" };
      const base = head.seenBase(name);
      if (!base || meta.etag === base) return { status: "in-sync" };
      if (head.isDirty(name) || localDirty && localDirty()) return { status: "dirty-skip" };
      if (onReplaceStart) onReplaceStart();
      const r = await safeResolve.safePull(name, { adopt });
      return r.ok ? { status: "fast-forwarded" } : { status: "ff-failed", reason: r.reason };
    });
  }
  return { open, refresh };
}

// ../../20260813 internal-store/src/move-aside.ts
function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}
function yyyymmddhhmmss(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function guid() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  const a = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
  a[6] = a[6] & 15 | 64;
  a[8] = a[8] & 63 | 128;
  const h = Array.from(a, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}
function asideStamp(ms) {
  return `${yyyymmddhhmmss(ms)}-${guid()}`;
}

// ../../20260813 internal-store/src/delete.ts
var passBusy3 = (_l, fn) => fn();
var DELQ_KEY = "internal.pending_deletions";
function createDelete(cfg) {
  const { cloud, local, head, kv, busy: _busy = passBusy3 } = cfg;
  function readQueue() {
    try {
      const raw = kv.get(DELQ_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      reportStoreError(e, "log");
      return [];
    }
  }
  function writeQueue(q) {
    if (q.length) kv.set(DELQ_KEY, JSON.stringify(q));
    else kv.remove(DELQ_KEY);
  }
  function enqueue(name, baseEtag, deleteEventId) {
    const q = readQueue().filter((e) => e.name !== name);
    q.push({ name, baseEtag, deleteEventId });
    writeQueue(q);
  }
  async function del(name, opts = {}) {
    const { isOnline = () => true, confirm, onDirtyWarn, busy = _busy } = opts;
    if (confirm && !await confirm({ title: "\u5220\u9664", body: name, danger: true })) return { status: "cancelled" };
    if (head.isDirty(name) && onDirtyWarn && !await onDirtyWarn({ name })) return { status: "cancelled" };
    const localPresent = local ? await local.exists(name) : false;
    const deleteEventId = asideStamp(Date.now());
    if (!isOnline()) {
      const baseEtag = cloud.getETag(name);
      let trashKey = null;
      if (localPresent) trashKey = await local.trash(name, deleteEventId);
      const queuedCloudDelete = baseEtag != null;
      if (queuedCloudDelete) enqueue(name, baseEtag, deleteEventId);
      head.forget(name);
      return { status: "trashed", where: "local", queuedCloudDelete, baseEtag, trashKey };
    }
    return busy("\u5220\u9664\u4E2D\u2026", async () => {
      let cloudPresent = false;
      try {
        cloudPresent = !!await cloud.fetchMeta(name);
      } catch (e) {
        reportStoreError(e, "log");
        cloudPresent = false;
      }
      if (cloudPresent) {
        const wasDirty = head.isDirty(name);
        const trashed = await cloud.trash(name, deleteEventId);
        if (localPresent) {
          if (wasDirty) {
            head.forget(name);
            const trashKey = await local.trash(name, deleteEventId);
            return { status: "trashed", where: "both", trashed, trashKey };
          }
          await local.hardDelete(name);
        }
        head.forget(name);
        return { status: "trashed", where: "cloud", trashed };
      }
      if (localPresent) {
        const trashKey = await local.trash(name, deleteEventId);
        head.forget(name);
        return { status: "trashed", where: "local", trashKey };
      }
      return { status: "noop" };
    });
  }
  async function replayDelete(name, opts = {}) {
    const { baseEtag } = opts;
    const deleteEventId = opts.deleteEventId ?? asideStamp(Date.now());
    let meta;
    try {
      meta = await cloud.fetchMeta(name);
    } catch (e) {
      reportStoreError(e, "log");
      return { status: "deferred-offline" };
    }
    if (!meta) return { status: "converged", reason: "already-gone" };
    if (!baseEtag) return { status: "skipped-no-base" };
    if (meta.etag !== baseEtag) return { status: "conflict-edit-wins" };
    try {
      return { status: "trashed", trashed: await cloud.trash(name, deleteEventId, { baseEtag }) };
    } catch (e) {
      if (e?.status === 412) return { status: "conflict-edit-wins" };
      throw e;
    }
  }
  async function drainDeleteQueue() {
    const q = readQueue();
    if (!q.length) return { status: "drained", drained: 0, deferred: 0 };
    const remain = [];
    let drained = 0;
    for (const e of q) {
      let r;
      try {
        r = await replayDelete(e.name, { baseEtag: e.baseEtag, deleteEventId: e.deleteEventId });
      } catch (err) {
        reportStoreError(err, "log");
        remain.push(e);
        continue;
      }
      if (r.status === "deferred-offline") remain.push(e);
      else drained++;
    }
    writeQueue(remain);
    return { status: "drained", drained, deferred: remain.length };
  }
  return { del, replayDelete, drainDeleteQueue };
}

// ../../20260813 internal-store/src/is-hidden.ts
function isHidden(name) {
  if (!name) return false;
  const seg = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return seg.startsWith(".");
}
function assertValidFileName(name, appId) {
  if (!name || !name.trim()) throw new Error("\u8DEF\u5F84\u4E0D\u80FD\u4E3A\u7A7A");
  const top = name.indexOf("/") >= 0 ? name.slice(0, name.indexOf("/")) : name;
  if (top === ".trash" || top === ".backup" || top === `.${appId}`) {
    throw new Error(`\u4FDD\u7559\u6839\uFF0C\u7981\u6B62\u7528\u4F5C\u6587\u4EF6/\u6587\u4EF6\u5939\u8DEF\u5F84\uFF1A${top}/\uFF08.trash/.backup/.${appId} \u5F52 store \u5B89\u5168\u7F51\u4E0E collections\uFF09`);
  }
}
function assertValidCollectionName(name) {
  if (!name || /[\\/:*?"<>|]/.test(name) || name === "." || name === "..") {
    throw new Error(`collection \u540D\u975E\u6CD5\uFF08\u987B\u5408\u6CD5\u6587\u4EF6\u540D\u3001\u65E0\u659C\u6760/\u65E0 Windows \u975E\u6CD5\u5B57\u7B26\u3001\u975E bare .|..\uFF1B\u70B9\u5206\u5C42\u7EA7\u653E\u884C\uFF09\uFF1A${JSON.stringify(name)}`);
  }
}

// ../../20260813 internal-store/src/cloud-sync.ts
var CloudConflictError = class extends Error {
  sessionName;
  constructor(message, sessionName) {
    super(message);
    this.name = "CloudConflictError";
    this.sessionName = sessionName;
  }
};
var CloudNameCollisionError = class extends Error {
  sessionName;
  where;
  constructor(sessionName, where = "cloud") {
    super(where === "local" ? `\u672C\u5730\u5DF2\u6709\u540C\u540D\u300C${sessionName}\u300D\uFF08\u4E0D\u540C\u6587\u4EF6\uFF09` : `\u4E91\u7AEF\u5DF2\u6709\u540C\u540D\u300C${sessionName}\u300D\uFF08\u4E0D\u540C\u6587\u4EF6\uFF09`);
    this.name = "CloudNameCollisionError";
    this.sessionName = sessionName;
    this.where = where;
  }
};
function createCloudSync(cfg) {
  const {
    provider: provider2,
    kv,
    fileName,
    encFileName = null,
    contentType = "application/octet-stream",
    trashFolder = ".trash",
    backupFolder = ".backup",
    appKey = "sync",
    manageDirty = true
  } = cfg;
  const now = cfg.now || (() => Date.now());
  async function _find(name) {
    const p = fileName(name);
    let item = await provider2.getItemByPath(p);
    if (item) return { item, path: p, enc: false };
    if (encFileName) {
      const pe = encFileName(name);
      item = await provider2.getItemByPath(pe);
      if (item) return { item, path: pe, enc: true };
    }
    return { item: null, path: p, enc: false };
  }
  const match = cfg.match || ((it) => !it.isFolder);
  const toName = cfg.toName || ((name) => name.endsWith(".zip") ? name.slice(0, -4) : name);
  const etagKey = (n) => `${appKey}.etag:${n}`;
  const dirtyKey = (n) => `${appKey}.dirty:${n}`;
  const baseName = (n) => n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n;
  const stampedName = (n, enc = false, stamp2 = asideStamp(now())) => (enc && encFileName ? encFileName : fileName)(`${baseName(n)} [${stamp2}]`);
  function getETag(name) {
    return kv.get(etagKey(name)) || null;
  }
  function setETag(name, eTag) {
    if (eTag) kv.set(etagKey(name), eTag);
    else kv.remove(etagKey(name));
  }
  const _dirtyMem = /* @__PURE__ */ new Map();
  function isDirty2(name) {
    if (!manageDirty) return false;
    if (_dirtyMem.has(name)) return _dirtyMem.get(name);
    const v = kv.get(dirtyKey(name));
    return v === null ? true : v === "1";
  }
  function setDirty(name, dirty) {
    if (!manageDirty) return;
    _dirtyMem.set(name, dirty);
    kv.set(dirtyKey(name), dirty ? "1" : "0");
  }
  function clearState(name) {
    _dirtyMem.delete(name);
    kv.remove(etagKey(name));
    if (manageDirty) kv.remove(dirtyKey(name));
  }
  const _ADOPT_TAIL_N = 8192;
  function _bytesEq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  async function _localTail(b, size, n) {
    const start = Math.max(0, size - n);
    if (b instanceof Blob) return new Uint8Array(await b.slice(start, size).arrayBuffer());
    return b.slice(start, size);
  }
  async function _confirmOurUpload(fresh, localBytes, size) {
    if (size <= 0) return "differ";
    try {
      const n = Math.min(_ADOPT_TAIL_N, size);
      const offset = Math.max(0, (fresh.size || size) - n);
      const raw = await provider2.downloadRange(fresh.id, offset, n);
      const cloudTail = raw instanceof Uint8Array ? raw : raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : new Uint8Array(raw);
      return _bytesEq(await _localTail(localBytes, size, n), cloudTail) ? "match" : "differ";
    } catch (e) {
      reportStoreError(e, "log");
      return "unknown";
    }
  }
  async function push(name, bytes, opts = {}) {
    const enc = !!(encFileName && opts.encrypted);
    const path = enc ? encFileName(name) : fileName(name);
    let baseEtag = "baseEtag" in opts ? opts.baseEtag : getETag(name);
    if (encFileName && baseEtag) {
      const otherPath = enc ? fileName(name) : encFileName(name);
      const target = await provider2.getItemByPath(path).catch((e) => {
        reportStoreError(e, "log");
        return null;
      });
      if (!target) {
        const other = await provider2.getItemByPath(otherPath).catch((e) => {
          reportStoreError(e, "log");
          return null;
        });
        if (other) {
          if (other.eTag !== baseEtag) throw new CloudConflictError(`\u4E91\u7AEF\u5DF2\u6709\u66F4\u65B0\u7248\u672C "${name}"`, name);
          const newBase = baseName(path);
          const renamed = await provider2.rename(other.id, newBase, baseEtag);
          baseEtag = renamed.eTag;
        }
      }
    }
    const wrote = bytes && (bytes.byteLength ?? bytes.size ?? bytes.length) || 0;
    let item = null;
    try {
      item = await provider2.upload(path, bytes, { contentType, eTag: baseEtag, conflictBehavior: baseEtag ? "replace" : "fail" });
    } catch (e) {
      const status = e?.status;
      if (status === 412) throw new CloudConflictError(`\u4E91\u7AEF\u5DF2\u6709\u66F4\u65B0\u7248\u672C "${name}"`, name);
      if (!(status === 409 && !baseEtag)) throw e;
    }
    if (!item || !item.eTag) {
      const fresh = await provider2.getItemByPath(path).catch((e) => {
        reportStoreError(e, "log");
        return null;
      });
      const verdict = fresh && fresh.eTag && fresh.size === wrote ? await _confirmOurUpload(fresh, bytes, wrote) : null;
      if (verdict === "match") item = fresh;
      else if (!baseEtag && fresh && fresh.size > 0 && verdict !== "unknown") {
        throw new CloudNameCollisionError(name);
      } else {
        item = null;
      }
    }
    if (item && item.eTag) {
      setETag(name, item.eTag);
      setDirty(name, false);
    }
    return { item };
  }
  async function pull(name) {
    const { item } = await _find(name);
    if (!item) return null;
    const blob = await provider2.download(item.id);
    return { blob, item, suggestedName: name };
  }
  async function fetchMeta(name) {
    const { item } = await _find(name);
    if (!item) return null;
    return { etag: item.eTag, lastModified: item.lastModifiedDateTime, size: item.size, item };
  }
  async function pullTail(name, n) {
    const { item } = await _find(name);
    if (!item) return null;
    const offset = Math.max(0, (item.size || 0) - n);
    const raw = await provider2.downloadRange(item.id, offset, Math.min(n, item.size || n));
    const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(await raw.arrayBuffer());
    return { bytes, item };
  }
  async function pullRange(name, offset, length) {
    const { item } = await _find(name);
    if (!item) return null;
    const size = item.size || 0;
    const off = Math.max(0, Math.min(offset, size));
    const len = Math.max(0, Math.min(length, size - off));
    if (len === 0) return { bytes: new Uint8Array(0), item };
    const raw = await provider2.downloadRange(item.id, off, len);
    const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(await raw.arrayBuffer());
    return { bytes, item };
  }
  async function trash(name, deleteEventId, opts = {}) {
    const { item, enc } = await _find(name);
    if (!item) {
      clearState(name);
      return null;
    }
    const folderId = await provider2.ensureFolder(trashFolder);
    const stamped = stampedName(name, enc, deleteEventId);
    const moved = await provider2.move(item.id, folderId, { newName: stamped, conflictBehavior: "fail", eTag: opts.baseEtag ?? item.eTag });
    clearState(name);
    return moved;
  }
  async function restore(itemId, targetName, opts = {}) {
    const clean = targetName;
    const folder = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
    const base = baseName(clean);
    const mkName = opts.encrypted && encFileName ? encFileName : fileName;
    const folderId = await provider2.ensureFolder(folder);
    for (let attempt = 1; attempt < 100; attempt++) {
      const candidate = attempt === 1 ? base : `${base} (${attempt})`;
      try {
        return await provider2.move(itemId, folderId, { newName: mkName(candidate), conflictBehavior: "fail", eTag: opts.eTag ?? null });
      } catch (e) {
        const status = e?.status;
        if (status === 409) continue;
        throw e;
      }
    }
    return await provider2.move(itemId, folderId, { newName: mkName(`${base} [${now()}]`), conflictBehavior: "fail", eTag: opts.eTag ?? null });
  }
  async function purge(itemId, eTag) {
    await provider2.delete(itemId, eTag ?? void 0);
  }
  async function weakOverride(name, bytes, opts = {}) {
    const path = encFileName && opts.encrypted ? encFileName(name) : fileName(name);
    const cur = await _find(name);
    let backedUp = null;
    if (cur.item) {
      const folderId = await provider2.ensureFolder(backupFolder);
      const stamped = stampedName(name, cur.enc);
      await provider2.move(cur.item.id, folderId, { newName: stamped, conflictBehavior: "fail", eTag: cur.item.eTag });
      backedUp = `${backupFolder}/${stamped}`;
    }
    let item = await provider2.upload(path, bytes, { contentType, conflictBehavior: "replace" });
    if (!item || !item.eTag) {
      const f = await provider2.getItemByPath(path).catch((e) => {
        reportStoreError(e, "log");
        return null;
      });
      if (f && f.eTag) item = f;
    }
    if (item && item.eTag) {
      setETag(name, item.eTag);
      setDirty(name, false);
    }
    return { item, backedUp };
  }
  async function _walk(subpath, out, depth, folders, status) {
    if (depth > 8) return;
    let items;
    try {
      items = await provider2.list(subpath);
    } catch (e) {
      reportStoreError(e, "log");
      status.partial = true;
      return;
    }
    for (const it of items) {
      if (isHidden(it.name)) continue;
      const itPath = subpath ? `${subpath}/${it.name}` : it.name;
      if (it.isFolder) {
        if (folders) folders.push(itPath);
        await _walk(itPath, out, depth + 1, folders, status);
      } else if (match(it)) out.push({ ...it, path: itPath, name: toName(itPath) });
    }
  }
  async function list() {
    const out = [];
    await _walk("", out, 0, null, { partial: false });
    return out;
  }
  async function listAll() {
    const out = [], folders = [], status = { partial: false };
    await _walk("", out, 0, folders, status);
    return { files: out, folders, complete: !status.partial };
  }
  async function listFolders() {
    const out = [], folders = [];
    await _walk("", out, 0, folders, { partial: false });
    return folders;
  }
  async function listFolder(path) {
    let items;
    try {
      items = await provider2.list(path);
    } catch (e) {
      reportStoreError(e, "log");
      return { files: [], folders: [], complete: false };
    }
    const files = [], folders = [];
    for (const it of items) {
      if (isHidden(it.name)) continue;
      const itPath = path ? `${path}/${it.name}` : it.name;
      if (it.isFolder) folders.push(itPath);
      else if (match(it)) files.push({ ...it, path: itPath, name: toName(itPath) });
    }
    return { files, folders, complete: true };
  }
  async function listTrash() {
    let items;
    try {
      items = await provider2.list(trashFolder);
    } catch (e) {
      reportStoreError(e, "log");
      return [];
    }
    return items.filter(match);
  }
  async function listBackup() {
    let items;
    try {
      items = await provider2.list(backupFolder);
    } catch (e) {
      reportStoreError(e, "log");
      return [];
    }
    return items.filter(match);
  }
  async function rename(oldName, newName, opts = {}) {
    if (oldName === newName) return;
    const found = await _find(oldName);
    const item = found.item;
    if (!item) throw new Error(`\u4E91\u7AEF\u627E\u4E0D\u5230\uFF1A${oldName}`);
    const oldFolder = oldName.includes("/") ? oldName.slice(0, oldName.lastIndexOf("/")) : "";
    const newFolder = newName.includes("/") ? newName.slice(0, newName.lastIndexOf("/")) : "";
    const mkName = found.enc && encFileName ? encFileName : fileName;
    const newBase = mkName(newName.includes("/") ? newName.slice(newName.lastIndexOf("/") + 1) : newName);
    let moved;
    if (oldFolder === newFolder) {
      moved = await provider2.rename(item.id, newBase, opts.baseEtag ?? item.eTag);
    } else {
      const targetId = newFolder ? await provider2.ensureFolder(newFolder) : await provider2.getApprootId();
      moved = await provider2.move(item.id, targetId, { newName: newBase, conflictBehavior: "fail", eTag: opts.baseEtag ?? item.eTag });
    }
    const newETag = moved && moved.eTag || getETag(oldName);
    setETag(newName, newETag);
    setDirty(newName, false);
    clearState(oldName);
  }
  async function ensureFolder(path) {
    await provider2.ensureFolder(path);
  }
  function deleteEmptyFolder(path) {
    return provider2.deleteEmptyFolder(path);
  }
  return {
    push,
    pull,
    fetchMeta,
    pullTail,
    pullRange,
    weakOverride,
    trash,
    restore,
    purge,
    list,
    listAll,
    listFolder,
    listFolders,
    listTrash,
    listBackup,
    rename,
    ensureFolder,
    deleteEmptyFolder,
    getETag,
    setETag,
    isDirty: isDirty2,
    setDirty,
    clearState
  };
}

// ../../20260813 internal-store/src/identity.ts
var passBusy4 = (_l, fn) => fn();
function createIdentity(cfg) {
  const { cloud, local, head, doPush, serialize, serialize2, seal, busy: _busy = passBusy4, isOnline, deleteOffline, queueUpload, nameOccupied } = cfg;
  const unseal = (name, blob) => seal ? seal.unsealForRead(name, blob) : Promise.resolve(blob);
  async function assertNameFree(newName, doCloud) {
    if (doCloud && nameOccupied) {
      if (await nameOccupied(newName)) throw new CloudNameCollisionError(newName);
      return;
    }
    if (local && await local.exists(newName)) throw new CloudNameCollisionError(newName);
  }
  async function probeOld(name) {
    try {
      return { known: true, meta: await cloud.fetchMeta(name) };
    } catch (e) {
      reportStoreError(e, "log");
      return { known: false };
    }
  }
  async function rename(oldName, newName, opts = {}) {
    const { encode: encode2, getEditVersion, cloud: doCloud = true, busy = _busy, skipOccupiedCheck } = opts;
    if (!oldName || !newName || oldName === newName) return { status: "noop" };
    return serialize2(oldName, newName, () => busy("\u91CD\u547D\u540D\u2026", async () => {
      if (!skipOccupiedCheck) await assertNameFree(newName, doCloud);
      const hasLocal = local ? await local.exists(oldName) : false;
      let bytes = null;
      if (encode2) bytes = await toU8(await encode2());
      else if (hasLocal) bytes = await toU8(await local.get(oldName));
      if (doCloud && isOnline && !isOnline() && deleteOffline && hasLocal) {
        await local.save(newName, bytes);
        head.recordEdit(newName);
        queueUpload?.(newName);
        await deleteOffline(oldName);
        return { status: "renamed", where: "offline-move", newName };
      }
      if (local && hasLocal) {
        await local.save(newName, bytes);
        await local.hardDelete(oldName);
      }
      if (!doCloud) {
        head.forget(oldName);
        return { status: "renamed", where: "local", newName };
      }
      try {
        const before = await probeOld(oldName);
        if (before.known && before.meta && (!head.isDirty(oldName) || bytes == null)) {
          await cloud.rename(oldName, newName, { baseEtag: before.meta.etag });
          head.markSeen(newName, cloud.getETag(newName));
          head.forget(oldName);
          return { status: "renamed", where: "cloud-move", newName };
        }
        if (bytes == null) {
          head.forget(oldName);
          return { status: "renamed", where: "local", newName };
        }
        const baseAtStart = head.seenBase(oldName);
        await doPush(newName, { encode: () => bytes, getEditVersion });
        const after = await probeOld(oldName);
        let oldCloudOrphan = false, oldKept = false, oldUnknown = false;
        if (!after.known) {
          oldUnknown = true;
        } else if (after.meta == null) {
        } else if (baseAtStart != null && baseAtStart === after.meta.etag) {
          try {
            await cloud.trash(oldName, asideStamp(Date.now()), { baseEtag: after.meta.etag });
          } catch (e) {
            reportStoreError(e, "warning");
            oldCloudOrphan = true;
          }
        } else {
          oldKept = true;
        }
        head.forget(oldName);
        return {
          status: "renamed",
          where: oldUnknown ? "cloud-push+unknown" : oldKept ? "cloud-push+kept" : oldCloudOrphan || after.known && after.meta ? "cloud-push+trash" : "cloud-push",
          newName,
          oldCloudOrphan,
          oldKept,
          oldUnknown,
          oldName
        };
      } catch (e) {
        reportStoreError(e, "warning");
        head.recordEdit(newName);
        head.forget(oldName);
        return { status: "renamed", where: "local", newName, cloudDeferred: true, error: e };
      }
    }));
  }
  async function acquire(cloudName, opts = {}) {
    const { localName = cloudName, adopt, busy = passBusy4 } = opts;
    return busy("\u62C9\u53D6\u4E2D\u2026", () => serialize(localName, async () => {
      const r = await cloud.pull(cloudName);
      if (!r) return { status: "absent" };
      if (local) await local.save(localName, r.blob);
      head.markSynced(localName, r.item?.eTag ?? null);
      if (adopt) {
        const plain = await unseal(localName, r.blob);
        if (plain) await adopt(plain, localName);
      }
      return { status: "acquired", localName, item: r.item };
    }));
  }
  return { rename, acquire };
}

// ../../20260813 internal-store/src/trash.ts
var passBusy5 = (_l, fn) => fn();
function createTrash(cfg) {
  const { cloud, local, head, busy: _busy = passBusy5 } = cfg;
  async function restore(opts = {}) {
    const { fromCloud, cloudItemId, targetName, trashKey, encrypted, busy = _busy } = opts;
    return busy("\u6062\u590D\u4E2D\u2026", async () => {
      let name = targetName || null, restoredLocal = false, restoredCloud = false;
      if (trashKey && local) {
        const n = await local.restore(trashKey);
        if (n) {
          name = n;
          restoredLocal = true;
        }
      }
      if (fromCloud && cloudItemId != null) {
        const ritem = await cloud.restore(cloudItemId, name || targetName, { encrypted });
        restoredCloud = true;
        const rname = name || targetName;
        if (rname && ritem && ritem.eTag) head.markSeen(rname, ritem.eTag);
      }
      if (!restoredLocal && !restoredCloud) return { status: "noop" };
      return { status: "restored", name, local: restoredLocal, cloud: restoredCloud };
    });
  }
  async function purge(opts = {}) {
    const { trashKey, cloudItemId, confirm, busy = _busy } = opts;
    if (confirm && !await confirm({ title: "\u5F7B\u5E95\u5220\u9664", body: "\u4E0D\u53EF\u6062\u590D", danger: true })) return { status: "cancelled" };
    return busy("\u5F7B\u5E95\u5220\u9664\u2026", async () => {
      if (trashKey && local && local.purgeTrash) await local.purgeTrash(trashKey);
      if (cloudItemId != null) await cloud.purge(cloudItemId);
      return { status: "purged" };
    });
  }
  async function emptyTrash(opts = {}) {
    const { isOnline, busy = _busy, concurrency = 5, scope = "both" } = opts;
    return busy("\u6E05\u7A7A\u56DE\u6536\u7AD9\u2026", async () => {
      let purged = 0;
      const failed = [];
      const errMsg = (e) => String(e?.message || e);
      if (scope !== "cloud" && local && local.listTrash && local.purgeTrash) {
        for (const t of await local.listTrash()) {
          try {
            await local.purgeTrash(t.trashKey);
            purged++;
          } catch (e) {
            reportStoreError(e, "warning");
            failed.push({ name: t.name, where: "local", error: errMsg(e) });
          }
        }
      }
      if (scope !== "local" && (!isOnline || isOnline())) {
        let items = null;
        try {
          items = await cloud.listTrash();
        } catch (e) {
          reportStoreError(e, "warning");
          failed.push({ where: "cloud-list", error: errMsg(e) });
        }
        items = items || [];
        for (let i = 0; i < items.length; i += concurrency) {
          await Promise.all(items.slice(i, i + concurrency).map(async (it) => {
            try {
              await cloud.purge(it.id, it.eTag);
              purged++;
            } catch (e) {
              reportStoreError(e, "warning");
              failed.push({ name: it.name, where: "cloud", error: errMsg(e) });
            }
          }));
        }
      }
      return { status: "emptied", purged, failed };
    });
  }
  async function emptyBackup(opts = {}) {
    const { isOnline, busy = _busy, concurrency = 5, scope = "both" } = opts;
    return busy("\u6E05\u7A7A\u5907\u4EFD\u7BB1\u2026", async () => {
      let purged = 0;
      const failed = [];
      const errMsg = (e) => String(e?.message || e);
      if (scope !== "cloud" && local && local.listBackup && local.purgeTrash) {
        for (const b of await local.listBackup()) {
          try {
            await local.purgeTrash(b.trashKey);
            purged++;
          } catch (e) {
            reportStoreError(e, "warning");
            failed.push({ name: b.name, where: "local", error: errMsg(e) });
          }
        }
      }
      if (scope !== "local" && (!isOnline || isOnline())) {
        let items = null;
        try {
          items = await cloud.listBackup();
        } catch (e) {
          reportStoreError(e, "warning");
          failed.push({ where: "cloud-list", error: errMsg(e) });
        }
        items = items || [];
        for (let i = 0; i < items.length; i += concurrency) {
          await Promise.all(items.slice(i, i + concurrency).map(async (it) => {
            try {
              await cloud.purge(it.id, it.eTag);
              purged++;
            } catch (e) {
              reportStoreError(e, "warning");
              failed.push({ name: it.name, where: "cloud", error: errMsg(e) });
            }
          }));
        }
      }
      return { status: "emptied", purged, failed };
    });
  }
  return { restore, purge, emptyTrash, emptyBackup };
}

// ../../20260813 internal-store/src/offload.ts
var OffloadIllegalError = class extends Error {
  code = "OFFLOAD_ILLEGAL";
  reason;
  constructor(name, reason) {
    super(`offload "${name}" \u4E0D\u9002\u7528\uFF08${reason}\uFF09\uFF1A\u672C\u5730\u662F\u4E16\u754C\u552F\u4E00\u526F\u672C\u6216\u4E0D\u53EF\u91CD\u53D6\uFF0C\u62D2\u7EDD\u4E22\u5F03\u3002`);
    this.name = "OffloadIllegalError";
    this.reason = reason;
  }
};
function createOffload(cfg) {
  const { cloud, local, head, isOnline } = cfg;
  const serialize = cfg.serialize ?? ((_n, fn) => Promise.resolve().then(fn));
  async function offload(name) {
    return serialize(name, async () => {
      if (!await local.exists(name)) return;
      if (head.isDirtyAnywhere(name)) throw new OffloadIllegalError(name, "dirty");
      if (isOnline && !isOnline()) throw new OffloadIllegalError(name, "offline");
      if (head.seenBase(name) == null) throw new OffloadIllegalError(name, "local-only");
      const meta = await cloud.fetchMeta(name).catch((e) => {
        reportStoreError(e, "log");
        return null;
      });
      if (!meta) throw new OffloadIllegalError(name, "cloud-gone");
      if (!(meta.size > 0)) throw new OffloadIllegalError(name, "incomplete");
      if (head.isDirtyAnywhere(name)) throw new OffloadIllegalError(name, "dirty");
      await local.hardDelete(name);
      head.forget(name);
    });
  }
  return { offload };
}

// ../../20260813 internal-store/src/reconcile.ts
function classifyCloudGone(localNames, cloudNameSet, opts) {
  const demote = [];
  if (!opts.authoritative) return { demote };
  for (const name of localNames) {
    if (opts.skip?.(name)) continue;
    if (cloudNameSet.has(name)) continue;
    if (opts.seenBase(name) == null) continue;
    if (opts.isDirty(name)) continue;
    demote.push(name);
  }
  return { demote };
}
function createReconcile(cfg) {
  const { cloud, local, head, pending, isOnline, activeFileName: activeFileNameFn } = cfg;
  const now = cfg.now || (() => Date.now());
  const skipName = (opt) => opt ?? activeFileNameFn?.() ?? void 0;
  async function converge(localNames, cloudNames, authoritative, activeFileName) {
    if (!authoritative) return { demoted: [] };
    localNames = localNames.filter((n) => !isHidden(n));
    for (const name of localNames) {
      if (pending.isPending(name) && (cloudNames.has(name) || head.isDirty(name))) pending.clear(name);
    }
    const { demote } = classifyCloudGone(localNames, cloudNames, {
      seenBase: (n) => head.seenBase(n),
      isDirty: (n) => head.isDirty(n),
      authoritative,
      skip: activeFileName ? (n) => n === activeFileName : void 0
    });
    const demoted = [];
    for (const name of demote) {
      if (!pending.seenGone(name, now())) continue;
      await local.trash(name, asideStamp(now()));
      cloud.clearState(name);
      head.forget(name);
      pending.clear(name);
      demoted.push(name);
    }
    return { demoted };
  }
  async function reconcile(opts = {}) {
    if (isOnline && !isOnline()) return { demoted: [] };
    const all = await cloud.listAll().catch((e) => {
      reportStoreError(e, "log");
      return null;
    });
    const authoritative = !!(all && all.complete && all.files.length > 0);
    if (!authoritative) return { demoted: [] };
    const cloudNames = new Set(all.files.map((f) => f.name ?? f.path));
    return converge(await local.appKeys(), cloudNames, authoritative, skipName(opts.activeFileName));
  }
  async function reconcileFolder(folder, opts = {}) {
    if (isOnline && !isOnline()) return { demoted: [] };
    const res = opts.cloudPrefetched !== void 0 ? opts.cloudPrefetched : await cloud.listFolder(folder).catch((e) => {
      reportStoreError(e, "log");
      return null;
    });
    if (!res || !res.complete) return { demoted: [] };
    const cloudNames = new Set(res.files.map((f) => f.name ?? f.path));
    const prefix = folder ? `${folder}/` : "";
    const localNames = (await local.appKeys()).filter((k) => {
      if (folder && !k.startsWith(prefix)) return false;
      const rest = k.slice(prefix.length);
      return rest.length > 0 && !rest.includes("/");
    });
    return converge(localNames, cloudNames, true, skipName(opts.activeFileName));
  }
  return { reconcile, reconcileFolder };
}

// ../../20260813 internal-store/src/pending-gone.ts
var KEY = "internal.pending_gone";
function createPendingGone(kv, graceMs) {
  function read() {
    try {
      const raw = kv.get(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      reportStoreError(e, "log");
      return {};
    }
  }
  function write(m) {
    if (Object.keys(m).length) kv.set(KEY, JSON.stringify(m));
    else kv.remove(KEY);
  }
  return {
    isPending(name) {
      return read()[name] != null;
    },
    seenGone(name, now) {
      const m = read();
      const first = m[name];
      if (first == null) {
        m[name] = now;
        write(m);
        return false;
      }
      if (now - first >= graceMs) return true;
      return false;
    },
    clear(name) {
      const m = read();
      if (m[name] != null) {
        delete m[name];
        write(m);
      }
    },
    names() {
      return Object.keys(read());
    }
  };
}

// ../../20260813 internal-store/src/folder-merge.ts
var lastWinResolve = (x, y) => defaultResolve(x, y);
function resolverForPolicy(policy) {
  switch (policy) {
    case "last-win":
      return lastWinResolve;
    default:
      return lastWinResolve;
  }
}
var FOLDER_ENVELOPE_VERSION = 2;
function emptyFolder() {
  return { version: FOLDER_ENVELOPE_VERSION, items: [] };
}
function defaultResolve(x, y) {
  const ux = x.uat || 0, uy = y.uat || 0;
  if (uy > ux) return y;
  if (uy < ux) return x;
  return JSON.stringify(y) > JSON.stringify(x) ? y : x;
}
function mergeFolders(a, b, { resolve, conflictPolicy = "last-win" } = {}) {
  const A = a || emptyFolder(), B = b || emptyFolder();
  const pick = resolve || resolverForPolicy(conflictPolicy);
  const items = /* @__PURE__ */ new Map();
  for (const e of [...A.items || [], ...B.items || []]) {
    if (!e || e.id == null) continue;
    const cur = items.get(e.id);
    items.set(e.id, cur ? pick(cur, e) : e);
  }
  return { version: FOLDER_ENVELOPE_VERSION, items: [...items.values()] };
}
function isValidFolderEnvelope(o) {
  const f = o;
  return !!f && typeof f === "object" && Number.isFinite(f.version) && Array.isArray(f.items) && f.items.every((e) => e && e.id != null && Number.isFinite(e.uat));
}
function parseFolderBlob(textOrBytes) {
  let o;
  try {
    const s = typeof textOrBytes === "string" ? textOrBytes : new TextDecoder().decode(textOrBytes);
    o = JSON.parse(s);
  } catch (e) {
    reportStoreError(e, "log");
    return null;
  }
  return isValidFolderEnvelope(o) ? o : null;
}
function normalizeFolder(f) {
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));
  return JSON.stringify({
    version: f.version,
    items: [...f.items || []].sort(byId)
  });
}

// ../../20260813 internal-store/src/folder-flow.ts
function withTimeout(p, ms) {
  if (!ms) return p;
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { _timeout: true })), ms))
  ]);
}
var is412 = (e) => {
  const x = e;
  return !!x && (x.name === "CloudConflictError" || x.status === 412);
};
function createFolderFlow(cfg) {
  const { cloud, name, encode: encode2, decode: decode2, resolve, conflictPolicy = "last-win", isOnline, timeoutMs = 15e3 } = cfg;
  let chain = Promise.resolve(null);
  function sync(localFolder) {
    const run = () => _sync(localFolder, 0);
    chain = chain.then(run, run);
    return chain;
  }
  async function _sync(localFolder, depth) {
    if (isOnline && !isOnline()) return { status: "offline", folder: localFolder };
    let pulled;
    try {
      pulled = await withTimeout(cloud.pull(name), timeoutMs);
    } catch (e) {
      reportStoreError(e, "log");
      return { status: "offline", folder: localFolder, error: e };
    }
    let cloudFolder = emptyFolder();
    if (pulled && pulled.blob) {
      let text;
      try {
        text = await pulled.blob.text();
      } catch (e) {
        reportStoreError(e, "log");
        return { status: "offline", folder: localFolder, error: e };
      }
      const parsed = decode2(text);
      if (!parsed) return { status: "invalid", folder: localFolder };
      cloudFolder = parsed;
    }
    const merged = mergeFolders(localFolder, cloudFolder, { resolve, conflictPolicy });
    if (normalizeFolder(merged) === normalizeFolder(cloudFolder)) {
      return { status: "synced", folder: merged, pushed: false, etag: pulled?.item?.eTag };
    }
    try {
      const res = await withTimeout(cloud.push(name, encode2(merged), { baseEtag: pulled?.item?.eTag }), timeoutMs);
      return { status: "synced", folder: merged, pushed: true, etag: res?.item?.eTag };
    } catch (e) {
      if (is412(e) && depth < 5) return _sync(merged, depth + 1);
      reportStoreError(e, "warning");
      return { status: "dirty", folder: merged, error: e };
    }
  }
  return { sync };
}

// ../../20260813 internal-store/src/collection.ts
function collectionLocalKey(name) {
  return `collections/${name}`;
}
var SEED_UAT = 1;
var encode = (f) => new TextEncoder().encode(JSON.stringify(f));
var decode = (text) => parseFolderBlob(text);
function emptyCollectionBytes() {
  return encode(emptyFolder());
}
var resolveDef = (def) => typeof def === "function" ? def() : def;
var shallowCopy = (v) => Array.isArray(v) ? [...v] : v && typeof v === "object" ? { ...v } : v;
var valueOf = (e) => e.value;
var isTombstone = (e) => valueOf(e) === null;
function createCollection(cfg) {
  const {
    cloud,
    name,
    isOnline,
    syncDelayMs = 1500,
    now = () => Date.now(),
    manual = false,
    local,
    localWriteDelayMs = 400,
    cloudless = false,
    getInitData
  } = cfg;
  const flow = createFolderFlow({ cloud, name, encode, decode, isOnline });
  let env = emptyFolder();
  let timer = null;
  let ready = false;
  const listeners = /* @__PURE__ */ new Set();
  let _firing = false;
  const _queued = [];
  function emit(changed) {
    if (!changed.length || !listeners.size) return;
    if (_firing) {
      _queued.push(...changed);
      return;
    }
    _firing = true;
    try {
      let batch = changed;
      while (batch.length) {
        for (const cb of listeners) {
          try {
            cb(batch);
          } catch (e) {
            reportStoreError(e, "log");
          }
        }
        batch = _queued.splice(0, _queued.length);
      }
    } finally {
      _firing = false;
    }
  }
  const snapshotValues = () => {
    const m = /* @__PURE__ */ new Map();
    for (const e of env.items) if (e.id != null) m.set(String(e.id), JSON.stringify(valueOf(e)));
    return m;
  };
  const fireChanged = (before) => {
    if (!listeners.size) return;
    const after = snapshotValues();
    const changed = [];
    for (const [id, v] of after) if (before.get(id) !== v) changed.push(id);
    for (const [id] of before) if (!after.has(id)) changed.push(id);
    emit(changed);
  };
  const localKey = collectionLocalKey(name);
  let hydrated = false;
  let idbHad = false;
  let localTimer = null;
  let localChain = Promise.resolve({ ok: true });
  async function bytesOf(b) {
    if (!b) return null;
    if (b instanceof Uint8Array) return b;
    if (typeof b.arrayBuffer === "function") return new Uint8Array(await b.arrayBuffer());
    return null;
  }
  async function hydrateLocal() {
    if (!local || hydrated) return;
    hydrated = true;
    try {
      idbHad = await local.exists(localKey);
      if (idbHad) {
        const cached = parseFolderBlob(await bytesOf(await local.get(localKey)) ?? new Uint8Array(0));
        if (cached) env = mergeFolders(env, cached);
      }
    } catch (e) {
      reportStoreError(e, "log");
    }
  }
  function clearLocalTimer() {
    if (localTimer != null) {
      clearTimeout(localTimer);
      localTimer = null;
    }
  }
  function scheduleLocalWrite() {
    if (!local || localTimer != null) return;
    localTimer = setTimeout(() => {
      localTimer = null;
      void writeLocalNow();
    }, localWriteDelayMs);
  }
  function writeLocalNow() {
    if (!local) return Promise.resolve({ ok: true });
    clearLocalTimer();
    const snap = encode(env);
    localChain = localChain.then(() => local.save(localKey, snap).then(() => ({ ok: true }))).catch((e) => {
      reportStoreError(e, "warning");
      return { ok: false, error: e };
    });
    return localChain;
  }
  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function scheduleSync() {
    scheduleLocalWrite();
    if (cloudless) return;
    cloud.setDirty(name, true);
    if (manual) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void sync();
    }, syncDelayMs);
  }
  async function sync() {
    if (cloudless) return null;
    const before = snapshotValues();
    const res = await flow.sync(env);
    env = mergeFolders(env, res.folder);
    scheduleLocalWrite();
    if (res.status === "synced") {
      if (res.etag) cloud.setETag(name, res.etag);
      if (normalizeFolder(env) === normalizeFolder(res.folder)) cloud.setDirty(name, false);
    }
    fireChanged(before);
    return res;
  }
  async function reconcile() {
    if (cloudless) return null;
    if (!cloud.isDirty(name) && (!isOnline || isOnline()) && cloud.getETag(name)) {
      const meta = await cloud.fetchMeta(name).catch((e) => {
        reportStoreError(e, "log");
        return null;
      });
      if (meta && meta.etag === cloud.getETag(name)) return null;
    }
    return sync();
  }
  async function reconcileWithRemote() {
    try {
      return await reconcile() ?? { status: "unchanged" };
    } catch (e) {
      reportStoreError(e, "warning");
      return { status: "error", error: e };
    }
  }
  async function seedInit() {
    if (!getInitData) return;
    let initial;
    try {
      initial = await getInitData();
    } catch (e) {
      reportStoreError(e, "warning");
      return;
    }
    if (!initial || !initial.length) return;
    const seeded = initial.filter((it) => it && it.id != null && it.value !== void 0).map((it) => ({ id: it.id, uat: SEED_UAT, value: shallowCopy(it.value) }));
    if (!seeded.length) return;
    env = mergeFolders(env, { version: FOLDER_ENVELOPE_VERSION, items: seeded });
    cloud.setDirty(name, true);
    scheduleLocalWrite();
  }
  async function init() {
    await hydrateLocal();
    if (!idbHad) await seedInit();
    ready = true;
    if (cloudless) return;
    void reconcile().catch((e) => reportStoreError(e, "log"));
  }
  function setItem(id, value) {
    if (!ready) throw new Error(`collection(${name}).setItem \u5728 init() \u524D\u8C03\u7528\u2014\u2014\u8BBE\u7F6E\u672A\u5C31\u7EEA`);
    if (id == null) throw new Error("collection.setItem: id \u5FC5\u586B");
    if (value === void 0) throw new Error(`collection(${name}).setItem: value \u4E0D\u53EF\u4E3A undefined\uFF08\u5220\u9664\u8BF7\u7528 deleteItem \u6216\u4F20 null \u5893\u7891\uFF09`);
    const prev = env.items.find((e) => e.id === id);
    const valueChanged = !prev || JSON.stringify(valueOf(prev)) !== JSON.stringify(value);
    const fi = { id, uat: now(), value: shallowCopy(value) };
    env = { ...env, items: [...env.items.filter((e) => e.id !== id), fi] };
    scheduleSync();
    if (valueChanged) emit([id]);
  }
  function deleteItem2(id) {
    if (!ready) throw new Error(`collection(${name}).deleteItem \u5728 init() \u524D\u8C03\u7528`);
    setItem(id, null);
  }
  const entryOf = (e) => ({ id: String(e.id), uat: e.uat || 0, value: valueOf(e) });
  function getEntry(id) {
    const e = env.items.find((x) => x.id === id);
    return e && !isTombstone(e) ? entryOf(e) : void 0;
  }
  function getItem(id, def) {
    const e = env.items.find((x) => x.id === id);
    return e && !isTombstone(e) ? shallowCopy(valueOf(e)) : resolveDef(def);
  }
  function entries() {
    return env.items.filter((e) => !isTombstone(e)).map(entryOf);
  }
  function keys() {
    return env.items.filter((e) => !isTombstone(e)).map((e) => String(e.id));
  }
  function onChange(a, b) {
    const cb = typeof a === "string" ? (ids) => {
      if (ids.includes(a)) b();
    } : a;
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }
  function flushLocal() {
    return writeLocalNow();
  }
  function isDirty2() {
    return cloudless ? false : cloud.isDirty(name);
  }
  return { init, reconcileWithRemote, setItem, deleteItem: deleteItem2, getItem, getEntry, entries, keys, onChange, flushLocal, isDirty: isDirty2 };
}

// ../../20260813 internal-store/src/listing.ts
function classifySyncState(f) {
  if (!f.hasLocal) return "cloud-only";
  if (!f.cloudReachable) {
    if (f.dirty) return f.everSynced ? "unpushed" : "float";
    return "local-only";
  }
  if (f.hasCloud) {
    const moved = f.cloudMoved || !f.everSynced;
    if (moved) return f.dirty ? "conflict" : "newer-on-cloud";
    return f.dirty ? "unpushed" : "synced";
  }
  if (!f.everSynced) return f.dirty ? "float" : "local-only";
  if (!f.absenceAuthoritative) return f.dirty ? "unpushed" : "synced";
  if (f.dirty) return "ghost";
  return f.pendingGone ? "pendingGone" : "local-only";
}
var toMs = (v) => {
  if (v == null) return void 0;
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : void 0;
};
function createListing(cfg) {
  const { cloud, local, head, pendingFolders, isPendingGone, pendingFolderDeletions } = cfg;
  function classifyPath(path, cf, hasLocal, cloudReachable, absenceAuthoritative, localStat) {
    const hasCloud = cf != null;
    const seen = head.seenBase(path);
    const everSynced = seen != null;
    const cloudMoved = hasCloud && cf.eTag !== seen;
    const syncState = classifySyncState({
      hasLocal,
      hasCloud,
      everSynced,
      cloudMoved,
      dirty: head.isDirty(path),
      cloudReachable,
      absenceAuthoritative,
      pendingGone: isPendingGone?.(path)
    });
    return { path, syncState, size: cf?.size ?? localStat?.size, lastModified: cf?.lastModified ?? localStat?.updatedAt };
  }
  async function statLocal(keys) {
    const m = /* @__PURE__ */ new Map();
    if (!local.stat) return m;
    await Promise.all([...keys].map(async (k) => {
      const s = await local.stat(k);
      if (s) m.set(k, s);
    }));
    return m;
  }
  async function listFolder(folder, ctx, opts) {
    const cloudRes = opts?.cloudPrefetched !== void 0 ? opts.cloudPrefetched : ctx.online && ctx.signedIn ? await cloud.listFolder(folder).catch((e) => {
      reportStoreError(e, "log");
      return null;
    }) : null;
    const cloudReachable = cloudRes != null;
    const absenceAuthoritative = cloudReachable && cloudRes.complete === true;
    const prefix = folder ? `${folder}/` : "";
    const cloudMap = /* @__PURE__ */ new Map();
    for (const c of cloudRes?.files ?? []) {
      if (isHidden(c.name)) continue;
      cloudMap.set(c.name, { eTag: c.eTag, size: c.size, lastModified: toMs(c.lastModifiedDateTime) });
    }
    const localDirect = /* @__PURE__ */ new Set();
    const subfolders = /* @__PURE__ */ new Set();
    for (const k of await local.appKeys()) {
      if (folder && !k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        const sub = prefix + rest.slice(0, slash);
        if (!isHidden(sub)) subfolders.add(sub);
      } else if (!isHidden(k)) localDirect.add(k);
    }
    for (const f of cloudRes?.folders ?? []) {
      if (!isHidden(f)) subfolders.add(f);
    }
    for (const p of pendingFolders?.() ?? []) {
      if (folder && !p.startsWith(prefix)) continue;
      const rest = folder ? p.slice(prefix.length) : p;
      const seg = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
      if (seg && !isHidden(seg)) subfolders.add(prefix + seg);
    }
    const paths = /* @__PURE__ */ new Set([...cloudMap.keys(), ...localDirect]);
    const localStats = await statLocal(localDirect);
    const items = [];
    for (const path of paths) items.push(classifyPath(path, cloudMap.get(path), localDirect.has(path), cloudReachable, absenceAuthoritative, localStats.get(path)));
    const stale = opts?.staleCloud != null;
    if (opts?.staleCloud) {
      for (const f of opts.staleCloud.files) {
        if (paths.has(f.name) || isHidden(f.name)) continue;
        const rest = folder ? f.name.startsWith(prefix) ? f.name.slice(prefix.length) : "" : f.name;
        if (!rest || rest.includes("/")) continue;
        items.push({ path: f.name, syncState: "cloud-only", size: f.size, lastModified: f.lastModified });
      }
      for (const sf of opts.staleCloud.folders) if (!isHidden(sf)) subfolders.add(sf);
    }
    for (const d of pendingFolderDeletions?.() ?? []) subfolders.delete(d);
    const snap = { path: folder, items, folders: [...subfolders], complete: absenceAuthoritative };
    if (stale) snap.stale = true;
    return snap;
  }
  async function listAllItems(ctx) {
    const cloudRes = ctx.online && ctx.signedIn ? await cloud.listAll().catch((e) => {
      reportStoreError(e, "log");
      return null;
    }) : null;
    const cloudReachable = cloudRes != null;
    const absenceAuthoritative = cloudReachable && cloudRes.complete === true;
    const cloudMap = /* @__PURE__ */ new Map();
    for (const c of cloudRes?.files ?? []) {
      if (isHidden(c.name)) continue;
      cloudMap.set(c.name, { eTag: c.eTag, size: c.size, lastModified: toMs(c.lastModifiedDateTime) });
    }
    const localSet = new Set((await local.appKeys()).filter((k) => !isHidden(k)));
    const paths = /* @__PURE__ */ new Set();
    for (const p of cloudMap.keys()) paths.add(p);
    for (const p of localSet) paths.add(p);
    const localStats = await statLocal(localSet);
    const items = [];
    for (const path of paths) items.push(classifyPath(path, cloudMap.get(path), localSet.has(path), cloudReachable, absenceAuthoritative, localStats.get(path)));
    const folderSet = /* @__PURE__ */ new Set();
    for (const f of cloudRes?.folders ?? []) if (!isHidden(f)) folderSet.add(f);
    for (const p of pendingFolders?.() ?? []) if (!isHidden(p)) folderSet.add(p);
    for (const d of pendingFolderDeletions?.() ?? []) folderSet.delete(d);
    return { items, folders: [...folderSet], complete: cloudReachable ? cloudRes.complete : false };
  }
  return { listAllItems, listFolder };
}

// ../../20260813 internal-store/src/upload-queue.ts
var UPQ_KEY = "internal.pending_uploads";
function createUploadReplay(cfg) {
  const { kv, local, head, isOnline, serialize, pushLocal, policy, confirm, onStatus } = cfg;
  function readQueue() {
    try {
      const v = JSON.parse(kv.get(UPQ_KEY) ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) {
      reportStoreError(e, "log");
      return [];
    }
  }
  function writeQueue(q) {
    if (q.length) kv.set(UPQ_KEY, JSON.stringify([...new Set(q)]));
    else kv.remove(UPQ_KEY);
  }
  function enqueue(name) {
    if (policy === "manual") return;
    writeQueue([...readQueue(), name]);
  }
  function remove(name) {
    const q = readQueue();
    if (q.includes(name)) writeQueue(q.filter((n) => n !== name));
  }
  async function drain() {
    if (policy === "manual") return { status: "manual", pushed: 0 };
    const q = readQueue();
    if (!q.length) return { status: "empty", pushed: 0 };
    if (!isOnline()) return { status: "offline", pushed: 0 };
    if (policy === "ask") {
      const ok = confirm ? await confirm(q.length) : false;
      if (!ok) return { status: "declined", pushed: 0 };
    }
    onStatus?.({ phase: "start", done: 0, total: q.length });
    const remain = [];
    let pushed = 0;
    for (const name of q) {
      const r = await serialize(name, async () => {
        if (!await local.exists(name)) return "gone";
        if (!head.isDirty(name) || head.seenBase(name) != null) return "synced";
        try {
          const r2 = await pushLocal(name);
          return r2?.status === "deferred" ? "keep" : "pushed";
        } catch (e) {
          if (e?.name === "CloudNameCollisionError") return "collision";
          reportStoreError(e, "log");
          return "keep";
        }
      });
      if (r === "pushed") {
        pushed++;
        onStatus?.({ phase: "pushed", name, done: pushed, total: q.length });
      } else if (r === "collision") onStatus?.({ phase: "collision", name, done: pushed, total: q.length });
      else if (r === "keep") remain.push(name);
    }
    writeQueue(remain);
    onStatus?.({ phase: "done", done: pushed, total: q.length });
    return { status: "drained", pushed, remain: remain.length };
  }
  return { enqueue, remove, drain, pending: readQueue };
}

// ../../20260813 internal-store/src/trash-merge.ts
var STAMP_RE = /^(.*) \[((\d{14})-[0-9a-fA-F-]+)\](\.zip)?$/;
var baseNameOf = (n) => n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n;
function parseCloudTrashName(cloudName) {
  const m = cloudName.match(STAMP_RE);
  if (m) return { base: m[1], id: m[2], ts: m[3], encrypted: !!m[4] };
  const encrypted = cloudName.endsWith(".zip");
  return { base: encrypted ? cloudName.slice(0, -4) : cloudName, id: null, ts: null, encrypted };
}
function parseLocalStamp(trashKey) {
  const slash = trashKey.indexOf("/");
  const inner = slash < 0 ? trashKey : trashKey.slice(slash + 1);
  const m = inner.match(/^((\d{14})-[0-9a-fA-F-]+):/);
  return m ? { id: m[1], ts: m[2] } : { id: null, ts: null };
}
var byTs = (a, b) => (a.ts || "").localeCompare(b.ts || "");
function mergeTrash(localEntries, cloudEntries, liveCloudNames = /* @__PURE__ */ new Set()) {
  const localByBase = /* @__PURE__ */ new Map();
  for (const e of localEntries) {
    const base = baseNameOf(e.name);
    const bucket = localByBase.get(base) ?? [];
    const st = parseLocalStamp(e.trashKey);
    bucket.push({ entry: e, id: st.id, ts: st.ts });
    localByBase.set(base, bucket);
  }
  const cloudByBase = /* @__PURE__ */ new Map();
  for (const it of cloudEntries) {
    const p = parseCloudTrashName(it.name);
    const bucket = cloudByBase.get(p.base) ?? [];
    bucket.push({ item: it, id: p.id, ts: p.ts, encrypted: p.encrypted });
    cloudByBase.set(p.base, bucket);
  }
  const out = [];
  const bases = /* @__PURE__ */ new Set([...localByBase.keys(), ...cloudByBase.keys()]);
  for (const base of bases) {
    const locals = (localByBase.get(base) ?? []).slice().sort(byTs);
    const clouds = (cloudByBase.get(base) ?? []).slice().sort(byTs);
    const usedCloud = /* @__PURE__ */ new Set();
    const byId = /* @__PURE__ */ new Map();
    clouds.forEach((c, i) => {
      if (c.id) byId.set(c.id, i);
    });
    const lonelyLocals = [];
    for (const l of locals) {
      const ci = l.id != null ? byId.get(l.id) : void 0;
      if (ci == null || usedCloud.has(ci)) {
        lonelyLocals.push(l);
        continue;
      }
      usedCloud.add(ci);
      const c = clouds[ci];
      out.push({ name: l.entry.name, ts: l.ts ?? c.ts, side: "both", encrypted: c.encrypted, conflictLive: false, localKey: l.entry.trashKey, cloudItemId: c.item.id });
    }
    for (const l of lonelyLocals) {
      out.push({ name: l.entry.name, ts: l.ts, side: "local", encrypted: false, conflictLive: liveCloudNames.has(l.entry.name), localKey: l.entry.trashKey, cloudItemId: null });
    }
    clouds.forEach((c, i) => {
      if (usedCloud.has(i)) return;
      out.push({ name: base, ts: c.ts, side: "cloud", encrypted: c.encrypted, conflictLive: false, localKey: null, cloudItemId: c.item.id });
    });
  }
  return out;
}

// ../../20260813 internal-store/src/idb-store.ts
var STORE = "blobs";
function createIdbCache(dbName) {
  function openDb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function reqTx(mode2, run) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode2);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }
  return {
    get(name) {
      return reqTx("readonly", (s) => s.get(name));
    },
    put(name, rec) {
      return reqTx("readwrite", (s) => s.put(rec, name)).then(() => void 0);
    },
    del(name) {
      return reqTx("readwrite", (s) => s.delete(name)).then(() => void 0);
    },
    keys() {
      return reqTx("readonly", (s) => s.getAllKeys()).then((ks) => ks.filter((k) => typeof k === "string"));
    },
    /** 按 key 前缀汇总占用（单事务 cursor 走一遍；`Blob.size` 是引用属性，**不把字节读进内存**）。
     *  只返两个标量，不返任何名字 —— 拿不到清单，故**不能**当全库列举用（那是被否决的退化设计）。 */
    usage(prefix) {
      return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, "readonly");
        let bytes = 0, count = 0;
        const c = t.objectStore(STORE).openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) return;
          if (typeof cur.key === "string" && cur.key.startsWith(prefix)) {
            const rec = cur.value;
            if (rec && rec.blob) {
              bytes += rec.blob.size || 0;
              count++;
            }
          }
          cur.continue();
        };
        t.oncomplete = () => resolve({ bytes, count });
        t.onerror = () => reject(t.error);
      }));
    },
    /** 原子改名(同一事务 get→put 新→del 旧):trash/restore/backup 用。源不存在则 noop。 */
    rename(from, to) {
      return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, "readwrite");
        const s = t.objectStore(STORE);
        const g = s.get(from);
        g.onsuccess = () => {
          const v = g.result;
          if (v !== void 0) {
            s.put(v, to);
            s.delete(from);
          }
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }));
    }
  };
}

// ../../20260813 internal-store/src/blob-partition.ts
function createPartitionedBlobStore(dbName) {
  const idb = createIdbCache(dbName);
  const key = (p, name) => `${p}/${name}`;
  function view(p) {
    const prefix = `${p}/`;
    return {
      get: (name) => idb.get(key(p, name)),
      put: (name, rec) => idb.put(key(p, name), rec),
      del: (name) => idb.del(key(p, name)),
      exists: async (name) => await idb.get(key(p, name)) !== void 0,
      keys: async () => (await idb.keys()).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
      usage: () => idb.usage(prefix),
      moveTo: (name, to, toName) => idb.rename(key(p, name), key(to, toName))
    };
  }
  return { partition: view };
}

// ../../20260813 internal-store/src/local-cache.ts
var stripStamp = (inner) => inner.replace(/^[^:]*:/, "");
var stamp = () => asideStamp(Date.now());
function splitKey(k) {
  const slash = k.indexOf("/");
  return slash < 0 ? { part: "trash", inner: k } : { part: k.slice(0, slash), inner: k.slice(slash + 1) };
}
function createLocalCache(dbName) {
  const bs = createPartitionedBlobStore(dbName);
  const files = bs.partition("files");
  const trashP = bs.partition("trash");
  const backupP = bs.partition("backup");
  const dirIdxP = bs.partition("dir-index-cache");
  return {
    // 覆盖写。bytes 归一化成 Blob(契约落 Blob)。
    // ⚠ 曾把 hint.peek 一并写进记录的 .peek 字段——**零 reader**（活的图库缩略图走密文 getPeek），
    //   却对加密件把 256px **明文**缩略图落进了 IDB，违反红线「明文缩略图永不落盘」。字段已删；
    //   hint 仍原样透传给上层作旁路，但 store 不再持久化它的任何解码产物。
    async save(name, bytes, _hint) {
      const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
      await files.put(name, { blob, updatedAt: Date.now() });
    },
    async get(name) {
      const r = await files.get(name);
      return r ? r.blob : null;
    },
    async exists(name) {
      return files.exists(name);
    },
    // 轻量元信息：blob.size 是 Blob 引用属性（不载字节）、updatedAt 存记录里 → 便宜。listing 给本地项填尺寸/时间。
    async stat(name) {
      const r = await files.get(name);
      return r ? { size: r.blob.size, updatedAt: r.updatedAt } : null;
    },
    // 已缓存的应用文件名 = files 分区键（trash/backup/collections 天然隔离在别分区，无需按名过滤）。
    async appKeys() {
      return files.keys();
    },
    // files 分区占用（字节 + 件数）。**不含** trash/backup/collections 分区，也不含纯云端未缓存的文件。
    async usage() {
      return files.usage();
    },
    // 覆盖前留底:复制到 backup 分区(yyyymmddhhmmss-guid 防撞;原件不动)。
    async backup(name) {
      const r = await files.get(name);
      if (!r) throw new Error(`\u672C\u5730\u65E0 ${name},\u65E0\u6CD5\u5907\u4EFD`);
      const inner = `${stamp()}:${name}`;
      await backupP.put(inner, { ...r, updatedAt: Date.now() });
      return `backup/${inner}`;
    },
    async trash(name, deleteEventId) {
      const inner = `${deleteEventId}:${name}`;
      await files.moveTo(name, "trash", inner);
      return `trash/${inner}`;
    },
    async hardDelete(name) {
      await files.del(name);
    },
    async restore(trashKey) {
      const { part, inner } = splitKey(trashKey);
      const orig = stripStamp(inner);
      await (part === "backup" ? backupP : trashP).moveTo(inner, "files", orig);
      return orig;
    },
    async purgeTrash(trashKey) {
      const { part, inner } = splitKey(trashKey);
      await (part === "backup" ? backupP : trashP).del(inner);
    },
    async listTrash() {
      return (await trashP.keys()).map((inner) => ({ trashKey: `trash/${inner}`, name: stripStamp(inner) }));
    },
    // 备份分区列举（形同 listTrash，但 key 带 `backup/` 前缀 → restore/purgeTrash 经 splitKey 认得走 backupP）。
    async listBackup() {
      return (await backupP.keys()).map((inner) => ({ trashKey: `backup/${inner}`, name: stripStamp(inner) }));
    },
    // dir-index-cache：key=夹路径（""=根 → IDB 全键 "dir-index-cache/"），值=JSON 串装 Blob（store 自产自销，本层不解释）。
    async getDirIndexCache(folder) {
      const r = await dirIdxP.get(folder);
      return r ? await r.blob.text() : null;
    },
    async putDirIndexCache(folder, json) {
      await dirIdxP.put(folder, { blob: new Blob([json], { type: "application/json" }), updatedAt: Date.now() });
    }
  };
}
function createStagingStore(dbName) {
  const p = createPartitionedBlobStore(dbName).partition("staging");
  return {
    async get(key) {
      const r = await p.get(key);
      return r ? r.blob : null;
    },
    async put(key, blob) {
      await p.put(key, { blob, updatedAt: Date.now() });
    },
    async del(key) {
      await p.del(key);
    },
    async keys() {
      return p.keys();
    }
  };
}
function createCollectionCache(dbName) {
  const idb = createIdbCache(dbName);
  return {
    async save(name, bytes) {
      const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
      await idb.put(name, { blob, updatedAt: Date.now() });
    },
    async get(name) {
      const r = await idb.get(name);
      return r ? r.blob : null;
    },
    async exists(name) {
      return await idb.get(name) !== void 0;
    }
  };
}

// ../../20260813 internal-store/src/download-session.ts
var EtagChangedError = class extends Error {
  constructor(name) {
    super(`\u4E91\u7AEF\u6587\u4EF6\u5DF2\u66F4\u65B0\uFF0C\u4E0B\u8F7D\u4F1A\u8BDD\u5931\u6548\uFF1A${name}`);
    this.name = "EtagChangedError";
  }
};
var CHUNK_DEFAULT = 2 * 1024 * 1024;
var CAP_DEFAULT = 256 * 1024 * 1024;
var mKey = (name) => `meta:${name}`;
var cKey = (name, i) => `chunk:${name}:${i}`;
function createDownloadSessions(cfg) {
  const { staging, fetchMeta, range, adoptLocal } = cfg;
  const chunkSize = cfg.chunkSize ?? CHUNK_DEFAULT;
  const capBytes = cfg.capBytes ?? CAP_DEFAULT;
  const now = cfg.now ?? (() => Date.now());
  let playbackBusy = 0;
  let playbackIdleWaiters = [];
  const playbackIdle = () => playbackBusy === 0 ? Promise.resolve() : new Promise((r) => playbackIdleWaiters.push(r));
  function playbackDone() {
    playbackBusy--;
    if (playbackBusy === 0) {
      const ws = playbackIdleWaiters;
      playbackIdleWaiters = [];
      for (const w of ws) w();
    }
  }
  let pinChain = Promise.resolve();
  const inflight = /* @__PURE__ */ new Map();
  const activeSessions = /* @__PURE__ */ new Set();
  const sGet = async (k) => {
    try {
      return await staging.get(k);
    } catch (e) {
      reportStoreError(e, "log");
      return null;
    }
  };
  const sPut = async (k, b) => {
    try {
      await staging.put(k, b);
    } catch (e) {
      reportStoreError(e, "log");
    }
  };
  async function readMeta(name) {
    try {
      const b = await sGet(mKey(name));
      if (!b) return null;
      const p = JSON.parse(await b.text());
      return p?.v === 1 && typeof p.eTag === "string" && Array.isArray(p.chunks) ? p : null;
    } catch (e) {
      reportStoreError(e, "log");
      return null;
    }
  }
  async function writeMeta(name, m) {
    await sPut(mKey(name), new Blob([JSON.stringify(m)], { type: "application/json" }));
  }
  async function purgeName(name) {
    try {
      const prefix = `chunk:${name}:`;
      for (const k of await staging.keys()) if (k === mKey(name) || k.startsWith(prefix)) await staging.del(k);
    } catch (e) {
      reportStoreError(e, "log");
    }
  }
  async function enforceCap() {
    try {
      const metas = [];
      for (const k of await staging.keys()) {
        if (!k.startsWith("meta:")) continue;
        const name = k.slice(5);
        const meta = await readMeta(name);
        if (meta) metas.push({ name, meta });
      }
      let total = metas.reduce((s, x) => s + x.meta.chunks.length * x.meta.chunkBytes, 0);
      if (total <= capBytes) return;
      metas.sort((a, b) => a.meta.touchedAt - b.meta.touchedAt);
      for (const { name, meta } of metas) {
        if (total <= capBytes) break;
        if (activeSessions.has(name)) continue;
        await purgeName(name);
        total -= meta.chunks.length * meta.chunkBytes;
      }
    } catch (e) {
      reportStoreError(e, "log");
    }
  }
  async function coverage(name) {
    const m = await readMeta(name);
    if (!m) return null;
    const nChunks = Math.max(1, Math.ceil(m.totalBytes / m.chunkBytes));
    const got = new Set(m.chunks);
    const sizeOf = (i) => Math.min(m.chunkBytes, m.totalBytes - i * m.chunkBytes);
    let bytes = 0;
    for (const i of got) if (i >= 0 && i < nChunks) bytes += sizeOf(i);
    let headBytes = 0;
    for (let i = 0; i < nChunks && got.has(i); i++) headBytes += sizeOf(i);
    return { totalBytes: m.totalBytes, bytes, headBytes, complete: headBytes === m.totalBytes, eTag: m.eTag };
  }
  async function open(name) {
    const cm0 = await fetchMeta(name);
    if (!cm0) return null;
    const { etag, size, item } = cm0;
    const prev = await readMeta(name);
    if (prev && prev.eTag !== etag) await purgeName(name);
    const meta = prev && prev.eTag === etag ? { ...prev, touchedAt: now() } : { v: 1, eTag: etag, totalBytes: size, chunkBytes: chunkSize, chunks: [], touchedAt: now() };
    const got = new Set(meta.chunks);
    await writeMeta(name, meta);
    const nChunks = Math.max(1, Math.ceil(size / chunkSize));
    let closed = false;
    activeSessions.add(name);
    function fetchChunk(i, prio) {
      const key = `${name}:${i}`;
      const existing = inflight.get(key);
      if (existing) return existing;
      const job = (async () => {
        const cached = await sGet(cKey(name, i));
        if (cached) return new Uint8Array(await cached.arrayBuffer());
        if (prio === "pin") await playbackIdle();
        const off = i * chunkSize;
        const len = Math.min(chunkSize, size - off);
        const bytes = await range(item, off, len);
        await sPut(cKey(name, i), new Blob([bytes]));
        if (!got.has(i)) {
          got.add(i);
          meta.chunks = [...got];
          meta.touchedAt = now();
          await writeMeta(name, meta);
        }
        void enforceCap();
        return bytes;
      })();
      inflight.set(key, job);
      job.finally(() => inflight.delete(key)).catch(() => {
      });
      return job;
    }
    function playbackChunk(i) {
      playbackBusy++;
      return fetchChunk(i, "playback").finally(playbackDone);
    }
    function pinChunk(i) {
      const job = pinChain.then(() => fetchChunk(i, "pin"));
      pinChain = job.catch(() => {
      });
      return job;
    }
    const clampRange = (offset, length) => {
      const off = Math.max(0, Math.min(offset, size));
      const len = Math.max(0, Math.min(length, size - off));
      return { i0: Math.floor(off / chunkSize), i1: len === 0 ? -1 : Math.floor((off + len - 1) / chunkSize), off, len };
    };
    const havedBytes = () => [...got].reduce((s, i) => s + Math.min(chunkSize, size - i * chunkSize), 0);
    return {
      name,
      totalSize: size,
      eTag: etag,
      async read(offset, length) {
        if (closed) throw new Error(`\u4F1A\u8BDD\u5DF2\u5173\u95ED\uFF1A${name}`);
        const { i0, i1, off, len } = clampRange(offset, length);
        if (len === 0) return new Uint8Array(0);
        const chunks = await Promise.all(Array.from({ length: i1 - i0 + 1 }, (_, k) => playbackChunk(i0 + k)));
        const out = new Uint8Array(len);
        let written = 0;
        for (let i = i0; i <= i1; i++) {
          const c = chunks[i - i0];
          const chunkStart = i * chunkSize;
          const from = Math.max(off, chunkStart) - chunkStart;
          const to = Math.min(off + len, chunkStart + c.length) - chunkStart;
          out.set(c.subarray(from, to), written);
          written += to - from;
        }
        return out;
      },
      async prefetch(offset, length) {
        if (closed) return;
        const { i0, i1 } = clampRange(offset, length);
        for (let i = i0; i <= i1; i++) {
          try {
            await pinChunk(i);
          } catch (e) {
            reportStoreError(e, "log");
          }
        }
      },
      havedBytes,
      async promote(opts) {
        if (closed) throw new Error(`\u4F1A\u8BDD\u5DF2\u5173\u95ED\uFF1A${name}`);
        for (let i = 0; i < nChunks; i++) {
          if (!got.has(i)) await pinChunk(i);
          opts?.onProgress?.(havedBytes(), size);
        }
        const nowMeta = await fetchMeta(name);
        if (!nowMeta || nowMeta.etag !== etag) {
          await purgeName(name);
          throw new EtagChangedError(name);
        }
        const parts = [];
        for (let i = 0; i < nChunks; i++) {
          const c = await sGet(cKey(name, i));
          parts.push(c ?? new Blob([await pinChunk(i)]));
        }
        const asmSize = parts.reduce((s, p) => s + p.size, 0);
        if (asmSize !== size) {
          await purgeName(name);
          throw new Error(`staging \u7EC4\u88C5\u5C3A\u5BF8\u4E0D\u7B26\uFF08${name}\uFF1A${asmSize}\u2260${size}\uFF09\uFF0C\u5DF2\u6E05\u91CD\u4E0B`);
        }
        await adoptLocal(name, new Blob(parts), etag);
        await purgeName(name);
      },
      close() {
        closed = true;
        activeSessions.delete(name);
      }
    };
  }
  return { open, coverage, purgeName, _enforceCap: enforceCap };
}

// ../../20260813 internal-store/src/kv-namespace.ts
function namespacedKv(kv, ns) {
  if (!ns) throw new Error("namespacedKv: ns \u5FC5\u586B\uFF08${appId}.${databaseId}\uFF09");
  const prefix = `${ns}.`;
  return {
    get: (k) => kv.get(prefix + k),
    set: (k, v) => kv.set(prefix + k, v),
    remove: (k) => kv.remove(prefix + k),
    keys: () => (kv.keys?.() ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
  };
}

// ../../20260813 internal-store/src/migration.ts
function parseSchemaVersion(v) {
  const m = /^v(\d{3,})-(\d{8})$/.exec(v);
  if (!m) return null;
  return { seq: Number(m[1]), date: m[2] };
}
function needsMigration(current2, target) {
  const t = parseSchemaVersion(target);
  if (!t) throw new Error(`\u975E\u6CD5 target schema \u7248\u672C\u6233: ${target}`);
  if (current2 == null) return true;
  const c = parseSchemaVersion(current2);
  if (!c) return true;
  return c.seq < t.seq;
}
function storeNamespace(appId, databaseId) {
  if (!appId) throw new Error("storeNamespace: appId \u5FC5\u586B\u2014\u2014\u540C origin \u5144\u5F1F PWA \u9694\u79BB\u7684\u7EA2\u7EBF\uFF0C\u4E0D\u7ED9\u4F1A\u5171\u7528\u4E00\u4E2A\u5E93");
  if (!databaseId) throw new Error("storeNamespace: databaseId \u5FC5\u586B\u2014\u2014\u540C app \u591A store \u5B9E\u4F8B\u9694\u79BB\uFF08\u9ED8\u8BA4 defaultStore\uFF09");
  const root = `${appId}.${databaseId}`;
  return { root, dbName: root, schemaKey: "database-version" };
}
var MIGRATIONS = [];
async function runMigrations(ctx, migrations = MIGRATIONS) {
  for (const m of migrations) {
    if (!needsMigration(ctx.kv.get(ctx.ns.schemaKey), m.version)) continue;
    ctx.log?.(`[migration] \u2192 ${m.version}: ${m.describe}`);
    await m.run(ctx);
    ctx.kv.set(ctx.ns.schemaKey, m.version);
  }
}
function localStorageMigrationKv() {
  const ls = globalThis.localStorage;
  if (!ls) throw new Error("localStorageMigrationKv: \u65E0 localStorage");
  return {
    get: (k) => ls.getItem(k),
    set: (k, v) => ls.setItem(k, v),
    remove: (k) => ls.removeItem(k),
    keys: () => Object.keys(ls)
  };
}
async function runStoreMigrations(appId, databaseId, log2) {
  const ns = storeNamespace(appId, databaseId);
  const kv = namespacedKv(localStorageMigrationKv(), ns.root);
  await runMigrations({ kv, ns, log: log2 });
}

// ../../20260813 internal-store/src/zip-peek.ts
var SIG_EOCD = 101010256;
var SIG_CD = 33639248;
var SIG_LOCAL = 67324752;
var LOCAL_HEADER_EXTRA_SLACK = 4096;
function tailStart(src) {
  return src.totalSize - src.tail.length;
}
async function readAbs(src, off, len) {
  if (len <= 0) return new Uint8Array(0);
  const ts = tailStart(src);
  if (off >= ts && off + len <= src.totalSize) {
    const s = off - ts;
    return src.tail.subarray(s, s + len);
  }
  return await src.range(off, len);
}
function findEOCD(tail) {
  if (tail.length < 22) return -1;
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) !== SIG_EOCD) continue;
    const commentLen = dv.getUint16(i + 20, true);
    if (i + 22 + commentLen === tail.length) return i;
  }
  return -1;
}
function parseCD(cd) {
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length) {
    if (dv.getUint32(p, true) !== SIG_CD) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, nameLen, localOff });
    p += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}
async function readCentralDirectory(src) {
  const eocd = findEOCD(src.tail);
  if (eocd < 0) return null;
  const dv = new DataView(src.tail.buffer, src.tail.byteOffset, src.tail.byteLength);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdSize <= 0 || cdOffset + cdSize > src.totalSize) return null;
  const cd = await readAbs(src, cdOffset, cdSize);
  if (!cd || cd.length < cdSize) return null;
  return parseCD(cd);
}
async function inflate(raw, method) {
  if (method === 0) return raw.slice();
  if (method === 8) {
    if (typeof DecompressionStream === "undefined") return null;
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return null;
}
async function readEntryBytes(src, entry) {
  const guess = 30 + entry.nameLen + LOCAL_HEADER_EXTRA_SLACK + entry.compSize;
  const chunk = await readAbs(src, entry.localOff, Math.min(guess, src.totalSize - entry.localOff));
  if (!chunk || chunk.length < 30) return null;
  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (dv.getUint32(0, true) !== SIG_LOCAL) return null;
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const dataStart = 30 + nameLen + extraLen;
  let raw;
  if (dataStart + entry.compSize <= chunk.length) {
    raw = chunk.subarray(dataStart, dataStart + entry.compSize);
  } else {
    raw = await readAbs(src, entry.localOff + dataStart, entry.compSize);
  }
  if (!raw) return null;
  return await inflate(raw, entry.method);
}

// ../../20260813 internal-store/src/create-store.ts
var ReadOnlyFilesError = class extends Error {
  constructor(op) {
    super(`\u53EA\u8BFB\u955C\u50CF\uFF1Afiles \u9762\u4E0D\u53EF\u5199\uFF08${op}\uFF09`);
    this.name = "ReadOnlyFilesError";
  }
};
function localStorageKv() {
  const ls = globalThis.localStorage;
  if (!ls) throw new Error("createStore: \u65E0 localStorage\uFF0C\u8BF7\u6CE8\u5165 kv");
  return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), remove: (k) => ls.removeItem(k), keys: () => Object.keys(ls) };
}
function createStore(config) {
  const { provider: provider2, ui, appId, databaseId = "defaultStore", kv: rawKv = localStorageKv(), validateAdopt, autoCacheOpenedFile = true } = config;
  const roGuard = (op) => {
    if (config.readOnlyFiles) throw new ReadOnlyFilesError(op);
  };
  if (!appId) throw new Error("createStore: appId \u5FC5\u586B\u2014\u2014\u540C origin \u5144\u5F1F PWA \u9694\u79BB\u7684\u7EA2\u7EBF\uFF08\u6BCF\u4E2A app \u5EFA\u81EA\u5DF1\u7684 IDB \u5E93\uFF09");
  setStoreErrorReporter((err, level) => ui.reportError(err, level));
  const ns = storeNamespace(appId, databaseId);
  const kv = namespacedKv(rawKv, ns.root);
  const local = config.local ?? createLocalCache(ns.dbName);
  const collectionLocal = config.local ?? createCollectionCache(ns.dbName);
  const isOnline = config.isOnline ?? (() => globalThis.navigator?.onLine !== false);
  const getPassword = config.crypt?.getPassword ?? config.getPassword ?? (() => null);
  if (config.crypto) configureCryptoCodec(config.crypto);
  const cloud = createCloudSync({ provider: provider2, kv, fileName: config.fileName ?? ((n) => n), encFileName: config.encFileName ?? ((n) => `${n}.zip`), appKey: "files", manageDirty: false });
  const collectionsCloud = createCloudSync({ provider: provider2, kv, fileName: (n) => `.${appId}/${n}.json`, appKey: "collections" });
  const sub = createSubstrate();
  const head = createLocalHead({
    kv,
    getCloudEtag: (n) => cloud.getETag(n),
    setCloudEtag: (n, e) => cloud.setETag(n, e),
    // 采纳云版时提交 durable etag（见 local-head.markSynced 注释：合 R1，非违规）
    keyPrefix: "files"
  });
  const migrationReady = config.skipMigration || !globalThis.localStorage ? Promise.resolve() : runStoreMigrations(appId, databaseId);
  const offloadMod = createOffload({ cloud, local, head, isOnline, serialize: sub.serialize });
  const CLOUD_GONE_GRACE_MS = 24 * 3600 * 1e3;
  const pendingGone = createPendingGone(kv, config.cloudGoneGraceMs ?? CLOUD_GONE_GRACE_MS);
  const reconcileMod = createReconcile({ cloud, local, head, pending: pendingGone, isOnline, activeFileName: config.activeFileName });
  const stagingStore = config.staging ?? createStagingStore(ns.dbName);
  const toU8Raw = async (raw) => raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(await raw.arrayBuffer());
  const sessions = createDownloadSessions({
    staging: stagingStore,
    fetchMeta: async (name) => {
      const m = await cloud.fetchMeta(name);
      return m ? { etag: m.etag, size: m.size, item: m.item } : null;
    },
    // 分片直连 provider.downloadRange（item.id 已在开会话时解析——不每分片重走 metadata 往返）。
    range: async (item, offset, length) => toU8Raw(await provider2.downloadRange(item.id, offset, length)),
    // promote 落地：对齐 identity.acquire 语义（serialize 锁 + markSynced）；已有副本/dirty 绝不覆盖（§A）。
    adoptLocal: (name, blob, etag) => sub.serialize(name, async () => {
      if (await local.exists(name)) return false;
      if (head.isDirty(name)) return false;
      await local.save(name, blob);
      head.markSynced(name, etag);
      notifyFolderOf(name);
      return true;
    }),
    chunkSize: config.stagingChunkBytes,
    capBytes: config.stagingCapBytes
  });
  const FOLDERS_PENDING_KEY = "internal.pending_new_folders";
  const readPending = () => {
    try {
      const v = JSON.parse(kv.get(FOLDERS_PENDING_KEY) ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const writePending = (a) => kv.set(FOLDERS_PENDING_KEY, JSON.stringify([...new Set(a)]));
  const addPendingFolder = (p) => writePending([...readPending(), p]);
  const clearPendingFolder = (p) => writePending(readPending().filter((x) => x !== p));
  async function ensureFolderLocalFirst(path) {
    assertValidFileName(path, appId);
    cancelFolderDeletionForDescendant(path);
    addPendingFolder(path);
    if (isOnline()) {
      try {
        await cloud.ensureFolder(path);
        clearPendingFolder(path);
      } catch {
      }
    }
  }
  async function drainFolders() {
    if (!isOnline()) return;
    for (const p of readPending()) {
      try {
        await cloud.ensureFolder(p);
        clearPendingFolder(p);
      } catch {
      }
    }
  }
  const FOLDER_DEL_KEY = "internal.pending_folder_deletions";
  const readFolderDel = () => {
    try {
      const v = JSON.parse(kv.get(FOLDER_DEL_KEY) ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const writeFolderDel = (a) => {
    const s = [...new Set(a)];
    if (s.length) kv.set(FOLDER_DEL_KEY, JSON.stringify(s));
    else kv.remove(FOLDER_DEL_KEY);
  };
  const enqueueFolderDel = (p) => writeFolderDel([...readFolderDel(), p]);
  const dequeueFolderDel = (p) => writeFolderDel(readFolderDel().filter((x) => x !== p));
  function cancelFolderDeletionForDescendant(path) {
    const q = readFolderDel();
    const keep = q.filter((f) => !(path === f || path.startsWith(`${f}/`)));
    if (keep.length !== q.length) {
      writeFolderDel(keep);
      for (const f of q) if (!keep.includes(f)) notifyFolderOf(f);
    }
  }
  async function drainFolderDeletions() {
    if (!isOnline()) return;
    const q = readFolderDel().sort((a, b) => b.split("/").length - a.split("/").length);
    for (const p of q) {
      let r;
      try {
        r = await cloud.deleteEmptyFolder(p);
      } catch (e) {
        ui.reportError(e, "warning");
        continue;
      }
      if (r.status === "list-failed") continue;
      dequeueFolderDel(p);
      notifyFolderOf(p);
    }
  }
  async function drainOfflineQueue() {
    await drainFolders();
    await uploadReplay.drain();
    await del.drainDeleteQueue();
    await drainFolderDeletions();
  }
  const listing = createListing({ cloud, local, head, pendingFolders: readPending, isPendingGone: (p) => pendingGone.isPending(p), pendingFolderDeletions: readFolderDel });
  const signedIn = config.signedIn ?? (() => true);
  const ctxNow = () => ({ signedIn: signedIn(), online: isOnline() });
  const LOCAL_CTX = { signedIn: false, online: false };
  const folderWatchers = /* @__PURE__ */ new Map();
  const SNAP_V = 1;
  async function readDirIndexCache(folder) {
    if (!local.getDirIndexCache) return null;
    try {
      const raw = await local.getDirIndexCache(folder);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (p?.v !== SNAP_V || !Array.isArray(p.files) || !Array.isArray(p.folders)) return null;
      return p;
    } catch (e) {
      ui.reportError(e, "log");
      return null;
    }
  }
  function writeDirIndexCache(folder, live) {
    if (!local.putDirIndexCache || !live.complete) return;
    const files = live.files.filter((c) => !isHidden(c.name)).map((c) => ({ name: c.name, eTag: c.eTag, size: c.size, lastModified: toMs(c.lastModifiedDateTime), id: c.id }));
    const folders = live.folders.filter((f) => !isHidden(f));
    void local.putDirIndexCache(folder, JSON.stringify({ v: SNAP_V, folder, savedAt: Date.now(), files, folders })).catch((e) => ui.reportError(e, "log"));
  }
  function emitFolder(folder, snap) {
    if (snap.path !== folder) {
      ui.reportError(new Error(`watchFolder \u8DEF\u5F84\u9519\u4E71\uFF1A\u8BA2\u9605\u300C${folder}\u300D\u6536\u5230\u300C${snap.path}\u300D\uFF0C\u5DF2\u4E22\u5F03`));
      return;
    }
    const set = folderWatchers.get(folder);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(snap);
      } catch (e) {
        ui.reportError(e);
      }
    }
  }
  async function localFrameSnap(folder) {
    const stale = signedIn() ? await readDirIndexCache(folder) : null;
    return listing.listFolder(folder, LOCAL_CTX, stale ? { staleCloud: stale } : void 0);
  }
  async function pushLocalFrame(folder) {
    if (!folderWatchers.has(folder)) return;
    try {
      emitFolder(folder, await localFrameSnap(folder));
    } catch (e) {
      ui.reportError(e);
    }
  }
  async function pushRemoteFrame(folder) {
    if (!folderWatchers.has(folder)) return;
    void ensureScaffold();
    const ctx = ctxNow();
    const live = ctx.online && ctx.signedIn ? await cloud.listFolder(folder).catch((e) => {
      ui.reportError(e, "log");
      return null;
    }) : null;
    await reconcileMod.reconcileFolder(folder, { cloudPrefetched: live }).catch((e) => ui.reportError(e));
    try {
      emitFolder(folder, await listing.listFolder(folder, ctx, { cloudPrefetched: live }));
    } catch (e) {
      ui.reportError(e);
    }
    if (live?.complete) writeDirIndexCache(folder, live);
  }
  function notifyFolderOf(name) {
    void pushLocalFrame(name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");
  }
  function watchFolder(folder, cb) {
    if (folder) assertValidFileName(folder, appId);
    let set = folderWatchers.get(folder);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      folderWatchers.set(folder, set);
    }
    set.add(cb);
    void (async () => {
      await migrationReady;
      try {
        cb(await localFrameSnap(folder));
      } catch (e) {
        ui.reportError(e);
      }
      await pushRemoteFrame(folder);
    })();
    return () => {
      const s = folderWatchers.get(folder);
      if (s) {
        s.delete(cb);
        if (!s.size) folderWatchers.delete(folder);
      }
    };
  }
  async function nameOccupied(name) {
    if (await local.exists(name)) return "local";
    if (isOnline()) {
      try {
        if (await cloud.fetchMeta(name)) return "cloud";
      } catch {
      }
    }
    return null;
  }
  const seal = createSeal({
    looksContainer: (b) => looksEncryptedContainer(b),
    pack: (o) => packContainer({ dataBytes: o.dataBytes, fileName: o.fileName, ext: o.ext, peek: o.peek, password: o.password }),
    unpack: (blob, pw) => unpackContainer(blob, pw),
    getPassword,
    getPrev: (n) => local.get(n),
    makePeek: config.crypt?.makePeek,
    // 明文→peek（app 域，如 ora 缩略图）；不给 → 容器无 peek
    ext: config.crypt?.ext
    // 真扩展名 → meta.bin
  });
  const safeResolve = createSafeResolve({
    cloud,
    local,
    head,
    localDirty: () => sub.edits.localDirty(),
    validateAdopt,
    unseal: (n, blob) => seal.unsealForRead(n, blob),
    // 返明文；加密但锁定 → null（safePull 退验封套）
    looksEncrypted: (b) => looksEncryptedContainer(b)
  });
  const pushMod = createPush({ cloud, head, seal, safeResolve, serialize: sub.serialize, editVersion: () => sub.edits.version(), busy: ui.busy });
  const uploadReplayPolicy = config.offlineUploadReplay ?? "manual";
  if (uploadReplayPolicy !== "manual") {
    if (!ui.onReplayStatus) throw new Error("createStore: offlineUploadReplay\u2260'manual' \u9700 ui.onReplayStatus\uFF08ADR-0018 \u5F3A\u5236 UI \u63D0\u793A\uFF09");
    if (uploadReplayPolicy === "ask" && !ui.confirmReplay) throw new Error("createStore: offlineUploadReplay='ask' \u9700 ui.confirmReplay\uFF08\u56DE\u7EBF\u8BE2\u95EE\u7528\u6237\uFF09");
  }
  const pushBg = createPush({ cloud, head, seal, safeResolve, serialize: sub.serialize, editVersion: () => sub.edits.version(), busy: (_l, fn) => fn() });
  async function pushLocalBytes(name) {
    const blob = await local.get(name);
    if (!blob) return { status: "no-local" };
    const asBlob = blob instanceof Blob ? blob : new Blob([blob]);
    const plain = await seal.unsealForRead(name, asBlob);
    if (!plain) return { status: "locked" };
    const plainU8 = await toU8(plain);
    return pushBg.doPush(name, { encode: () => plainU8 });
  }
  const uploadReplay = createUploadReplay({
    kv,
    local,
    head,
    isOnline,
    serialize: sub.serialize,
    pushLocal: pushLocalBytes,
    policy: uploadReplayPolicy,
    confirm: ui.confirmReplay,
    onStatus: ui.onReplayStatus
  });
  const fresh = createFreshness({ cloud, head, safeResolve, busy: ui.busy });
  const del = createDelete({ cloud, local, head, kv, busy: ui.busy });
  const identity = createIdentity({
    cloud,
    local,
    head,
    doPush: pushMod.doPush,
    serialize: sub.serialize,
    serialize2: sub.serialize2,
    seal,
    busy: ui.busy,
    // 离线 move = 删+建（决策 1A/2）：在线走 identity 内的服务端原子 move；离线降级，复用 del.del 离线删 + uploadReplay 补推。
    isOnline,
    deleteOffline: (name) => del.del(name, { isOnline }).then(() => {
    }),
    // 完整离线删语义（move-aside + base-etag 云删排队 + null 守卫 + forget）
    queueUpload: (name) => uploadReplay.enqueue(name),
    // never-synced float 重连补推（ADR-0018）
    nameOccupied
    // 唯一占用检查（assertNameFree 据此抛）
  });
  const trashMod = createTrash({ cloud, local, head, busy: ui.busy });
  async function aggregateBox(box) {
    const cloudItems = await (box === "trash" ? cloud.listTrash() : cloud.listBackup());
    const localItems = box === "trash" ? local.listTrash ? await local.listTrash() : [] : local.listBackup ? await local.listBackup() : [];
    let live = /* @__PURE__ */ new Set();
    if (box === "trash" && localItems.length && isOnline()) {
      const all = await cloud.listAll().catch(() => null);
      if (all && all.complete) live = new Set(all.files.map((f) => f.name ?? f.path));
    }
    return mergeTrash(localItems, cloudItems, live);
  }
  let _userWriteInFlight = null;
  function singleFlight(label, fn) {
    return (...a) => {
      if (_userWriteInFlight) {
        const e = new Error(`\u6709\u53E6\u4E00\u9879\u64CD\u4F5C\u8FDB\u884C\u4E2D\uFF08${_userWriteInFlight}\uFF09\uFF0C\u8BF7\u7B49\u5B83\u5B8C\u6210\u518D\u8BD5`);
        e.code = "STORE_BUSY";
        return Promise.reject(e);
      }
      _userWriteInFlight = label;
      return Promise.resolve().then(() => fn(...a)).finally(() => {
        _userWriteInFlight = null;
      });
    };
  }
  const delSF = singleFlight("\u5220\u9664", (n) => {
    uploadReplay.remove(n);
    return del.del(n, { isOnline });
  });
  const tryMoveSF = singleFlight("\u79FB\u52A8", async (from, to) => {
    const occ = await nameOccupied(to);
    if (occ) return { ok: false, reason: "name-collision", where: occ };
    const r = await identity.rename(from, to, { skipOccupiedCheck: true });
    notifyFolderOf(from);
    notifyFolderOf(to);
    return { ok: true, where: r.where, oldKept: r.oldKept, oldUnknown: r.oldUnknown, oldCloudOrphan: r.oldCloudOrphan, cloudDeferred: r.cloudDeferred, oldName: from };
  });
  const onConflict = async ({ name }) => {
    const [localBlob, cloudPull] = await Promise.all([local.get(name), cloud.pull(name).catch(() => null)]);
    return ui.resolveConflict({ name, local: localBlob, cloud: cloudPull?.blob ?? null });
  };
  async function encTailBytes(name, n, tryCloud) {
    const blob = await local.get(name);
    if (blob) {
      const b = blob instanceof Blob ? blob : new Blob([blob]);
      return b.slice(Math.max(0, b.size - n));
    }
    if (tryCloud && cloud.pullTail) {
      const t = await cloud.pullTail(name, n);
      return t ? new Blob([t.bytes]) : null;
    }
    return null;
  }
  async function openPeekSource(name, n) {
    const blob = await local.get(name);
    if (blob) {
      const b = blob instanceof Blob ? blob : new Blob([blob]);
      const total = b.size;
      const tail = new Uint8Array(await b.slice(Math.max(0, total - n)).arrayBuffer());
      return { totalSize: total, tail, range: async (off, len) => new Uint8Array(await b.slice(off, off + len).arrayBuffer()) };
    }
    if (cloud.pullTail) {
      const t = await cloud.pullTail(name, n);
      if (!t) return null;
      const tail = t.bytes instanceof Uint8Array ? t.bytes : new Uint8Array(t.bytes);
      const total = t.item.size || tail.length;
      return {
        totalSize: total,
        tail,
        range: async (off, len) => {
          const r = cloud.pullRange ? await cloud.pullRange(name, off, len) : null;
          return r ? r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes) : null;
        }
      };
    }
    return null;
  }
  async function decryptEncPeek(name, encPeek) {
    if (encPeek.type !== ENC_PEEK_MIME) return encPeek;
    const parsed = scanEncPeekFromEnd(new Uint8Array(await encPeek.arrayBuffer()));
    if (!parsed) return null;
    const plain = await seal.withPassword(name, (pw) => decryptPeek(parsed, pw));
    return plain ? new Blob([plain]) : null;
  }
  async function encVerify(name, pw) {
    if (!pw) return false;
    const tail = await encTailBytes(name, PEEK_TAIL_WINDOW, true);
    if (tail) {
      const p = scanEncPeekFromEnd(new Uint8Array(await tail.arrayBuffer()));
      if (p) {
        try {
          await decryptPeek(p, pw);
          return true;
        } catch {
          return false;
        }
      }
    }
    const full = await local.get(name);
    if (!full) return false;
    try {
      await unpackContainer(full instanceof Blob ? full : new Blob([full]), pw);
      return true;
    } catch {
      return false;
    }
  }
  async function encIsEncrypted(name) {
    const blob = await local.get(name);
    return blob ? looksEncryptedContainer(blob instanceof Blob ? blob : new Blob([blob])) : false;
  }
  async function encSwap(name, bytes, online, encrypted) {
    const prevEtag = cloud.getETag(name);
    const tracked = prevEtag != null;
    if (tracked && !online()) return { status: "offline" };
    await local.save(name, bytes);
    if (!tracked) return { status: "swapped" };
    try {
      const { item } = await cloud.push(name, bytes, { baseEtag: head.seenBase(name), encrypted });
      if (!(item && item.eTag)) {
        head.onPushed(name, prevEtag, true);
        return { status: "cloud-deferred" };
      }
      head.onPushed(name, item.eTag, false);
      return { status: "swapped" };
    } catch (e) {
      head.onPushed(name, prevEtag, true);
      return { status: e?.name === "CloudConflictError" ? "conflict" : "cloud-deferred" };
    }
  }
  async function encEncrypt(name, online) {
    return ui.busy(`\u6B63\u5728\u52A0\u5BC6 ${name}\u2026`, () => sub.serialize(name, async () => {
      const blob = await local.get(name);
      if (!blob) return { status: "no-local" };
      const asBlob = blob instanceof Blob ? blob : new Blob([blob]);
      if (await looksEncryptedContainer(asBlob)) return { status: "already" };
      if (cloud.getETag(name) != null && !online()) return { status: "offline" };
      const pw = getPassword(name);
      if (!pw) return { status: "locked" };
      let peek = null;
      if (config.crypt?.makePeek) {
        try {
          peek = await config.crypt.makePeek(asBlob);
        } catch {
          peek = null;
        }
      }
      const container = await packContainer({ dataBytes: await toU8(asBlob), fileName: name, ext: config.crypt?.ext, peek, password: pw });
      return await encSwap(name, await toU8(container), online, true);
    }));
  }
  async function encDecrypt(name, online) {
    return ui.busy(`\u6B63\u5728\u89E3\u9664\u52A0\u5BC6 ${name}\u2026`, () => sub.serialize(name, async () => {
      const blob = await local.get(name);
      if (!blob) return { status: "no-local" };
      const asBlob = blob instanceof Blob ? blob : new Blob([blob]);
      if (!await looksEncryptedContainer(asBlob)) return { status: "not-encrypted" };
      if (cloud.getETag(name) != null && !online()) return { status: "offline" };
      const res = await seal.withPassword(name, (pw) => unpackContainer(asBlob, pw));
      if (!res) return { status: "locked" };
      return await encSwap(name, await toU8(res.dataBlob), online, false);
    }));
  }
  function makeRaw(name, mode2 = "existing") {
    let _createChecked = mode2 !== "new";
    const readLocal = async () => {
      const blob = await local.get(name);
      if (!blob) return null;
      const asBlob = blob instanceof Blob ? blob : new Blob([blob]);
      return await seal.unsealForRead(name, asBlob);
    };
    return {
      async save(bytes, opts) {
        roGuard("save");
        await migrationReady;
        if (!_createChecked) {
          _createChecked = true;
          const where = await nameOccupied(name);
          if (where) throw new CloudNameCollisionError(name, where);
        }
        head.recordEdit(name);
        pendingGone.clear(name);
        cancelFolderDeletionForDescendant(name);
        const plain = await toU8(bytes);
        const sealed = await seal.sealForWrite(name, plain);
        await sub.serialize(name, () => local.save(name, sealed, opts?.hint));
        notifyFolderOf(name);
        if (opts?.tryPush === false) return { pushed: false, reason: "not-attempted" };
        let pushed = false, reason;
        try {
          const r = await pushMod.push(name, { encode: () => plain, onConflict, surfaceCollision: mode2 !== "new" });
          pushed = r.status === "pushed" || r.status === "healed" || r.status === "resolved";
          if (!pushed) reason = r.status;
        } catch (e) {
          ui.reportError(e);
          reason = "error";
        }
        if (head.isDirty(name) && head.seenBase(name) == null) uploadReplay.enqueue(name);
        return { pushed, reason };
      },
      async open() {
        await migrationReady;
        if (await local.exists(name)) {
          const esc = isOnline() ? ui.offlineEscape?.() : void 0;
          try {
            await fresh.open(name, { isOnline, probe: esc?.probe }).catch((e) => ui.reportError(e));
          } finally {
            esc?.settle();
          }
          return readLocal();
        }
        if (autoCacheOpenedFile) {
          const esc = isOnline() ? ui.offlineEscape?.() : void 0;
          const pulling = identity.acquire(name, { localName: name }).catch((e) => {
            ui.reportError(e);
            return null;
          });
          try {
            await (esc ? Promise.race([pulling, esc.probe]) : pulling);
          } finally {
            esc?.settle();
          }
          return readLocal();
        }
        const pulled = await cloud.pull(name).catch((e) => {
          ui.reportError(e);
          return null;
        });
        return pulled ? await seal.unsealForRead(name, pulled.blob) : null;
      },
      pullIfClean(opts) {
        return fresh.refresh(name, { isOnline, ...opts });
      },
      // 事件驱动干净快进（clean→FF、dirty→no-op）；默认注入 store 的 isOnline（离线早退，不空跑 fetchMeta）
      tryMove(to) {
        roGuard("tryMove");
        return tryMoveSF(name, to);
      },
      async delete() {
        roGuard("delete");
        const r = await delSF(name);
        notifyFolderOf(name);
        return r;
      },
      // 返 DelResult（v436）：cancelled/noop/queuedCloudDelete 都不是「已删除」
      reupload() {
        roGuard("reupload");
        return ui.busy("\u91CD\u65B0\u4E0A\u4F20\u2026", async () => {
          if (!await local.exists(name)) return { status: "no-local" };
          pendingGone.clear(name);
          head.forget(name);
          head.recordEdit(name);
          const r = await pushLocalBytes(name);
          if (!head.isDirty(name)) {
            pendingGone.clear(name);
            notifyFolderOf(name);
          }
          return r;
        });
      },
      isKeptOffline() {
        return local.exists(name);
      },
      // 有本地副本 = 已留作离线（无 LRU、无独立 pin flag）
      stagingCoverage() {
        return sessions.coverage(name);
      },
      // A5 透明面：只读账本，零网络（离线徽章/护栏用）
      async keepOffline(opts) {
        if (await local.exists(name)) return;
        const runOnce = async () => {
          const sess = await sessions.open(name);
          if (!sess) return;
          try {
            await sess.promote({ onProgress: opts?.onProgress });
          } finally {
            sess.close();
          }
        };
        try {
          await runOnce();
        } catch (e) {
          if (e instanceof EtagChangedError) {
            try {
              await runOnce();
              return;
            } catch (e2) {
              ui.reportError(e2);
              return;
            }
          }
          ui.reportError(e);
        }
      },
      async openStream() {
        await migrationReady;
        const blob = await local.get(name);
        if (blob) {
          const b = blob instanceof Blob ? blob : new Blob([blob]);
          return {
            totalSize: b.size,
            read: async (off, len) => new Uint8Array(await b.slice(Math.max(0, off), Math.min(b.size, Math.max(0, off) + Math.max(0, len))).arrayBuffer()),
            prefetch: async () => {
            },
            keep: async () => {
            },
            close: () => {
            }
          };
        }
        const sess = await sessions.open(name).catch((e) => {
          ui.reportError(e, "log");
          return null;
        });
        if (!sess) return null;
        return {
          totalSize: sess.totalSize,
          read: (off, len) => sess.read(off, len),
          prefetch: (off, len) => sess.prefetch(off, len),
          keep: (o) => sess.promote({ onProgress: o?.onProgress }),
          close: () => sess.close()
        };
      },
      async offload() {
        await offloadMod.offload(name);
        notifyFolderOf(name);
      },
      // 成功后重画本夹（badge 即时 → cloud-only）
      isEncrypted() {
        return encIsEncrypted(name);
      },
      encrypt(opts) {
        roGuard("encrypt");
        return encEncrypt(name, opts?.isOnline ?? isOnline);
      },
      decrypt(opts) {
        roGuard("decrypt");
        return encDecrypt(name, opts?.isOnline ?? isOnline);
      },
      verifyPassword(pw) {
        return encVerify(name, pw);
      }
    };
  }
  function file(name, opts) {
    assertValidFileName(name, appId);
    const raw = makeRaw(name, opts.mode);
    if (!opts.isZip) return raw;
    const getPeek = async (o) => {
      const src = await openPeekSource(name, o.bytesLength);
      if (!src) return null;
      const entries = await readCentralDirectory(src);
      if (!entries) return null;
      const encEntry = entries.find((e) => CONTAINER_PEEK_ENTRIES.includes(e.name));
      if (encEntry) {
        const bytes2 = await readEntryBytes(src, encEntry);
        return bytes2 ? new Blob([bytes2], { type: ENC_PEEK_MIME }) : null;
      }
      const target = entries.find((e) => e.name === o.zipEntry);
      if (!target) return null;
      const bytes = await readEntryBytes(src, target);
      return bytes ? new Blob([bytes]) : null;
    };
    const decryptPeekFn = (encPeek) => decryptEncPeek(name, encPeek);
    const getEncryptedBlob = async () => {
      const blob = await local.get(name);
      if (!blob) return null;
      const asBlob = blob instanceof Blob ? blob : new Blob([blob]);
      if (!await looksEncryptedContainer(asBlob)) return null;
      return asBlob;
    };
    return Object.assign(raw, { getPeek, decryptPeek: decryptPeekFn, getEncryptedBlob });
  }
  const _scaffoldNames = /* @__PURE__ */ new Set();
  const _scaffoldEnsured = /* @__PURE__ */ new Set();
  async function ensureScaffold() {
    if (!isOnline() || !signedIn() || _scaffoldEnsured.size >= _scaffoldNames.size) return;
    await migrationReady;
    try {
      await collectionsCloud.ensureFolder(`.${appId}`);
    } catch (e) {
      ui.reportError(e);
      return;
    }
    for (const name of _scaffoldNames) {
      if (_scaffoldEnsured.has(name)) continue;
      try {
        if (!await collectionsCloud.fetchMeta(name).catch(() => null))
          await collectionsCloud.push(name, emptyCollectionBytes(), { baseEtag: null });
        _scaffoldEnsured.add(name);
      } catch (e) {
        ui.reportError(e);
      }
    }
  }
  function registerScaffold(name) {
    _scaffoldNames.add(name);
    void ensureScaffold();
  }
  const _collections = /* @__PURE__ */ new Map();
  function collection(name, opts = {}) {
    assertValidCollectionName(name);
    const cached = _collections.get(name);
    if (cached) return cached;
    const coll = createCollection({ cloud: collectionsCloud, name, local: collectionLocal, manual: opts.manual, cloudless: opts.local, getInitData: opts.getInitData });
    if (!opts.local) registerScaffold(name);
    _collections.set(name, coll);
    return coll;
  }
  return {
    // ── file + collection。改身份走 file.tryMove(to)。──
    /** 文件对象工厂（含 tryMove/pullIfClean/save/open/delete/reupload…）。 */
    file,
    /** collection 工厂（app schema 全局单例；设置/状态全走它）。 */
    collection,
    // ── files 命名空间。不暴露 list/listAll/localKeys（app 只放当前夹于内存；名字碰撞由 file.tryMove/mode:"new"
    //   内化检测，不靠「先 list 目标夹」；全库 listAll 仅库内 reconcile 用）。──
    /** 所有「不挂在单个 file 上」的文件域操作（列举订阅 / 文件夹增删 / 离线队列 / 回收站备份箱 / 名字占用 / 全库收敛）。
     *  **唯一列举面 = files.watchFolder（订阅当前夹）**：立即本地帧、云端到了同一 cb 再闪。 */
    files: {
      /** 名字占用（**boolean**）：在线云端+本地都看，离线只看本地（靠 push conflictBehavior:fail 兜底）。app 新建/另存/改名前预检。 */
      nameOccupied: (name) => nameOccupied(name).then((o) => o != null),
      /** 订阅**一个**文件夹（网盘模型）：立即本地帧 + 云端帧同一 cb 再闪；之后本夹任何本地写即时重推本地帧。返回退订。 */
      watchFolder,
      //   一次本地 IDB cursor（无网络），但仍是全表走一遍 → app 只在图库打开/刷新时调，别挂每帧。
      /** 本地已缓存文件的总占用（字节 + 件数），给 app 显示「本地存了多少」。**口径**：只量本库 files 分区，
       *  **不含** trash/backup/collections 分区、app 自己别的 IDB 库、纯云端未缓存的作品。
       *  ⚠ **只返两个标量、永不返名字** —— 它不是、也不能变成全库列举（列举唯一面 = watchFolder）。 */
      usage: () => local.usage(),
      /** 确保文件夹存在。**离线也能建**（本地登记 + 回线 drainOfflineQueue 补建）。 */
      ensureFolder: (path) => {
        roGuard("ensureFolder");
        return ensureFolderLocalFirst(path);
      },
      /** 新建空文件夹（gallery folder-tree；离线也能建，回线补建）。 */
      newFolder: singleFlight("\u65B0\u5EFA\u6587\u4EF6\u5939", (path) => {
        roGuard("newFolder");
        return ui.busy("\u65B0\u5EFA\u6587\u4EF6\u5939\u2026", async () => {
          await ensureFolderLocalFirst(path);
          notifyFolderOf(path);
        });
      }),
      // 子夹出现在父夹 → 重画父夹
      /** 删除**空**文件夹——「必须证实为空」库内强制（两端判空；非空/无法确认 → 抛错拒删）。 */
      deleteFolder: singleFlight("\u5220\u9664\u6587\u4EF6\u5939", (path) => {
        roGuard("deleteFolder");
        return ui.busy("\u5220\u9664\u6587\u4EF6\u5939\u2026", async () => {
          assertValidFileName(path, appId);
          const prefix = `${path}/`;
          if ((await local.appKeys()).some((k) => k.startsWith(prefix))) throw new Error(`\u6587\u4EF6\u5939\u975E\u7A7A\uFF08\u672C\u5730\u6709\u6587\u4EF6\uFF09\uFF0C\u62D2\u7EDD\u5220\u9664\uFF1A${path}`);
          const wasPending = readPending().includes(path);
          clearPendingFolder(path);
          if (!isOnline()) {
            if (wasPending) {
              notifyFolderOf(path);
              return;
            }
            enqueueFolderDel(path);
            notifyFolderOf(path);
            return;
          }
          const r = await cloud.deleteEmptyFolder(path);
          if (r.status === "non-empty") throw new Error(`\u6587\u4EF6\u5939\u975E\u7A7A\uFF0C\u62D2\u7EDD\u5220\u9664\uFF1A${path}`);
          if (r.status === "list-failed") throw new Error(`\u65E0\u6CD5\u786E\u8BA4\u6587\u4EF6\u5939\u662F\u5426\u4E3A\u7A7A\uFF08\u5217\u4E3E\u5931\u8D25\uFF09\uFF0C\u5DF2\u62D2\u7EDD\u5220\u9664\uFF1A${path}`);
          notifyFolderOf(path);
        });
      }),
      /** 离线队列统一重放（app 在 focus/visibility/online/boot 调）：新文件夹补建 → 新上传补推 → 删文件 → 删文件夹（按序）。 */
      drainOfflineQueue,
      //   conflictLive（离线删被 edit-wins 撤销→本地 trash 有、云端还活着）：仅当有本地 trash 项且能拿到**权威** live 列表时才判（离线/partial→空集→不误报）。
      /** 回收站列表：**本地↔云两端聚合**（mergeTrash）。只返元数据（trashKey/cloudItemId/原名/加密标志/conflictLive），绝不带 blob。 */
      listTrash: () => aggregateBox("trash"),
      /** 备份箱列表（同 listTrash 的两端聚合；备份箱是冲突 loser 留底，无 conflictLive 语义）。 */
      listBackup: () => aggregateBox("backup"),
      /** 从回收站/备份箱恢复一项。 */
      restoreTrash: singleFlight("\u6062\u590D", (...a) => {
        roGuard("restoreTrash");
        return trashMod.restore(...a);
      }),
      /** 彻底删除回收站/备份箱一项。 */
      purgeTrash: singleFlight("\u5F7B\u5E95\u5220\u9664", (...a) => {
        roGuard("purgeTrash");
        return trashMod.purge(...a);
      }),
      /** 清空回收站。 */
      emptyTrash: singleFlight("\u6E05\u7A7A\u56DE\u6536\u7AD9", (...a) => {
        roGuard("emptyTrash");
        return trashMod.emptyTrash(...a);
      }),
      /** 清空备份箱。 */
      emptyBackup: singleFlight("\u6E05\u7A7A\u5907\u4EFD\u7BB1", (...a) => {
        roGuard("emptyBackup");
        return trashMod.emptyBackup(...a);
      }),
      //   日常开夹的惰性收敛已在 watchFolder 内走 reconcileFolder（看到夹才收敛，同一 converge SSOT）。
      /** **全库** cloud-gone 收敛（去抖后 send trash）。**仅用户显式指令**（隐藏的「校验完整性」入口），
       *  绝不自动/轮询——全树 listAll 是重活。 */
      reconcileAll: (opts) => reconcileMod.reconcile(opts)
    },
    //   设计约束：① 不做重复的计算 ② 不做不必要的计算。
    /** **裸字节**级的加密面（文件还没进 store、无 name 可查时用）。有 name 的场景一律走 file.*
     *  （isEncrypted / encrypt / decrypt / verifyPassword / getPeek / decryptPeek / getEncryptedBlob）——
     *  那些能用便宜的 peek 路径，别走这里。 */
    encryption: {
      /** 是不是加密容器。**只嗅魔数/尾窗**，不派生密钥、不解密（便宜，可用于分流）。 */
      isEncryptedBlob: (blob) => looksEncryptedContainer(blob),
      /** 验密码 + 解出明文，**合一**。null = 错密码（或不是容器）。
       *
       *  为什么合一（这就是「不做重复的计算」）：旧面把它拆成 verifyContainer(验) + unsealWith(解)，
       *  而两者内部都是完整的 unpackContainer —— 导入一个加密文件要把整幅作品**解密两遍**
       *  （密码试错时更多）。7z-wasm 全量解一幅画不是小钱。合一后一次尝试 = 一次解密，
       *  且成功那次的明文直接给调用方复用。
       *  明文只在返回的 Blob 里（内存），库不缓存、不落盘。 */
      tryDecryptEncryptedBlob: async (blob, pw) => {
        if (!pw) return null;
        if (!await looksEncryptedContainer(blob)) return null;
        try {
          return (await unpackContainer(blob, pw)).dataBlob;
        } catch {
          return null;
        }
      },
      /** 这块 blob 是不是**密文 peek**（getPeek 对加密件返回的那种）。纯类型判定，零计算。
       *  取代把 ENC_PEEK_MIME 这个魔法常量导出给 app —— app 要问的是语义，不是常量值。 */
      isEncryptedPeekBlob: (blob) => !!blob && blob.type === ENC_PEEK_MIME
    }
    // 无 _internal —— app 绝不碰 head/cloud/sub（库内测试直接 import 对应模块）。
  };
}

// ../../20260813 internal-store/src/providers/graph.ts
var graph_exports = {};
__export(graph_exports, {
  clearFolderCaches: () => clearFolderCaches,
  deleteItem: () => deleteItem,
  downloadItemBlob: () => downloadItemBlob,
  downloadItemRange: () => downloadItemRange,
  downloadRangeFromUrl: () => downloadRangeFromUrl,
  encodeApprootPath: () => encodeApprootPath,
  ensureSubfolder: () => ensureSubfolder,
  getApprootId: () => getApprootId,
  getDownloadUrl: () => getDownloadUrl,
  getItemByPath: () => getItemByPath,
  listChildren: () => listChildren,
  moveItemToFolder: () => moveItemToFolder,
  renameItem: () => renameItem,
  uploadFileToApproot: () => uploadFileToApproot
});

// ../../20260813 internal-store/src/providers/auth.ts
var CLIENT_ID = "";
var AUTHORITY = "https://login.microsoftonline.com/common";
var SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];
var MSAL_URL = null;
function configureOneDriveAuth({ clientId, authority, scopes, msalUrl } = {}) {
  if (clientId) CLIENT_ID = clientId;
  if (authority) AUTHORITY = authority;
  if (scopes) SCOPES = scopes;
  if (msalUrl != null) {
    MSAL_URL = typeof document !== "undefined" && document.baseURI ? new URL(msalUrl, document.baseURI).href : null;
  }
}
function isAuthConfigured() {
  return typeof CLIENT_ID === "string" && CLIENT_ID.length > 0 && !CLIENT_ID.startsWith("REPLACE_ME");
}
var msalLoadPromise = null;
var pca = null;
var activeAccount = null;
var initPromise = null;
var _authSubs = /* @__PURE__ */ new Set();
function onAuthChanged(cb) {
  _authSubs.add(cb);
  return () => _authSubs.delete(cb);
}
function getAuthState() {
  return { signedIn: !!activeAccount, account: activeAccount };
}
function _emitAuth() {
  const st = getAuthState();
  for (const cb of _authSubs) {
    try {
      cb(st);
    } catch (_) {
    }
  }
}
var SCRIPT_LOAD_TIMEOUT_MS = 45e3;
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    let done = false;
    const settle = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => settle(() => {
      s.remove();
      reject(new Error(`timeout loading ${url}`));
    }), SCRIPT_LOAD_TIMEOUT_MS);
    s.src = url;
    s.async = true;
    s.onload = () => settle(resolve);
    s.onerror = () => settle(() => reject(new Error(`failed to load ${url}`)));
    document.head.appendChild(s);
  });
}
async function loadScriptWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await loadScript(url);
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`MSAL load attempt ${i + 1}/${attempts} failed`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`MSAL load failed ${url}: ${lastErr?.message}`);
}
function loadMsal() {
  if (window.msal) return Promise.resolve(window.msal);
  if (msalLoadPromise) return msalLoadPromise;
  msalLoadPromise = (async () => {
    await loadScriptWithRetry(MSAL_URL);
    if (window.msal) return window.msal;
    msalLoadPromise = null;
    throw new Error("MSAL loaded but window.msal didn't appear");
  })().catch((e) => {
    msalLoadPromise = null;
    throw e;
  });
  return msalLoadPromise;
}
async function initAuth() {
  if (!isAuthConfigured()) {
    return { signedIn: false, account: null, notConfigured: true };
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const msal = await loadMsal();
    pca = new msal.PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        redirectUri: location.origin + location.pathname,
        postLogoutRedirectUri: location.origin + location.pathname
      },
      cache: {
        cacheLocation: "localStorage",
        storeAuthStateInCookie: false
      }
    });
    await pca.initialize();
    let response = null;
    try {
      response = await pca.handleRedirectPromise();
    } catch (e) {
      console.warn("handleRedirectPromise failed:", e);
    }
    if (response?.account) {
      pca.setActiveAccount(response.account);
      activeAccount = response.account;
      _emitAuth();
      return { signedIn: true, account: activeAccount };
    }
    const cached = pca.getAllAccounts();
    if (cached.length === 0) return { signedIn: false, account: null };
    _probeSilent(cached[0]);
    return { signedIn: false, account: null, probing: true, probedAccount: cached[0] };
  })().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}
function _afterWindowLoad(fn) {
  const w = globalThis;
  if (!w.addEventListener || w.document?.readyState === "complete") {
    fn();
    return;
  }
  w.addEventListener("load", () => fn(), { once: true });
}
async function _probeSilent(account) {
  await new Promise((r) => _afterWindowLoad(r));
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account });
    pca.setActiveAccount(account);
    activeAccount = account;
    _emitAuth();
  } catch (_) {
  }
}
async function signIn() {
  if (!pca) await initAuth();
  return pca.loginRedirect({ scopes: SCOPES });
}
async function signOut() {
  if (!pca || !activeAccount) return;
  const account = activeAccount;
  activeAccount = null;
  _emitAuth();
  try {
    await pca.clearCache({ account });
  } catch (e) {
    console.warn("clearCache failed:", e);
  }
  try {
    pca.setActiveAccount(null);
  } catch (_) {
  }
}
async function getToken() {
  if (!pca || !activeAccount) throw new Error("Not signed in");
  try {
    const result = await pca.acquireTokenSilent({ scopes: SCOPES, account: activeAccount });
    return result.accessToken;
  } catch (e) {
    activeAccount = null;
    _emitAuth();
    throw e;
  }
}
function getActiveAccount() {
  return activeAccount;
}
function isSignedIn() {
  return !!activeAccount;
}
async function retrySilentSignIn() {
  if (activeAccount) return true;
  if (!isAuthConfigured()) return false;
  if (!pca) {
    try {
      await initAuth();
    } catch (_) {
      return false;
    }
  }
  if (!pca) return false;
  const cached = pca.getAllAccounts();
  if (cached.length === 0) return false;
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
    pca.setActiveAccount(cached[0]);
    activeAccount = cached[0];
    _emitAuth();
    return true;
  } catch (_) {
    return false;
  }
}

// ../../20260813 internal-store/src/providers/graph.ts
var GRAPH_BASE = "https://graph.microsoft.com/v1.0";
var SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
function encodeSeg(name) {
  return encodeURIComponent(name).replace(/'/g, "%27");
}
function encodeApprootPath(path) {
  return path.split("/").filter(Boolean).map(encodeSeg).join("/");
}
async function graphFetch(method, pathOrUrl, { headers = {}, body = null } = {}) {
  const token = await getToken();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const init = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
  if (body != null) {
    if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      if (!init.headers["Content-Type"]) init.headers["Content-Type"] = "application/json";
    }
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch (_) {
    }
    const err = new Error(`Graph ${method} ${pathOrUrl} \u2192 ${response.status}: ${detail}`);
    err.status = response.status;
    err.body = detail;
    throw err;
  }
  return response;
}
async function listChildren(subfolder = "") {
  const pathPart = subfolder ? `:/${encodeApprootPath(subfolder)}:` : "";
  const items = [];
  let next = `/me/drive/special/approot${pathPart}/children?$top=200&$select=id,name,size,eTag,createdDateTime,lastModifiedDateTime,file,folder,@microsoft.graph.downloadUrl`;
  while (next) {
    let response;
    try {
      response = await graphFetch("GET", next);
    } catch (e) {
      if (e.status === 404 && subfolder) return [];
      throw e;
    }
    const page = await response.json();
    items.push(...page.value ?? []);
    next = page["@odata.nextLink"] ?? null;
  }
  return items;
}
async function getItemByPath(path) {
  try {
    const r = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(path)}?$select=id,name,size,eTag,lastModifiedDateTime,folder,@microsoft.graph.downloadUrl`
    );
    return await r.json();
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
async function downloadItemBlob(itemId) {
  const dl = await getDownloadUrl(itemId);
  if (dl) {
    const r2 = await fetch(dl);
    if (!r2.ok) throw new Error(`downloadUrl failed ${r2.status}`);
    return await r2.blob();
  }
  const r = await graphFetch("GET", `/me/drive/items/${itemId}/content`);
  return await r.blob();
}
async function downloadItemRange(itemId, offset, length) {
  const dl = await getDownloadUrl(itemId);
  if (dl) return await downloadRangeFromUrl(dl, offset, length);
  const r = await graphFetch("GET", `/me/drive/items/${itemId}/content`, { headers: { Range: _rangeHeader(offset, length) } });
  return await r.arrayBuffer();
}
function _rangeHeader(offset, length) {
  return offset == null ? `bytes=-${length}` : `bytes=${offset}-${offset + length - 1}`;
}
async function downloadRangeFromUrl(downloadUrl, offset, length) {
  const r = await fetch(downloadUrl, { headers: { Range: _rangeHeader(offset, length) } });
  if (!r.ok && r.status !== 206) {
    const err = new Error(`range download failed ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return await r.arrayBuffer();
}
async function getDownloadUrl(itemId) {
  const r = await graphFetch("GET", `/me/drive/items/${itemId}`);
  const j = await r.json();
  return j["@microsoft.graph.downloadUrl"] || null;
}
async function uploadFileToApproot(path, blob, contentType = "application/octet-stream", { conflictBehavior = "replace", eTag = null } = {}) {
  const headers = { "Content-Type": contentType };
  if (eTag) headers["If-Match"] = eTag;
  if (blob.size <= SIMPLE_UPLOAD_LIMIT) {
    const r = await graphFetch(
      "PUT",
      `/me/drive/special/approot:/${encodeApprootPath(path)}:/content?@microsoft.graph.conflictBehavior=${conflictBehavior}`,
      { headers, body: blob }
    );
    return r.json();
  }
  const sessR = await graphFetch(
    "POST",
    `/me/drive/special/approot:/${encodeApprootPath(path)}:/createUploadSession`,
    {
      body: {
        item: {
          "@microsoft.graph.conflictBehavior": conflictBehavior,
          name: path.split("/").pop()
        }
      },
      headers: eTag ? { "If-Match": eTag } : void 0
    }
  );
  const { uploadUrl } = await sessR.json();
  const CHUNK = 5 * 1024 * 1024;
  let offset = 0;
  let last = null;
  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK, blob.size) - 1;
    const chunk = blob.slice(offset, end + 1);
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.size),
        "Content-Range": `bytes ${offset}-${end}/${blob.size}`
      },
      body: chunk
    });
    if (!r.ok && r.status !== 202) {
      const err = new Error(`chunked upload failed ${r.status}`);
      err.status = r.status;
      throw err;
    }
    last = await r.json().then((j) => j).catch(() => null);
    offset = end + 1;
  }
  return last;
}
async function deleteItem(itemId, eTag) {
  await graphFetch("DELETE", `/me/drive/items/${itemId}`, eTag ? { headers: { "If-Match": eTag } } : {});
}
var _approotIdCache = null;
var _subfolderIdCache = /* @__PURE__ */ new Map();
function clearFolderCaches() {
  _approotIdCache = null;
  _subfolderIdCache.clear();
}
async function getApprootId() {
  if (_approotIdCache) return _approotIdCache;
  const r = await graphFetch("GET", "/me/drive/special/approot?$select=id");
  _approotIdCache = (await r.json()).id;
  return _approotIdCache;
}
async function ensureSubfolder(name) {
  if (!name) return getApprootId();
  const cached = _subfolderIdCache.get(name);
  if (cached !== void 0) return cached;
  try {
    const r = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(name)}?$select=id,name,folder`
    );
    const item = await r.json();
    if (item.folder) {
      _subfolderIdCache.set(name, item.id);
      return item.id;
    }
    throw new Error(`${name} \u5DF2\u5B58\u5728\u4F46\u4E0D\u662F\u6587\u4EF6\u5939`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const segments = name.split("/").filter(Boolean);
  let parentId = await getApprootId();
  let cumulative = "";
  for (const seg of segments) {
    cumulative = cumulative ? `${cumulative}/${seg}` : seg;
    const cachedSeg = _subfolderIdCache.get(cumulative);
    if (cachedSeg !== void 0) {
      parentId = cachedSeg;
      continue;
    }
    try {
      const r2 = await graphFetch(
        "GET",
        `/me/drive/special/approot:/${encodeApprootPath(cumulative)}?$select=id,folder`
      );
      const it2 = await r2.json();
      if (it2.folder) {
        parentId = it2.id;
        _subfolderIdCache.set(cumulative, parentId);
        continue;
      }
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const r = await graphFetch("POST", `/me/drive/items/${parentId}/children`, {
      body: {
        name: seg,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail"
      }
    });
    const it = await r.json();
    parentId = it.id;
    _subfolderIdCache.set(cumulative, parentId);
  }
  return parentId;
}
async function moveItemToFolder(itemId, targetFolderId, { eTag = null, newName = null, conflictBehavior = "fail" } = {}) {
  const headers = {};
  if (eTag) headers["If-Match"] = eTag;
  const body = {
    parentReference: { id: targetFolderId },
    "@microsoft.graph.conflictBehavior": conflictBehavior
  };
  if (newName) body.name = newName;
  const r = await graphFetch("PATCH", `/me/drive/items/${itemId}`, { headers, body });
  return r.json();
}
async function renameItem(itemId, newName, eTag = null) {
  const headers = {};
  if (eTag) headers["If-Match"] = eTag;
  const r = await graphFetch("PATCH", `/me/drive/items/${itemId}`, {
    headers,
    body: { name: newName }
  });
  return r.json();
}

// ../../20260813 internal-store/src/folder-delete.ts
async function deleteEmptyFolderVia(getItemByPath2, list, deleteById, path) {
  const item = await getItemByPath2(path);
  if (!item) return { status: "already-gone" };
  if (!item.isFolder) throw new Error(`\u4E0D\u662F\u6587\u4EF6\u5939\uFF0C\u62D2\u7EDD\u5220\u9664\uFF1A${path}`);
  let children;
  try {
    children = await list(path);
  } catch {
    return { status: "list-failed" };
  }
  if (children.length) return { status: "non-empty" };
  await deleteById(item.id, item.eTag);
  return { status: "deleted" };
}

// ../../20260813 internal-store/src/onedrive-provider.ts
function toItem(it) {
  if (!it) return null;
  return {
    id: it.id,
    name: it.name,
    size: it.size || 0,
    eTag: it.eTag,
    lastModifiedDateTime: it.lastModifiedDateTime,
    isFolder: !!it.folder,
    // Graph: file facet vs folder facet
    path: it.path,
    downloadUrl: it["@microsoft.graph.downloadUrl"] || it.downloadUrl
  };
}
function graphToCloudProvider(graph) {
  if (!graph) throw new Error("graphToCloudProvider: graph transport \u5FC5\u4F20");
  const list = async (folder = "") => (await graph.listChildren(folder)).map(toItem);
  const getItemByPath2 = async (path) => toItem(await graph.getItemByPath(path));
  return {
    list,
    getItemByPath: getItemByPath2,
    download: (id) => graph.downloadItemBlob(id),
    downloadRange: (id, offset, length) => graph.downloadItemRange(id, offset, length),
    // graph.js 是 Blob 原生（按 .size 选简单/分块路径、用 .slice 切块）；lib 把字节归一成 Uint8Array。
    // 必须在这道接缝转回 Blob——Uint8Array.size===undefined → undefined<=4MB 为 false → 永远走分块、
    // while(0<undefined) 一个 chunk 都不传 → 上传 0 字节占位还回 etag（postmortem 2026-06-05 根因）。
    upload: (path, blob, { contentType = "application/octet-stream", eTag = null, conflictBehavior = "replace" } = {}) => {
      const body = blob instanceof Blob ? blob : new Blob([blob], { type: contentType });
      return graph.uploadFileToApproot(path, body, contentType, { conflictBehavior, eTag }).then(toItem);
    },
    delete: (id) => graph.deleteItem(id),
    // 文件硬删（无条件）
    // 删空夹（唯一文件夹删除面）：护栏在 folder-delete 深模块，If-Match folder etag best-effort。
    deleteEmptyFolder: (path) => deleteEmptyFolderVia(getItemByPath2, list, (id, etag) => graph.deleteItem(id, etag), path),
    ensureFolder: (path) => graph.ensureSubfolder(path),
    move: (id, folderId, opts = {}) => graph.moveItemToFolder(id, folderId, opts).then(toItem),
    rename: (id, newName, eTag) => graph.renameItem(id, newName, eTag).then(toItem),
    getApprootId: () => graph.getApprootId()
  };
}

// ../../20260813 internal-store/src/providers/index.ts
function createOneDriveProvider(config = {}) {
  configureOneDriveAuth(config);
  return {
    provider: graphToCloudProvider(graph_exports),
    // CloudProvider（喂 createCloudSync）
    auth: { isAuthConfigured, initAuth, signIn, signOut, getToken, isSignedIn, getActiveAccount, retrySilentSignIn, onAuthChanged, getAuthState }
  };
}

// ../../20260813 internal-store/src/sw/bridge.ts
function startSwAuthBridge(cfg) {
  const bridge = createPartitionedBlobStore(cfg.dbName).partition("sw-bridge");
  let stopped = false;
  async function refresh() {
    if (stopped) return;
    try {
      const token = await cfg.getToken();
      await bridge.put("token", { blob: new Blob([JSON.stringify({ v: 1, token, savedAt: Date.now() })]), updatedAt: Date.now() });
    } catch {
    }
  }
  const ready = refresh();
  const timer = setInterval(() => {
    void refresh();
  }, cfg.refreshEveryMs ?? 35 * 6e4);
  const onWake = () => {
    void refresh();
  };
  addEventListener("focus", onWake);
  addEventListener("online", onWake);
  const stop = (opts) => {
    stopped = true;
    clearInterval(timer);
    removeEventListener("focus", onWake);
    removeEventListener("online", onWake);
    if (opts?.wipe) void bridge.del("token").catch(() => {
    });
  };
  return { ready, stop };
}

// ../config.js
var CLIENT_ID2 = "aa43a186-25cd-4140-ade9-c0abd6ce5cb6";
var AUTHORITY2 = "https://login.microsoftonline.com/common";
var SCOPES2 = ["Files.ReadWrite.AppFolder", "offline_access"];

// src/player-logic.ts
async function resolveAvail(f) {
  if (await f.isKeptOffline()) return { kind: "local" };
  const cov = await f.stagingCoverage();
  return cov ? { kind: "staged", cov } : { kind: "none" };
}
function nextOf(tracks2, name) {
  const i = tracks2.indexOf(name);
  return i >= 0 && tracks2.length > 0 ? tracks2[(i + 1) % tracks2.length] : null;
}
function classifyNextReady(avail, headReadyBytes) {
  if (avail.kind === "local") return "ready-full";
  if (avail.kind === "staged") {
    if (avail.cov.complete) return "ready-full";
    if (avail.cov.headBytes >= headReadyBytes) return "ready-head";
  }
  return "need-fetch";
}
function decideBoundary(i) {
  if (i.mode !== "folder" || !i.current) return { action: "none" };
  const next = nextOf(i.tracks, i.current);
  if (!next) return { action: "loop", reason: "\u65E0\u4E0B\u4E00\u66F2" };
  if (i.nextReady?.name !== next) return { action: "loop", reason: `\u4E0B\u4E00\u66F2 ${next} \u672A\u5907\u6218/flag \u9648\u65E7` };
  if (!i.online && !i.nextReady.full) return { action: "loop", reason: "\u4EC5\u5934\u90E8\u5907\u597D\u4E14\u79BB\u7EBF\u2014\u2014\u63A5\u4E86\u5FC5\u5361\u6B7B" };
  return { action: "advance", to: next };
}
function decideStartPlayback(i) {
  if (i.online) return { allow: true };
  if (i.avail.kind === "local") return { allow: true };
  if (i.avail.kind === "none") return { allow: true, note: "\u65E0\u7F13\u5B58\u76F4\u63A5\u8BD5\uFF08onLine \u53EF\u80FD\u4E0D\u53EF\u4FE1\uFF1B\u771F\u79BB\u7EBF\u4F1A\u7ACB\u523B\u660E\u8BF4\uFF09" };
  if (i.avail.cov.complete) return { allow: true, note: "\u7F13\u5B58\u5B8C\u6574" };
  return { allow: false, why: `\u7F13\u5B58\u4E0D\u5B8C\u6574 ${Math.round(i.avail.cov.bytes / i.avail.cov.totalBytes * 100)}%\uFF08\u6709\u6D1E\u2014\u2014\u9632\u5148\u54CD\u540E\u5361\u6B7B\uFF09` };
}
function decideRecovery(i) {
  if (!i.online) return { action: "hold", reason: "onLine=false\uFF0C\u7B49\u56DE\u7EBF" };
  if (i.failures < 2) return { action: "retry-sw" };
  if (i.probeOk === null) return { action: "probe" };
  if (!i.probeOk) return { action: "hold", reason: "\u540C\u6E90\u63A2\u9488\u4E5F\u4E0D\u901A=\u771F\u65AD\u7F51\uFF08onLine \u5728\u8BF4\u8C0E\uFF09\uFF0C\u7B49\u7F51\u7EDC" };
  if (!i.blobTried) return { action: "blob-fallback" };
  return { action: "hold", reason: "blob \u964D\u7EA7\u4E5F\u8BD5\u8FC7\u4ECD\u5931\u8D25\uFF0C\u9000\u907F\u91CD\u6765" };
}
function retryDelayMs(failures) {
  return Math.min(6e4, 8e3 * 2 ** Math.max(0, failures - 1));
}
function decideHeal(i) {
  const out = [];
  if (!i.current || i.mode === "stop") return out;
  if (i.hasError && i.online) out.push("rebuild");
  if (i.mode !== "folder") return out;
  if (i.loopEngaged && i.nextReady && (i.online || i.nextReady.full)) out.push("unloop");
  if ((i.loopEngaged || !i.nextReady) && i.online) out.push("re-arm");
  return out;
}

// src/main.ts
var SPIKE_V = "spike-12 \xB7 2026-08-19";
var APP_ID = "br-spike";
var DB_NAME = `${APP_ID}.defaultStore`;
var AUDIO_EXT = /* @__PURE__ */ new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac"]);
var logEl = document.getElementById("log");
function log(msg) {
  const t = /* @__PURE__ */ new Date();
  const line = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}.${String(t.getMilliseconds()).padStart(3, "0")} ${msg}`;
  const div = document.createElement("div");
  div.textContent = line;
  logEl.prepend(div);
  while (logEl.childNodes.length > 200) logEl.lastChild.remove();
  console.log("[spike]", msg);
}
var { provider, auth } = createOneDriveProvider({
  clientId: CLIENT_ID2,
  authority: AUTHORITY2,
  scopes: SCOPES2,
  msalUrl: "../vendor/msal/msal-browser.min.js"
  // 复用旧 BR vendored MSAL（同 origin 同 clientId → 静默复用登录态）
});
var store = createStore({
  appId: APP_ID,
  provider,
  validateAdopt: (plain) => sniffAudio(plain),
  signedIn: () => auth.isSignedIn(),
  autoCacheOpenedFile: false,
  // 流式消费 app：open 过路不留；留离线只走 keepOffline / openStream.keep
  offlineUploadReplay: "auto",
  // 离线/未登录时播的种，登录后 drainOfflineQueue 自动补推上云
  ui: {
    busy: async (label, fn) => {
      log(`\u23F3 ${label}`);
      try {
        return await fn();
      } finally {
        log(`\u2713 ${label}`);
      }
    },
    resolveConflict: async ({ name }) => {
      log(`\u26A0 \u51B2\u7A81\u9762\u88AB\u89E6\u53D1\uFF08${name}\uFF09\u2014\u2014spike \u4E0D\u8BE5\u53D1\u751F\uFF0C\u9009 cancel`);
      return "cancel";
    },
    reportError: (err, level) => {
      if (level !== "log") log(`\u{1F6D1} ${String(err?.message ?? err)}`);
      else console.log("[store]", err);
    },
    onReplayStatus: (evt) => log(`\u8865\u63A8 ${evt.phase}${evt.name ? `\uFF1A${evt.name}` : ""}\uFF08${evt.done}/${evt.total}\uFF09`)
  }
});
async function sniffAudio(plain) {
  const head = new Uint8Array(await plain.slice(0, 12).arrayBuffer());
  const s = String.fromCharCode(...head.subarray(0, 4));
  if (s.startsWith("ID3") || s === "RIFF" || s === "fLaC" || s === "OggS") return true;
  if (head[0] === 255 && (head[1] & 224) === 224) return true;
  if (s.startsWith("<") || s.startsWith("<!")) return false;
  return head.length > 0;
}
var streamPrefix = new URL("./stream/", location.href).pathname;
var streamUrl = (name) => streamPrefix + name.split("/").map(encodeURIComponent).join("/");
async function ensureSw() {
  const reg = await navigator.serviceWorker.register("./sw.js");
  if (navigator.serviceWorker.controller) {
    sessionStorage.removeItem("sw-reclaim");
    log("SW \u5DF2\u63A5\u7BA1");
    return;
  }
  log("SW \u5DF2\u6CE8\u518C\uFF0C\u7B49\u63A5\u7BA1\u2026");
  const claimed = await Promise.race([
    new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", () => r(true), { once: true })),
    new Promise((r) => setTimeout(() => r(false), 1200))
  ]);
  if (claimed) {
    sessionStorage.removeItem("sw-reclaim");
    log("SW \u63A5\u7BA1\u5B8C\u6210");
    return;
  }
  if ((reg.active || reg.waiting) && !sessionStorage.getItem("sw-reclaim")) {
    sessionStorage.setItem("sw-reclaim", "1");
    log("\u5F3A\u5237\u540E SW \u672A\u63A7\u672C\u9875 \u2192 \u81EA\u52A8\u8F6F\u5237\u4E00\u6B21\u63A5\u56DE");
    location.reload();
    await new Promise(() => {
    });
  }
  log("\u26A0 SW \u672A\u63A5\u7BA1\uFF08\u6D41\u64AD\u4E0D\u53EF\u7528\uFF09\u2014\u2014\u666E\u901A\u5237\u65B0\u4E00\u6B21\u8BD5\u8BD5");
}
var audio = document.getElementById("audio");
var nowEl = document.getElementById("now");
var mode = "folder";
var currentFolder = "";
var tracks = [];
var current = null;
var nextReady = null;
var fileOf = (name) => store.file(name, { isZip: false, mode: "existing" });
var HEAD_READY_BYTES = 512 * 1024;
async function prefetchNextHead(name) {
  const next = nextOf(tracks, name);
  nextReady = null;
  if (!next || mode !== "folder") return;
  try {
    const f = fileOf(next);
    let lvl = classifyNextReady(await resolveAvail(f), HEAD_READY_BYTES);
    if (lvl === "need-fetch") {
      const h = await f.openStream();
      if (!h) {
        log(`\u8FB9\u754C\u5907\u6218\u5931\u8D25\uFF1A${next} \u62FF\u4E0D\u5230\uFF08${navigator.onLine ? "\u4E91\u7AEF\u89E3\u6790\u5931\u8D25" : "\u79BB\u7EBF\u4E14\u65E0\u7F13\u5B58"}\uFF09\u2192 \u5C4A\u65F6\u964D\u7EA7 loop`);
        return;
      }
      await h.prefetch(0, 768 * 1024);
      h.close();
      lvl = classifyNextReady(await resolveAvail(f), HEAD_READY_BYTES);
      if (lvl === "need-fetch") {
        log(`\u8FB9\u754C\u5907\u6218\uFF1A\u9884\u62C9\u540E\u5934\u90E8\u4ECD\u4E0D\u8DB3\uFF08${next}\uFF09\u2192 \u5C4A\u65F6\u964D\u7EA7 loop`);
        return;
      }
    }
    nextReady = { name: next, full: lvl === "ready-full" };
    log(`\u8FB9\u754C\u5907\u6218\uFF1A${next} ${nextReady.full ? "\u5168\u91CF\u53EF\u63A5\uFF08\u79BB\u7EBF\u4E5F\u884C\uFF09" : "\u5934\u90E8\u5C31\u7EEA\uFF08\u5728\u7EBF\u53EF\u63A5\uFF09"}`);
  } catch (e) {
    log(`\u8FB9\u754C\u5907\u6218\u5F02\u5E38\uFF1A${String(e.message)} \u2192 \u5C4A\u65F6\u964D\u7EA7 loop`);
  }
}
async function play(name) {
  if (!navigator.onLine) {
    const d = decideStartPlayback({ online: false, avail: await resolveAvail(fileOf(name)) });
    if (!d.allow) {
      log(`\u26D4 \u79BB\u7EBF\u8D77\u64AD\u62D2\u7EDD\uFF1A${name}\uFF08${d.why}\uFF09`);
      nowEl.textContent = `\u26D4 \u79BB\u7EBF\u4E0D\u53EF\u64AD\uFF1A${name.split("/").pop()}\uFF08${d.why}\uFF09`;
      return;
    }
    if (d.note) log(`\u79BB\u7EBF\u8D77\u64AD\u653E\u884C\uFF1A${name}\uFF08${d.note}\uFF09`);
  }
  startPlayback(name);
}
function startPlayback(name) {
  current = name;
  audio.loop = mode === "single";
  audio.src = streamUrl(name);
  void audio.play().then(() => log(`\u25B6 \u64AD\u653E\uFF1A${name}`)).catch((e) => log(`play() \u62D2\u7EDD\uFF1A${e.message}`));
  nowEl.textContent = `\u25B6 ${name}`;
  setMediaSession(name);
  void prefetchNextHead(name);
  renderList();
}
audio.addEventListener("ended", () => {
  const d = decideBoundary({ mode, current, tracks, nextReady, online: navigator.onLine });
  log(`\u2605\u8FB9\u754C\u51B3\u7B56\uFF1A${d.action}${d.action === "advance" ? `\u2192${d.to}` : d.action === "loop" ? `\uFF08${d.reason}\uFF09` : ""}\uFF08\u5907\u6218=${nextReady ? `${nextReady.name}\xB7${nextReady.full ? "\u5168\u91CF" : "\u4EC5\u5934"}` : "\u65E0"}\uFF0Conline=${navigator.onLine}\uFF09`);
  if (d.action === "advance") {
    current = d.to;
    nextReady = null;
    audio.src = streamUrl(d.to);
    void audio.play().then(() => log(`\u25B6 \u81EA\u52A8\u6B65\u8FDB\u6210\u529F\uFF1A${d.to}`)).catch((e) => log(`\u6B65\u8FDB play() \u62D2\u7EDD\uFF1A${e.message}`));
    nowEl.textContent = `\u25B6 ${d.to}`;
    setMediaSession(d.to);
    void prefetchNextHead(d.to);
    renderList();
  } else if (d.action === "loop") {
    audio.loop = true;
    void audio.play().catch(() => {
    });
    log("\u2605\u964D\u7EA7 audio.loop \u5355\u66F2\u5FAA\u73AF\u2014\u2014\u81EA\u6108\u89E3\u9664");
  }
});
for (const ev of ["error", "stalled", "waiting", "playing", "pause"]) {
  audio.addEventListener(ev, () => log(`audio \u4E8B\u4EF6\uFF1A${ev}${ev === "error" ? ` code=${audio.error?.code}` : ""}`));
}
audio.addEventListener("error", () => {
  if (current) nowEl.textContent = `\u26A0 \u64AD\u653E\u5931\u8D25\uFF1A${current.split("/").pop()}\uFF08${navigator.onLine ? "\u62FF\u4E0D\u5230\u5B57\u8282\uFF0C\u4E91\u7AEF\u4E0D\u53EF\u8FBE\uFF1F" : "\u79BB\u7EBF\u4E14\u673A\u4E0A\u65E0\u6B64\u66F2\u5B57\u8282"}\uFF09\u2014\u2014\u56DE\u7EBF\u81EA\u52A8\u91CD\u8BD5`;
});
var lastMediaWall = 0;
audio.addEventListener("timeupdate", () => {
  lastMediaWall = Date.now();
});
function recoverPlayback(reason) {
  if (!current) return;
  const t = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  log(`\u81EA\u6108\uFF1A\u91CD\u5EFA\u64AD\u653E\uFF08${reason}\uFF0C\u4F4D\u7F6E ${t.toFixed(1)}s\uFF09\uFF1A${current}`);
  audio.src = streamUrl(current);
  audio.currentTime = t;
  void audio.play().then(() => {
    log("\u81EA\u6108\uFF1A\u64AD\u653E\u5DF2\u7EED\u4E0A");
    nowEl.textContent = `\u25B6 ${current}`;
  }).catch((e) => log(`\u81EA\u6108 play() \u62D2\u7EDD\uFF1A${e.message}`));
}
var MIME_BLOB = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg" };
var recFailures = 0;
var recProbeOk = null;
var recBlobTried = false;
var recNextAt = 0;
var blobUrl = null;
audio.addEventListener("playing", () => {
  if (recFailures || recBlobTried) log("\u64AD\u653E\u5DF2\u7EED\u4E0A\u2014\u2014\u6062\u590D\u94FE\u8BA1\u6570\u5F52\u96F6");
  recFailures = 0;
  recProbeOk = null;
  recBlobTried = false;
  recNextAt = 0;
});
async function escalateRecovery(trigger) {
  if (Date.now() < recNextAt) return;
  const plan = decideRecovery({ online: navigator.onLine, failures: recFailures, probeOk: recProbeOk, blobTried: recBlobTried });
  if (plan.action === "retry-sw") {
    recFailures++;
    recNextAt = Date.now() + retryDelayMs(recFailures);
    recoverPlayback(`${trigger}\uFF1A\u91CD\u8BD5 SW \u8DEF\uFF08\u7B2C ${recFailures} \u6B21\uFF0C\u9000\u907F ${retryDelayMs(recFailures) / 1e3}s\uFF09`);
  } else if (plan.action === "probe") {
    recNextAt = Date.now() + 8e3;
    try {
      recProbeOk = (await fetch(`./manifest.webmanifest?heal-probe=${Date.now()}`, { cache: "no-store" })).ok;
    } catch {
      recProbeOk = false;
    }
    log(`\u63A2\u9488\uFF1A\u540C\u6E90\u62C9\u53D6${recProbeOk ? "\u901A\u2014\u2014\u9875\u9762\u7F51\u7EDC\u6D3B\u7740\uFF0CSW fetch \u50F5\u6B7B\uFF08iOS \u7F51\u7EDC\u5207\u6362\u540E\u9057\u75C7\uFF09\u2192 \u8D70 blob \u964D\u7EA7" : "\u4E0D\u901A\u2014\u2014\u771F\u65AD\u7F51\uFF08onLine \u5728\u8BF4\u8C0E\uFF09\uFF0C\u7B49\u7F51\u7EDC"}`);
  } else if (plan.action === "blob-fallback") {
    recBlobTried = true;
    recNextAt = Date.now() + 8e3;
    await blobFallbackPlay();
  } else {
    recNextAt = Date.now() + 6e4;
    log(`\u6062\u590D\u6682\u7F13\uFF1A${plan.reason}\uFF0860s \u540E\u91CD\u542F\u6062\u590D\u94FE\uFF09`);
    recProbeOk = null;
    if (recBlobTried) {
      recFailures = 0;
      recBlobTried = false;
    }
  }
}
async function blobFallbackPlay() {
  if (!current) return;
  const t = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  log(`\u964D\u7EA7\uFF1A\u9875\u9762\u76F4\u4E0B\u6574\u66F2\u64AD blob\uFF1A${current}`);
  try {
    const h = await fileOf(current).openStream();
    if (!h) {
      log("\u964D\u7EA7\u5931\u8D25\uFF1AopenStream \u62FF\u4E0D\u5230\uFF08\u9875\u9762\u4FA7\u4E5F\u89E3\u6790\u4E0D\u5230\uFF09");
      return;
    }
    if (h.totalSize > 64 * 1024 * 1024) {
      h.close();
      log(`\u964D\u7EA7\u653E\u5F03\uFF1A${Math.round(h.totalSize / 1048576)}MB \u592A\u5927\u4E0D\u6574\u4E0B\uFF08\u7EE7\u7EED\u7B49 SW \u6D3B\uFF09`);
      return;
    }
    const bytes = await h.read(0, h.totalSize);
    h.close();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([bytes], { type: MIME_BLOB[current.split(".").pop().toLowerCase()] ?? "application/octet-stream" }));
    audio.src = blobUrl;
    audio.currentTime = t;
    void audio.play().then(() => log(`\u964D\u7EA7\u6210\u529F\uFF1Ablob \u7EED\u64AD\uFF08${t.toFixed(1)}s \u8D77\uFF09`)).catch((e) => log(`\u964D\u7EA7 play() \u62D2\u7EDD\uFF1A${e.message}`));
  } catch (e) {
    log(`\u964D\u7EA7\u5F02\u5E38\uFF1A${e.message}`);
  }
}
function applyHeal(trigger) {
  const acts = decideHeal({ online: navigator.onLine, current, mode, hasError: !!audio.error, loopEngaged: audio.loop, nextReady });
  if (!acts.length) return;
  if (acts.length === 1 && acts[0] === "rebuild" && Date.now() < recNextAt) return;
  log(`\u81EA\u6108\uFF08${trigger}\uFF09\uFF1A${acts.join("+")}`);
  if (acts.includes("rebuild")) void escalateRecovery(trigger);
  if (acts.includes("unloop")) {
    audio.loop = false;
    log("\u81EA\u6108\uFF1A\u89E3\u9664\u964D\u7EA7\u5355\u66F2\u5FAA\u73AF \u2192 \u6062\u590D\u987A\u5E8F\u63A5\u66F2");
  }
  if (acts.includes("re-arm") && current) {
    void prefetchNextHead(current).then(() => {
      const again = decideHeal({ online: navigator.onLine, current, mode, hasError: !!audio.error, loopEngaged: audio.loop, nextReady });
      if (again.includes("unloop")) {
        audio.loop = false;
        log("\u81EA\u6108\uFF1A\u5907\u6218\u5B8C\u6210 \u2192 \u89E3\u9664\u964D\u7EA7\u5355\u66F2\u5FAA\u73AF");
      }
    });
  }
}
function healCheck(trigger) {
  log(`\u81EA\u6108\u68C0\u67E5\uFF08${trigger}\uFF0Conline=${navigator.onLine}\uFF09`);
  if (navigator.onLine && lastSnap) watch(currentFolder);
  if (!current || mode === "stop") return;
  if (navigator.onLine && !audio.error && !audio.paused) {
    const wall0 = lastMediaWall;
    setTimeout(() => {
      if (!navigator.onLine || !current || audio.paused) return;
      if (lastMediaWall === wall0) recoverPlayback("\u56DE\u7EBF 2.5s \u65E0\u64AD\u653E\u8FDB\u5EA6\uFF08stall\uFF09");
      else log("\u81EA\u6108\u68C0\u67E5\uFF1A\u64AD\u653E\u5728\u8D70\uFF0C\u65E0\u9700\u91CD\u5EFA");
    }, 2500);
  }
  applyHeal(trigger);
}
addEventListener("online", () => healCheck("online \u4E8B\u4EF6"));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) healCheck("\u56DE\u524D\u53F0");
});
var stallStrikes = 0;
var lastWallSeen = -1;
setInterval(() => {
  if (!current || mode === "stop") return;
  applyHeal("watchdog");
  if (navigator.onLine && !audio.paused && !audio.error) {
    if (lastMediaWall === lastWallSeen) {
      if (++stallStrikes >= 2) {
        stallStrikes = 0;
        recoverPlayback("watchdog\uFF1A\u226516s \u65E0\u64AD\u653E\u8FDB\u5EA6");
      }
    } else stallStrikes = 0;
    lastWallSeen = lastMediaWall;
  } else stallStrikes = 0;
}, 8e3);
function setMediaSession(name) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: name.split("/").pop(), artist: "BR spike" });
    navigator.mediaSession.setActionHandler("play", () => void audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      const n = current && nextOf(tracks, current);
      if (n) void play(n);
    });
  } catch {
  }
}
var listEl = document.getElementById("list");
var unwatch = null;
var lastSnap = null;
function watch(folder) {
  unwatch?.();
  currentFolder = folder;
  unwatch = store.files.watchFolder(folder, (snap) => {
    lastSnap = snap;
    tracks = snap.items.map((i) => i.path).filter((p) => AUDIO_EXT.has(p.split(".").pop().toLowerCase()));
    log(`\u5217\u4E3E\u5E27\uFF1A${snap.items.length} \u9879 ${snap.folders.length} \u5939${snap.stale ? "\uFF08stale \u9996\u5E27\uFF09" : ""}${snap.complete ? "\uFF08\u4E91\u7AEF\u6743\u5A01\uFF09" : ""}`);
    renderList();
  });
}
var pinProgress = /* @__PURE__ */ new Map();
var covBadge = /* @__PURE__ */ new Map();
var covRefreshing = false;
async function refreshCovBadges() {
  if (!lastSnap || covRefreshing) return;
  covRefreshing = true;
  try {
    let changed = false;
    for (const it of lastSnap.items) {
      let txt = "";
      if (it.syncState === "cloud-only") {
        const cov = await fileOf(it.path).stagingCoverage();
        txt = !cov ? "" : cov.complete ? "\u5DF2\u7F13\u5B58\u53EF\u79BB\u7EBF" : `\u7F13\u5B58${Math.round(cov.bytes / cov.totalBytes * 100)}%\u6709\u6D1E`;
      }
      if ((covBadge.get(it.path) ?? "") !== txt) {
        txt ? covBadge.set(it.path, txt) : covBadge.delete(it.path);
        changed = true;
      }
    }
    if (changed) renderList();
  } finally {
    covRefreshing = false;
  }
}
function renderList() {
  if (!lastSnap) return;
  listEl.innerHTML = "";
  if (currentFolder) addRow("\u2B06 \u8FD4\u56DE\u4E0A\u7EA7", () => watch(currentFolder.includes("/") ? currentFolder.slice(0, currentFolder.lastIndexOf("/")) : ""));
  for (const f of lastSnap.folders) addRow(`\u{1F4C1} ${f.split("/").pop()}`, () => watch(f));
  for (const it of lastSnap.items) {
    const name = it.path;
    const isAudio = AUDIO_EXT.has(name.split(".").pop().toLowerCase());
    const row = document.createElement("div");
    row.className = "row" + (name === current ? " playing" : "");
    const label = document.createElement("span");
    const extra = pinProgress.get(name) ?? covBadge.get(name);
    label.textContent = `${isAudio ? "\u{1F3B5}" : "\u{1F4C4}"} ${name.split("/").pop()}\uFF08${it.syncState}${extra ? "\xB7" + extra : ""}\uFF09`;
    label.onclick = () => {
      if (isAudio) void play(name);
    };
    row.append(label);
    const pin = document.createElement("button");
    const kept = it.syncState !== "cloud-only";
    pin.textContent = kept ? "\u2715\u79BB\u7EBF" : "\u7559\u79BB\u7EBF";
    pin.onclick = async () => {
      const f = store.file(name, { isZip: false, mode: "existing" });
      try {
        if (kept) {
          try {
            await f.offload();
            log(`\u5DF2\u79FB\u9664\u79BB\u7EBF\uFF1A${name}`);
          } catch (e) {
            log(`offload \u62D2\u7EDD\uFF1A${e.message}`);
          }
        } else {
          log(`\u7559\u79BB\u7EBF\u5F00\u59CB\uFF1A${name}`);
          const t0 = Date.now();
          await f.keepOffline({ onProgress: (d, t) => {
            pinProgress.set(name, `${Math.round(d / t * 100)}%`);
            renderList();
          } });
          pinProgress.delete(name);
          log(`\u7559\u79BB\u7EBF\u5B8C\u6210\uFF1A${name}\uFF08${((Date.now() - t0) / 1e3).toFixed(1)}s\uFF09\u2605\u82E5\u5148\u64AD\u8FC7/\u5DF2\u7F13\u5B58\u5E94\u5FEB\uFF08\u53EA\u8865\u7F3A\u53E3\uFF09`);
        }
      } catch (e) {
        log(`\u{1F6D1} \u7559\u79BB\u7EBF/\u79FB\u9664\u5F02\u5E38\uFF1A${name}\uFF1A${e.message}`);
        pinProgress.delete(name);
      }
      renderList();
      if (current && mode === "folder") void prefetchNextHead(current);
    };
    row.append(pin);
    listEl.append(row);
  }
  void refreshCovBadges();
}
function addRow(text, onclick) {
  const row = document.createElement("div");
  row.className = "row folder";
  row.textContent = text;
  row.onclick = onclick;
  listEl.append(row);
}
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener("change", () => {
    mode = r.value;
    audio.loop = mode === "single";
    log(`\u6A21\u5F0F \u2192 ${mode}`);
    if (mode === "folder" && current) void prefetchNextHead(current);
  });
}
document.getElementById("seed").addEventListener("click", async () => {
  const specs = [["\u7532-10\u79D2-440Hz", 10, 440], ["\u4E59-12\u79D2-660Hz", 12, 660], ["\u4E19-90\u79D2-330Hz", 90, 330]];
  const t = /* @__PURE__ */ new Date();
  const batch = `${String(t.getHours()).padStart(2, "0")}${String(t.getMinutes()).padStart(2, "0")}`;
  for (const [label, secs, freq] of specs) {
    const name = `spike-test/${label}-${batch}.wav`;
    try {
      const r = await store.file(name, { isZip: false, mode: "new" }).save(makeWav(secs, freq));
      log(`\u64AD\u79CD ${name}\uFF1A${r.pushed ? "\u5DF2\u4E0A\u4E91" : `\u53EA\u843D\u672C\u5730\uFF08${r.reason}\uFF09`}`);
    } catch {
      try {
        const r = await store.file(name, { isZip: false, mode: "existing" }).save(makeWav(secs, freq));
        log(`\u64AD\u79CD ${name}\uFF08\u5DF2\u6709\u2192\u8865\u63A8\uFF09\uFF1A${r.pushed ? "\u5DF2\u4E0A\u4E91" : `\u4ECD\u53EA\u5728\u672C\u5730\uFF08${r.reason}\uFF09`}`);
      } catch (e2) {
        log(`\u64AD\u79CD ${name} \u5931\u8D25\uFF1A${e2.message}`);
      }
    }
  }
  watch("spike-test");
});
function makeWav(secs, freq) {
  const rate = 44100, n = rate * secs;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 2e3, (n - i) / 2e3);
    const beep = Math.sin(2 * Math.PI * freq * i / rate) * (Math.floor(i / rate) % 2 ? 1 : 0.4);
    v.setInt16(44 + i * 2, Math.round(beep * env * 12e3), true);
  }
  return new Uint8Array(buf);
}
document.getElementById("ver").textContent = SPIKE_V;
navigator.serviceWorker.addEventListener("message", (e) => {
  const m = e.data?.br2log;
  if (m) log(`[SW] ${m}`);
});
var booted = false;
function proceedSignedIn() {
  if (booted) return;
  booted = true;
  log(`\u5DF2\u767B\u5F55\uFF1A${String(auth.getActiveAccount()?.username ?? "")}`);
  document.getElementById("login").hidden = true;
  const bridge = startSwAuthBridge({ dbName: DB_NAME, getToken: () => auth.getToken() });
  void bridge.ready.then(() => log("\u51ED\u636E\u6865\u5C31\u7EEA\uFF08SW \u53EF\u53D6 token\uFF09"));
  void store.files.drainOfflineQueue().then(() => log("\u79BB\u7EBF\u8865\u63A8\u961F\u5217\u5DF2\u6392\u7A7A")).catch((e) => log(`\u8865\u63A8\u5F02\u5E38\uFF1A${e.message}`));
  watch("");
}
(async () => {
  log(`BR v2 ${SPIKE_V} \u542F\u52A8`);
  await ensureSw();
  const st = await auth.initAuth();
  if (st.signedIn || await auth.retrySilentSignIn()) {
    proceedSignedIn();
    return;
  }
  log("\u672A\u767B\u5F55\uFF1A\u70B9\u4E0B\u9762\u6309\u94AE\u5F00\u65E7 BR \u9875\u767B\u5F55\u4E00\u6B21\uFF0C\u56DE\u672C\u9875\u540E\u4F1A\u81EA\u52A8\u63A5\u4E0A\uFF08\u540C clientId \u9759\u9ED8\u590D\u7528\uFF09");
  const btn = document.getElementById("login");
  btn.textContent = "\u53BB\u65E7 BR \u767B\u5F55\uFF08\u767B\u5F55\u5B8C\u56DE\u672C\u9875\uFF09";
  btn.hidden = false;
  btn.addEventListener("click", () => {
    window.open("../", "_blank");
  });
  const retry = async () => {
    if (booted) return;
    if (await auth.retrySilentSignIn()) {
      log("\u68C0\u6D4B\u5230\u767B\u5F55\u6001\uFF0C\u63A5\u4E0A\u4E86");
      proceedSignedIn();
    }
  };
  addEventListener("focus", () => void retry());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void retry();
  });
  watch("");
})();
