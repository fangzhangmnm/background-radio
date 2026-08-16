"use strict";
(() => {
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

  // ../../20260813 internal-store/src/sw/gateway.ts
  var GRAPH_BASE = "https://graph.microsoft.com/v1.0";
  var CHUNK_DEFAULT = 2 * 1024 * 1024;
  function parseRange(h, size) {
    if (!h) return null;
    const m = /^bytes=(\d+)-(\d*)$/.exec(h.trim());
    if (!m) return null;
    const start = Math.min(Number(m[1]), Math.max(0, size - 1));
    const end = m[2] === "" ? null : Math.min(Number(m[2]), size - 1);
    return { start, end };
  }
  function createSwStreamGateway(cfg) {
    const chunkBytes = cfg.chunkBytes ?? CHUNK_DEFAULT;
    const bs = createPartitionedBlobStore(cfg.dbName);
    const staging = bs.partition("staging");
    const dirIdx = bs.partition("dir-index-cache");
    const bridge = bs.partition("sw-bridge");
    const urlCache = /* @__PURE__ */ new Map();
    const resolveCache = /* @__PURE__ */ new Map();
    async function getToken() {
      try {
        const r = await bridge.get("token");
        if (!r) return null;
        const p = JSON.parse(await r.blob.text());
        return p?.v === 1 && typeof p.token === "string" ? p.token : null;
      } catch {
        return null;
      }
    }
    const encodePath = (p) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    async function graphJson(path) {
      const token = await getToken();
      if (!token) return null;
      const r = await fetch(`${GRAPH_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      return await r.json();
    }
    async function resolve(name) {
      const hit = resolveCache.get(name);
      if (hit) return hit;
      try {
        const folder = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
        const rec = await dirIdx.get(folder);
        if (rec) {
          const p = JSON.parse(await rec.blob.text());
          const f = p?.v === 1 ? p.files?.find((x) => x.name === name) : void 0;
          if (f?.id && typeof f.size === "number" && f.eTag) {
            const r2 = { id: f.id, size: f.size, eTag: f.eTag };
            resolveCache.set(name, r2);
            return r2;
          }
        }
      } catch {
      }
      const j = await graphJson(`/me/drive/special/approot:/${encodePath(name)}?$select=id,size,eTag,@microsoft.graph.downloadUrl`);
      if (!j || typeof j.id !== "string") return null;
      const r = { id: j.id, size: j.size ?? 0, eTag: j.eTag ?? "" };
      if (typeof j["@microsoft.graph.downloadUrl"] === "string") urlCache.set(name, j["@microsoft.graph.downloadUrl"]);
      resolveCache.set(name, r);
      return r;
    }
    async function freshUrl(name, id) {
      const j = await graphJson(`/me/drive/items/${id}?$select=id,@microsoft.graph.downloadUrl`);
      const u = j?.["@microsoft.graph.downloadUrl"];
      if (typeof u !== "string") return null;
      urlCache.set(name, u);
      return u;
    }
    const inflight = /* @__PURE__ */ new Map();
    function getChunk(name, item, i) {
      const key = `${name}:${i}`;
      const existing = inflight.get(key);
      if (existing) return existing;
      const job = (async () => {
        try {
          const c = await staging.get(`chunk:${name}:${i}`);
          if (c) return new Uint8Array(await c.blob.arrayBuffer());
        } catch {
        }
        const off = i * chunkBytes;
        const len = Math.min(chunkBytes, item.size - off);
        const doFetch = async (url2) => fetch(url2, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
        let url = urlCache.get(name) ?? await freshUrl(name, item.id);
        if (!url) throw new Error(`\u65E0\u51ED\u636E/\u53D6\u4E0D\u5230 downloadUrl\uFF1A${name}`);
        let resp = await doFetch(url);
        if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
          url = await freshUrl(name, item.id);
          if (!url) throw new Error(`downloadUrl \u7EED\u671F\u5931\u8D25\uFF1A${name}`);
          resp = await doFetch(url);
        }
        if (!resp.ok && resp.status !== 206) throw new Error(`range \u62C9\u53D6\u5931\u8D25 ${resp.status}\uFF1A${name}`);
        const bytes = new Uint8Array(await resp.arrayBuffer());
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
          if (!m || m.eTag !== item.eTag) m = { v: 1, eTag: item.eTag, totalBytes: item.size, chunkBytes, chunks: [], touchedAt: Date.now() };
          if (!m.chunks.includes(i)) m.chunks.push(i);
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
      const url = new URL(req.url);
      const name = decodeURIComponent(url.pathname.slice(cfg.streamPrefix.length));
      const item = await resolve(name);
      if (!item) return new Response("\u672A\u627E\u5230\uFF08\u672A\u767B\u5F55\u6216\u4E91\u7AEF\u65E0\u6B64\u6587\u4EF6\uFF09", { status: 404 });
      let full = null;
      try {
        const r = await bs.partition("files").get(name);
        if (r) full = r.blob;
      } catch {
      }
      const size = full ? full.size : item.size;
      const ct = cfg.contentType?.(name) ?? "application/octet-stream";
      const baseHeaders = { "Accept-Ranges": "bytes", "Content-Type": ct, "Cache-Control": "no-store" };
      const range = parseRange(req.headers.get("Range"), size) ?? { start: 0, end: null };
      if (range.end != null) {
        const start2 = range.start, end = range.end;
        let body;
        if (full) body = new Uint8Array(await full.slice(start2, end + 1).arrayBuffer());
        else {
          const i0 = Math.floor(start2 / chunkBytes), i1 = Math.floor(end / chunkBytes);
          const parts = [];
          for (let i2 = i0; i2 <= i1; i2++) parts.push(await getChunk(name, item, i2));
          const buf = new Uint8Array(end - start2 + 1);
          let w = 0;
          for (let i2 = i0; i2 <= i1; i2++) {
            const c = parts[i2 - i0], cs = i2 * chunkBytes;
            const from = Math.max(start2, cs) - cs, to = Math.min(end + 1, cs + c.length) - cs;
            buf.set(c.subarray(from, to), w);
            w += to - from;
          }
          body = buf;
        }
        return new Response(body, {
          status: 206,
          headers: { ...baseHeaders, "Content-Range": `bytes ${start2}-${end}/${size}`, "Content-Length": String(end - start2 + 1) }
        });
      }
      const start = range.start;
      if (full) {
        const sliced = full.slice(start);
        return new Response(sliced.stream(), {
          status: start > 0 || req.headers.get("Range") ? 206 : 200,
          headers: start > 0 || req.headers.get("Range") ? { ...baseHeaders, "Content-Range": `bytes ${start}-${size - 1}/${size}`, "Content-Length": String(size - start) } : { ...baseHeaders, "Content-Length": String(size) }
        });
      }
      let i = Math.floor(start / chunkBytes);
      let skip = start - i * chunkBytes;
      const nChunks = Math.max(1, Math.ceil(size / chunkBytes));
      const stream = new ReadableStream({
        pull: async (controller) => {
          if (i >= nChunks) {
            controller.close();
            return;
          }
          const c = await getChunk(name, item, i);
          controller.enqueue(skip > 0 ? c.subarray(skip) : c);
          skip = 0;
          i++;
        },
        // cancel：播放器不要了（seek 走了/暂停够久）→ 停拉。已 tee 的分片留在 staging。
        cancel: () => {
        }
      });
      const isRange = !!req.headers.get("Range");
      return new Response(stream, {
        status: isRange ? 206 : 200,
        headers: isRange ? { ...baseHeaders, "Content-Range": `bytes ${start}-${size - 1}/${size}`, "Content-Length": String(size - start) } : { ...baseHeaders, "Content-Length": String(size) }
      });
    }
    return { matches, handle };
  }

  // src/sw.ts
  var sw = self;
  var MIME = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg" };
  var gw = createSwStreamGateway({
    dbName: "br-spike.defaultStore",
    streamPrefix: new URL("./stream/", sw.registration.scope).pathname,
    contentType: (n) => MIME[n.split(".").pop().toLowerCase()] ?? "application/octet-stream"
    // 内容知识在 app 侧（store 网关保持内容盲）
  });
  sw.addEventListener("install", () => {
    void sw.skipWaiting();
  });
  sw.addEventListener("activate", (e) => {
    e.waitUntil(sw.clients.claim());
  });
  sw.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);
    if (gw.matches(url)) e.respondWith(gw.handle(e.request));
  });
})();
