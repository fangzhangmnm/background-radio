"use strict";
(() => {
  // node_modules/@internal/store/dist/idb-store.js
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
    function reqTx(mode, run) {
      return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
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
            if (!cur)
              return;
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

  // node_modules/@internal/store/dist/blob-partition.js
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

  // node_modules/@internal/store/dist/providers/graph.js
  var _tokenSource = null;
  function configureGraphTokenSource(fn) {
    _tokenSource = fn;
  }
  async function getToken() {
    if (!_tokenSource)
      throw new Error("graph token source \u672A\u914D\u7F6E\uFF08\u9875\u9762\u8D70 createOneDriveProvider\uFF1BSW \u8D70 configureGraphTokenSource(createBridgeTokenSource(dbName))\uFF09");
    return _tokenSource();
  }
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
        if (!init.headers["Content-Type"])
          init.headers["Content-Type"] = "application/json";
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
  async function getItemByPath(path) {
    try {
      const r = await graphFetch("GET", `/me/drive/special/approot:/${encodeApprootPath(path)}?$select=id,name,size,eTag,lastModifiedDateTime,folder,@microsoft.graph.downloadUrl`);
      return await r.json();
    } catch (e) {
      if (e.status === 404)
        return null;
      throw e;
    }
  }
  var _dlUrlCache = /* @__PURE__ */ new Map();
  async function downloadItemRange(itemId, offset, length) {
    let url = _dlUrlCache.get(itemId) ?? await getDownloadUrl(itemId);
    if (url) {
      _dlUrlCache.set(itemId, url);
      try {
        return await downloadRangeFromUrl(url, offset, length);
      } catch (_e) {
        _dlUrlCache.delete(itemId);
        url = await getDownloadUrl(itemId);
        if (url) {
          _dlUrlCache.set(itemId, url);
          return await downloadRangeFromUrl(url, offset, length);
        }
      }
    }
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

  // node_modules/@internal/store/dist/sw/bridge.js
  function createBridgeTokenSource(dbName) {
    const bridge = createPartitionedBlobStore(dbName).partition("sw-bridge");
    return async () => {
      const r = await bridge.get("token");
      if (!r)
        throw new Error("\u51ED\u636E\u6865\u65E0 token\uFF08\u672A\u767B\u5F55\u6216\u9875\u9762\u6865\u672A\u542F\u52A8\uFF09");
      const p = JSON.parse(await r.blob.text());
      if (p?.v === 1 && typeof p.token === "string")
        return p.token;
      throw new Error("\u51ED\u636E\u6865 token \u8BB0\u5F55\u4E0D\u53EF\u8BFB");
    };
  }

  // node_modules/@internal/store/dist/sw/gateway.js
  var CHUNK_DEFAULT = 2 * 1024 * 1024;
  function parseRange(h, size) {
    if (!h)
      return null;
    const m = /^bytes=(\d+)-(\d*)$/.exec(h.trim());
    if (!m)
      return null;
    const start = Math.min(Number(m[1]), Math.max(0, size - 1));
    const end = m[2] === "" ? null : Math.min(Number(m[2]), size - 1);
    return { start, end };
  }
  function createSwStreamGateway(cfg) {
    const chunkBytes = cfg.chunkBytes ?? CHUNK_DEFAULT;
    const slog = (m) => {
      try {
        cfg.onLog?.(m);
      } catch {
      }
    };
    const bs = createPartitionedBlobStore(cfg.dbName);
    const staging = bs.partition("staging");
    const dirIdx = bs.partition("dir-index-cache");
    let cloud = cfg.cloud;
    if (!cloud) {
      configureGraphTokenSource(createBridgeTokenSource(cfg.dbName));
      cloud = { getItemByPath, downloadItemRange };
    }
    const resolveCache = /* @__PURE__ */ new Map();
    const etagVerified = /* @__PURE__ */ new Map();
    async function resolve(name) {
      const hit = resolveCache.get(name);
      if (hit)
        return hit;
      try {
        const folder = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
        const rec = await dirIdx.get(folder);
        if (rec) {
          const p = JSON.parse(await rec.blob.text());
          const f = p?.v === 1 ? p.files?.find((x) => x.name === name) : void 0;
          if (f?.id && typeof f.size === "number" && f.eTag) {
            const r2 = { id: f.id, size: f.size, eTag: f.eTag };
            resolveCache.set(name, r2);
            slog(`\u89E3\u6790 ${name} \u2190 dir-index-cache\uFF08id=${f.id.slice(0, 8)}\u2026 size=${f.size}\uFF09`);
            return r2;
          }
          slog(`dir-index-cache \u6709\u5939\u8BB0\u5F55\u4F46\u65E0 ${name} \u6761\u76EE \u2192 \u8D70 Graph`);
        }
      } catch {
      }
      let j = null;
      try {
        j = await cloud.getItemByPath(name);
      } catch (e) {
        slog(`Graph \u89E3\u6790\u5F02\u5E38\uFF1A${String(e?.message ?? e).slice(0, 160)}`);
        return null;
      }
      if (!j?.id) {
        slog(`\u89E3\u6790 ${name} \u5931\u8D25\uFF08Graph \u515C\u5E95\u4E5F\u6CA1\u62FF\u5230\uFF09`);
        return null;
      }
      slog(`\u89E3\u6790 ${name} \u2190 Graph\uFF08size=${j.size}\uFF09`);
      const r = { id: j.id, size: j.size ?? 0, eTag: j.eTag ?? "" };
      resolveCache.set(name, r);
      return r;
    }
    async function ensureStagingFresh(name, item) {
      if (etagVerified.get(name) === item.eTag)
        return;
      try {
        const mrec = await staging.get(`meta:${name}`);
        if (mrec) {
          const m = JSON.parse(await mrec.blob.text());
          if (m?.eTag && m.eTag !== item.eTag) {
            const prefix = `chunk:${name}:`;
            for (const k of await staging.keys())
              if (k === `meta:${name}` || k.startsWith(prefix))
                await staging.del(k);
            slog(`\u9648\u5206\u7247\u5B88\u536B\uFF1A${name} staging \u662F\u65E7\u7248\uFF08${m.eTag.slice(0, 8)}\u2026\u2260${item.eTag.slice(0, 8)}\u2026\uFF09\u2192 \u6574\u7EC4\u5DF2\u6E05`);
          }
        }
      } catch {
      }
      etagVerified.set(name, item.eTag);
    }
    const inflight = /* @__PURE__ */ new Map();
    function getChunk(name, item, i) {
      const key = `${name}:${i}`;
      const existing = inflight.get(key);
      if (existing)
        return existing;
      const job = (async () => {
        await ensureStagingFresh(name, item);
        try {
          const c = await staging.get(`chunk:${name}:${i}`);
          if (c) {
            slog(`\u5206\u7247 ${i} \u2190 staging`);
            return new Uint8Array(await c.blob.arrayBuffer());
          }
        } catch {
        }
        const off = i * chunkBytes;
        const len = Math.min(chunkBytes, item.size - off);
        const bytes = new Uint8Array(await cloud.downloadItemRange(item.id, off, len));
        slog(`\u5206\u7247 ${i} \u2190 \u4E91\u7AEF\uFF08${bytes.length}B\uFF09`);
        try {
          await staging.put(`chunk:${name}:${i}`, { blob: new Blob([bytes]), updatedAt: Date.now() });
          const mrec = await staging.get(`meta:${name}`);
          let m = null;
          if (mrec) {
            try {
              m = JSON.parse(await mrec.blob.text());
            } catch {
              m = null;
            }
          }
          if (!m || m.eTag !== item.eTag)
            m = { v: 1, eTag: item.eTag, totalBytes: item.size, chunkBytes, chunks: [], touchedAt: Date.now() };
          if (!m.chunks.includes(i))
            m.chunks.push(i);
          m.touchedAt = Date.now();
          await staging.put(`meta:${name}`, { blob: new Blob([JSON.stringify(m)]), updatedAt: Date.now() });
        } catch {
        }
        return bytes;
      })();
      inflight.set(key, job);
      job.finally(() => inflight.delete(key)).catch(() => {
      });
      return job;
    }
    function matches(url) {
      return url.pathname.startsWith(cfg.streamPrefix);
    }
    async function handle(req) {
      try {
        return await handleInner(req);
      } catch (e) {
        const msg = String(e?.message ?? e);
        slog(`\u{1F6D1} \u7F51\u5173\u9519\u8BEF\uFF1A${msg}`);
        return new Response(`\u7F51\u5173\u9519\u8BEF\uFF1A${msg}`, { status: 502 });
      }
    }
    async function handleInner(req) {
      const url = new URL(req.url);
      const name = decodeURIComponent(url.pathname.slice(cfg.streamPrefix.length));
      slog(`\u8BF7\u6C42 ${name}\uFF08Range: ${req.headers.get("Range") ?? "\u65E0"}\uFF09`);
      let full = null;
      try {
        const r = await bs.partition("files").get(name);
        if (r)
          full = r.blob;
      } catch {
      }
      if (full)
        slog(`${name} \u2190 \u672C\u5730\u6B63\u5F0F\u526F\u672C\uFF08${full.size}B\uFF09`);
      const item = full ? null : await resolve(name);
      if (!full && !item) {
        slog(`\u{1F6D1} ${name} 404\uFF1A\u672C\u5730\u65E0\u526F\u672C\u4E14\u89E3\u6790\u5931\u8D25`);
        return new Response("\u672A\u627E\u5230\uFF08\u672A\u767B\u5F55\u6216\u4E91\u7AEF\u65E0\u6B64\u6587\u4EF6\uFF09", { status: 404 });
      }
      const size = full ? full.size : item.size;
      const ct = cfg.contentType?.(name) ?? "application/octet-stream";
      const baseHeaders = { "Accept-Ranges": "bytes", "Content-Type": ct, "Cache-Control": "no-store" };
      const range = parseRange(req.headers.get("Range"), size) ?? { start: 0, end: null };
      const WINDOW_CHUNKS = 2;
      const start = range.start;
      const end = range.end ?? Math.min(size - 1, (Math.floor(start / chunkBytes) + WINDOW_CHUNKS) * chunkBytes - 1);
      const readWindow = async () => {
        if (full)
          return new Uint8Array(await full.slice(start, end + 1).arrayBuffer());
        const i0 = Math.floor(start / chunkBytes), i1 = Math.floor(end / chunkBytes);
        const buf = new Uint8Array(end - start + 1);
        let w = 0;
        for (let i = i0; i <= i1; i++) {
          const c = await getChunk(name, item, i);
          const cs = i * chunkBytes;
          const from = Math.max(start, cs) - cs, to = Math.min(end + 1, cs + c.length) - cs;
          buf.set(c.subarray(from, to), w);
          w += to - from;
        }
        return buf;
      };
      const body = await readWindow();
      slog(`\u7B54 206\uFF1Abytes ${start}-${end}/${size}\uFF08${body.length}B\uFF0C${full ? "\u672C\u5730" : "\u4E91\u7AEF"}\uFF09`);
      return new Response(body, {
        status: 206,
        headers: { ...baseHeaders, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(body.length) }
      });
    }
    return { matches, handle };
  }

  // src/sw.ts
  var sw = self;
  var SHELL_CACHE = "br2-shell-v1";
  var SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./icon-192.png", "../vendor/msal/msal-browser.min.js"];
  var MIME = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg" };
  function swLog(msg) {
    void sw.clients.matchAll({ includeUncontrolled: true }).then((cs) => {
      for (const c of cs) c.postMessage({ br2log: msg });
    });
  }
  var gw = createSwStreamGateway({
    dbName: "br.defaultStore",
    streamPrefix: new URL("./stream/", sw.registration.scope).pathname,
    contentType: (n) => MIME[n.split(".").pop().toLowerCase()] ?? "application/octet-stream",
    // 内容知识在 app 侧（store 网关内容盲）
    onLog: swLog
  });
  sw.addEventListener("install", (e) => {
    e.waitUntil((async () => {
      const c = await caches.open(SHELL_CACHE);
      for (const u of SHELL) {
        try {
          await c.add(new Request(u, { cache: "no-cache" }));
        } catch {
        }
      }
      await sw.skipWaiting();
    })());
  });
  sw.addEventListener("activate", (e) => {
    e.waitUntil(sw.clients.claim());
  });
  async function shellNetworkFirst(req) {
    const c = await caches.open(SHELL_CACHE);
    try {
      const r = await fetch(req);
      if (r.ok) void c.put(req, r.clone());
      return r;
    } catch {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error("\u79BB\u7EBF\u4E14 shell \u7F13\u5B58\u65E0\u6B64\u4EF6");
    }
  }
  sw.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);
    if (gw.matches(url)) {
      e.respondWith(gw.handle(e.request));
      return;
    }
    if (e.request.method !== "GET" || url.origin !== location.origin) return;
    const inScope = url.pathname.startsWith(new URL("./", sw.registration.scope).pathname);
    const isMsal = url.pathname.includes("/vendor/msal/");
    if (inScope || isMsal) e.respondWith(shellNetworkFirst(e.request));
  });
})();
