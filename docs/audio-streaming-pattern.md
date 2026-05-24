# 用浏览器原生 `<audio>` 直接喂预签名 URL 的模式

## TL;DR

- 远端音频用 `<audio src=preSignedUrl>` 直接给,**不要写 streaming proxy / 自己 fetch 字节**。浏览器原生处理 Range、seek、buffer。
- 预签名 URL(OneDrive、S3 pre-signed、CloudFront signed cookie...)都符合这套。
- 续期靠 `audio.error` 事件 → 重取 URL → 记下 `currentTime` → 重设 src → 在 `loadedmetadata` 里跳回原位置。
- iOS PWA standalone 没 user gesture **不能 autoplay**。Resume-on-open 的落地形态:打开 app 不放,等用户点一下大播放键。

## 为什么不写 proxy

写一个 streaming proxy(自己 fetch downloadUrl,把字节再喂给 audio 或 MediaSource Extensions)能拿到的好处:加 token、加自定义 header、做转码、做 token 解密。这些**这个场景一个都不需要**。

代价:
- 自己处理 Range header 协商
- 自己处理大文件的 buffer / 流控
- 失去原生 seek 的硬件优化
- iOS 上 MSE 支持限制多

直接 `audio.src = signedUrl` 把这一切交给浏览器,代码薄一大截。

## 续期模式

```js
audio.addEventListener("error", async () => {
  const code = audio.error?.code;
  // 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
  // 这里最常见的是 2(URL 过期 → 401 / 403 / 410)
  await reloadWithFreshUrl();
});

async function reloadWithFreshUrl() {
  const fresh = await fetchTrackMetadata(currentTrackId);
  const pos = audio.currentTime || savedPosition;
  audio.src = fresh.downloadUrl;
  audio.addEventListener("loadedmetadata", () => {
    audio.currentTime = pos;
    audio.play();
  }, { once: true });
}
```

注意 **`currentTime` 必须在 `loadedmetadata` 之后设**,在那之前设 Safari 会静默丢弃。所以 `restorePosition` 永远用一次性 listener。

## Resume on open(打开 app 恢复曲目位置)

```js
function restoreOnOpen() {
  // 不自动设 audio.src!
  // iOS PWA standalone 无 user gesture autoplay 会失败,且会消耗一个 downloadUrl
  showTrackName(savedTrack.name);
  showPosition(savedPosition);
  // 等用户点 ▶
}

playButton.addEventListener("click", async () => {
  if (!audio.src) {
    // 第一次点 = resume
    const fresh = await fetchTrackMetadata(savedTrack.id);
    audio.src = fresh.downloadUrl;
    audio.addEventListener("loadedmetadata", () => {
      audio.currentTime = savedPosition;
      audio.play();
    }, { once: true });
    return;
  }
  audio.paused ? audio.play() : audio.pause();
});
```

这一点跟 proposal 的"打开即停在 player 页、显示已恢复的曲目、一个巨大的播放键,点一下接着放"对应。

## Blob 缓存(IndexedDB)— 已 ship,两级共用一个 cap

把整首 mp3 缓存进 IndexedDB,key = trackId,value = Blob。命中时 `URL.createObjectURL(blob)` 喂 audio,切歌前 `revokeObjectURL` 释放;未命中走预签名 URL。

两条**经过推敲的原则**:

1. **Blob 的常驻地是 IndexedDB,不是 JS heap**。不要 `let cachedBlob = ...` 长期挂在 JS 变量上。iOS standalone PWA 下,长期持有的大 ArrayBuffer / Blob 会被记成不可回收内存;前台其它 app(导航、车机)挤一下就被踢。
2. **不自动缓存**(最终方案)。中间试过"首播不入,二播再入"、"`ended` 时自动入库"等触发,所有自动方案都涉及"audio.src 流式 + 后台 fetch 全量"的**双下载问题**。用户最后明确不接受双下载,改成**仅用户点 pin 才进 cache**。MediaSource Extensions 能 tee 一份 stream 给 cache 实现真正单次下载,但代价高(iOS 17+ only、Range 拼装麻烦、~150 行代码),没上。

**两级 cache 共用一个 cap**:
- pinned(用户点 pin 显式下载)→ LRU 淘汰跳过,容量塞不下时新写入静默 skip(不挤掉 pinned)
- 自动 / 旁路写入的(理论上,本项目最终没有自动写入,但数据结构留着)→ LRU 按 `lastPlayed` 淘汰

```js
const STORE_BLOBS = "blobs";   // key = trackId, value = Blob
const STORE_META  = "meta";     // { trackId, size, type, lastPlayed,
                                 //   pinned, parentFolderId, parentFolderName, duration }
```

`parentFolderId` / `parentFolderName` 跟 blob 一起存,**为了离线模式从 cache.meta 派生 listing**。

容量 cap 默认 250MB(iOS 友好,长歌 200MB 一首装得下不止一首),用户菜单可改。详见 [offline-and-cache-tiers.md](offline-and-cache-tiers.md)。

## 音频元素事件清单(用得上的)

| 事件 | 干嘛用 |
|---|---|
| `loadedmetadata` | 拿到 duration、设置 currentTime |
| `timeupdate` | 更新 UI 位置(频率 ~4Hz,够用) |
| `play` / `pause` | 改 UI、更新 Media Session 状态、保存位置 |
| `ended` | 进 loop 逻辑 |
| `error` | URL 过期 / 网络问题,触发 refetch |
| `canplay` | (一般不用)缓冲够开始播了 |
| `waiting` | (一般不用)缓冲跟不上 |

## 坑

- **`audio.preload = "metadata"` 在 iOS 上未必生效**,iOS 经常延迟到第一次 play 才真的加载。所以"显示 duration"得等 play 之后,不能依赖 page load 后立刻有 duration。
- **`audio.duration` 在 metadata 没 load 前是 `NaN`**,任何 UI 显示前判 `isFinite`。
- **设 `currentTime` 在 metadata 之前会被丢弃**(尤其 Safari),必须 `loadedmetadata` 里设。
- **autoplay 被拒**(无 user gesture)抛 promise rejection,不是 `error` 事件,要 `play().catch(...)`。
- **同一首歌 single-loop 重播**:不要 `audio.load()` 重新拉,直接 `audio.currentTime = 0; audio.play()`,buffer 还在,无缝。
