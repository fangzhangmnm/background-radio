# 离线降级 + 两级 IndexedDB 缓存

## TL;DR

- 离线分**两层**:**app shell** 走 SW(本地缓存的 HTML/JS/CSS),**音频内容**走 IndexedDB(本地 blob)。
- IDB 缓存设计成**两级共用同一个 cap**:
  - **pinned** —— 用户显式 pin 的曲。**LRU 淘汰跳过**,容量塞不下时**新写入静默 skip**(不挤出 pinned)
  - **非 pinned** —— 自动 / 旁路缓存进来的,按 `lastPlayed` LRU 淘汰
- **完全 offline 时**(MSAL CDN 拉不到 / Graph 不可达)→ app shell 起来,渲染从 `cache.listAllMeta()` 派生,**只展示已缓存的曲**。不假装能浏览整个 OneDrive。
- "Library snapshot" 不另存。直接从 `cache.meta` 派生(只列你 cache 过的曲)。OneDrive 是 SSOT,**不存 OneDrive listing 副本**(invalidate 是坑)。

## 两层缓存的分工

| 层 | 存什么 | 用什么 | TTL | 失效靠 |
|---|---|---|---|---|
| App shell | HTML/JS/CSS/icons/manifest + MSAL.js(钉版本)| SW Cache API | SWR + CACHE_VERSION bump | 改 precache 文件后 bump |
| 音频 blob | mp3 字节 | IndexedDB | 无(content-addressed by trackId)| LRU 淘汰 + 用户手动 |

**OneDrive metadata 任何形态都不缓存**(folder listing、downloadUrl、driveItem 属性等)。Passthrough 直连 Graph。

## IDB schema

```js
const STORE_BLOBS = "blobs";   // key = trackId, value = Blob
const STORE_META  = "meta";     // key = trackId,
                                 // value = { trackId, size, type, lastPlayed,
                                 //           pinned, parentFolderId,
                                 //           parentFolderName, duration }
```

`parentFolderId` / `parentFolderName` 跟 blob 一起存的关键原因 → **离线时可以从 cache.meta 派生 listing**,不需要现拉 Graph。

`pinned: boolean` 是 LRU 淘汰的 gate。

## set + ensureRoom + 静默 skip

```js
async function ensureRoom(reserveBytes) {
  const all = await listAllMeta();
  const pinnedSize = all.filter(m => m.pinned).reduce((a, m) => a + m.size, 0);
  // pinned 占的 + 新 blob > cap → 永远塞不下,放弃
  if (pinnedSize + reserveBytes > capBytes) return false;
  // 淘汰非 pinned LRU
  const evictable = all.filter(m => !m.pinned)
                       .sort((a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0));
  let total = all.reduce((a, m) => a + m.size, 0);
  for (const m of evictable) {
    if (total + reserveBytes <= capBytes) break;
    await del(m.trackId);
    total -= m.size;
  }
  return true;
}

export async function set(trackId, blob, extraMeta = {}) {
  if (blob.size > capBytes) return false;       // 单首就超 cap
  const ok = await ensureRoom(blob.size);
  if (!ok) return false;                          // 静默 skip
  // ... 写入 blobs + meta
  return true;
}
```

**关键设计**:`set` 返回 `boolean` 而不是 throw。caller 静默接受,UI 上提示 toast("缓存上限到了"),不影响其它逻辑。

## 缓存 UI:3 态 pin icon

每个文件行右侧一个 button:

| 状态 | 视觉 | 点击行为 |
|---|---|---|
| empty(没缓存)| 空心下载箭头 outline,灰 | 触发 backgroundCacheTrack + pinAfter=true,UI 进 loading |
| loading | 同箭头 + 脉冲动画 | 再点 = 调 AbortController abort 下载 |
| cached(自动缓存,非 pinned)| 实心下载箭头,deep accent | 点 = `cache.setPinned(true)` |
| pinned | 实心锁图标,accent | 点 = `cache.setPinned(false)`,回到 cached(可淘汰)态 |

长按 600ms = 删除 cache。配 `stopImmediatePropagation` 才能拦住行 click(下面"长按陷阱")。

`AbortController` 设计:每个正在 fetching 的 trackId 关联一个,Map 存。loading 态再点就 `controller.abort()` + UI 回 empty。

## 长按陷阱

```js
function attachLongPress(el, handler, ms = 600) {
  let timer = null, fired = false, startX = 0, startY = 0;
  
  const start = (e) => {
    fired = false;
    const t = e.touches?.[0];
    startX = t?.clientX ?? e.clientX ?? 0;
    startY = t?.clientY ?? e.clientY ?? 0;
    timer = setTimeout(() => { fired = true; handler(); }, ms);
  };
  const cancel = () => { if (timer) clearTimeout(timer), timer = null; };
  const move = (e) => {
    // 移动 > 10px 才取消(手指轻微抖动忽略)
    const t = e.touches?.[0];
    const x = t?.clientX ?? e.clientX ?? 0;
    const y = t?.clientY ?? e.clientY ?? 0;
    if (Math.hypot(x - startX, y - startY) > 10) cancel();
  };
  
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", move, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
  el.addEventListener("mousedown", start);
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
  
  // 长按触发后,立即来的 click 要拦下来,否则 row 的 click handler 会接到
  el.addEventListener("click", (e) => {
    if (fired) {
      e.stopImmediatePropagation();   // ⚠️ 不是 stopPropagation!
      e.preventDefault();
      fired = false;
    }
  }, true);
}
```

两条容易踩的:

1. **`touchmove` 没阈值就 cancel** → 手指轻微抖动直接废了 timer,用户以为按了 600ms 实际没到。加 10px 距离阈值。
2. **`stopPropagation` 拦不住同元素上更早注册的 listener**。`stopImmediatePropagation` 才行。而且 long-press attach 要在 row click listener **之前**注册(同元素上 listener 按注册顺序触发,capture flag 在 target 阶段不影响顺序)。

## 离线模式 = 从 cache 派生 listing

```js
async function renderBrowserFromCache() {
  const all = await cache.listAllMeta();
  // 平铺所有已缓存,按文件夹名 + 文件名排序
  all.sort((a, b) =>
    (a.parentFolderName || "").localeCompare(b.parentFolderName || "") ||
    (a.name || "").localeCompare(b.name || "")
  );
  // ... render
}
```

**不试着重建文件夹层级**(`..` 导航在离线模式下没意义,因为我们只知道 cache 里有的东西)。直接平铺 + 按文件夹名分组显示就够了。

## 离线模式触发

```js
async function initAuth() {
  let msal;
  try {
    msal = await loadMsal();
  } catch (e) {
    return { signedIn: false, account: null, offline: true, msalError: e.message };
  }
  // ... normal MSAL setup
}
```

MSAL CDN 拉不到 → `result.offline = true` → app 进 cache-only 模式:

```js
if (result.offline) {
  offlineMode = true;
  document.body.classList.add("offline");
  btnLogin.hidden = true;       // login 没意义,disable
  userEl.textContent = "离线 · 仅缓存可用";
  await renderBrowser();         // 内部检测 offlineMode,走 fromCache 路径
  await restoreSession();        // 内部检测 offlineMode,只查 IDB,不试 Graph
  return;
}
```

`document.body.classList.add("offline")` 让 CSS 加一个状态条(顶栏 `⊘` 前缀提示用户当前是离线)。

## Resume 的双路径

```js
async function tryEarlyCacheResume() {
  if (!state.currentTrack) return;
  const blob = await cache.getBlob(state.currentTrack.id);
  if (!blob) return;
  // 不等 MSAL / Graph,直接装 audio + enable play button
  currentBlobUrl = URL.createObjectURL(blob);
  audio.src = currentBlobUrl;
  enablePlayBtn();
  // ... siblings 也从 cache.meta 派生
  audio.play().catch(() => {});   // 试 autoplay,失败也无所谓,button 已可点
}
```

main() 里**先**调 `tryEarlyCacheResume()`(不 await,fire-and-forget),**后**await MSAL / Graph。

iOS 上 MSAL CDN 拉 + silent token probe 可能 1-3 秒,这段时间 cached track 已经 ready 可放。冷启动从"~3s 才能点"降到"~0.5s 就能点"。

## 不要做的事(被用户明确拒绝过)

**不要 cache OneDrive folder listing**。理由:用户对"缓存失效"的容忍度低 —— "缓存失效永远是坑,OneDrive 是 SSOT"。

具体禁忌:
- 不要"加速冷启动"为由 cache `/me/drive/.../children` 响应
- 不要 stash 最近播放的 driveItem metadata
- 不要 stale-while-revalidate folder tree

**唯一**例外:**audio blob by trackId** —— 这是 content-addressed 的(不同 bytes = 不同 trackId 的可能性低,即使 OneDrive 文件被替换 ID 也可能变),用户能长按手动删,失效靠用户。

## 监控用户认知

用户提到"飞机上能看 cache,但音乐跟论文 / 写作 app 不一样"—— **整个 library cache 不现实**(几十 GB),所以 cache 不是"备份",是"选择性下载"。pin icon 是用户控制器,用户决定哪些必须随身带。**这是设计的核心心智模型,不要偷偷自动 cache 大量东西**。
