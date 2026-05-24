# Media Session API — 锁屏、系统媒体浮层、蓝牙耳机控制

## TL;DR

- Media Session 是让**锁屏 / Windows 系统媒体浮层 / 蓝牙耳机按键 / 方向盘媒体键**控制网页音频的唯一接口。开车 / 锁屏场景必装。
- 三件事必做:**metadata、action handlers、setPositionState**。
- handler 设 `null` = 该按钮在系统 UI 上消失;设函数 = 出现。
- iOS 上 handler **要在第一次 `audio.play()` 之后注册**才会显示在锁屏(无 user gesture 之前注册可能被忽略)。
- `setPositionState` 别太频繁,在 play / pause / seek / loadedmetadata 时调即可,**不**要塞进 timeupdate(每秒多次没必要)。

## 最小集成

```js
function hasMediaSession() {
  return "mediaSession" in navigator;
}

function updateMetadata(track, folderPath) {
  if (!hasMediaSession() || !track) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.name,
    artist: "Background Radio",      // 显示在 title 下
    album: folderPath,                // 通常不显示在浮层但 lockscreen 可能用
    // artwork: [{ src: "...", sizes: "512x512", type: "image/png" }],  // 可选
  });
}

function setMSHandler(action, handler) {
  try { navigator.mediaSession.setActionHandler(action, handler); }
  catch (_) { /* 该 action 浏览器不支持,忽略 */ }
}

function registerHandlers() {
  if (!hasMediaSession()) return;
  setMSHandler("play", () => audio.play().catch(() => {}));
  setMSHandler("pause", () => audio.pause());
  setMSHandler("seekbackward", e => {
    audio.currentTime = Math.max(0, audio.currentTime - (e.seekOffset || 10));
  });
  setMSHandler("seekforward", e => {
    audio.currentTime += (e.seekOffset || 30);
  });
  setMSHandler("seekto", e => {
    if (e.seekTime != null) audio.currentTime = e.seekTime;
  });
  setMSHandler("previoustrack", () => advance("prev"));
  setMSHandler("nexttrack", () => advance("next"));
}

function pushPositionState() {
  if (!hasMediaSession()) return;
  const dur = audio.duration;
  if (!isFinite(dur) || dur <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: dur,
      position: Math.min(audio.currentTime, dur),
      playbackRate: audio.playbackRate || 1,
    });
  } catch (_) {}
}
```

## 什么时候调什么

| 事件 | metadata | handlers | positionState | playbackState |
|---|---|---|---|---|
| 装载新曲(`loadedmetadata`)| ✅ | ✅(刷一遍) | ✅ | — |
| `play` | — | — | ✅ | "playing" |
| `pause` | — | — | — | "paused" |
| seek(rewind/forward/拖条)| — | — | ✅ | — |
| loop mode 改变 | — | ✅(prev/next 可能改可见性)| — | — |

`playbackState`:

```js
audio.addEventListener("play", () => {
  navigator.mediaSession.playbackState = "playing";
});
audio.addEventListener("pause", () => {
  navigator.mediaSession.playbackState = "paused";
});
```

不更新 playbackState 的话,系统 UI 上播放/暂停按钮的图标可能跟实际状态对不上。

## handler null 隐藏按钮

某些场景你不想让 prev/next 出现(例如单曲循环,跳曲无意义),直接:

```js
setMSHandler("previoustrack", null);
setMSHandler("nexttrack", null);
```

系统 UI 上这两个按钮就消失。再设回函数会重新出现。

(这个项目最后决定 prev/next 永远显示,所以没用 null,但这条机制值得记。)

## 各平台行为差异

- **Windows + Edge / Chrome**:Win+G 弹出的小媒体浮层、键盘多媒体键、Surface 笔的播放按钮都通过 Media Session 路由。屏幕角落的浮层也是。
- **macOS Safari**:支持,会在 Now Playing widget 显示。Touch Bar 旧机型上也有按钮。
- **iOS Safari**:**仅在 PWA standalone 模式下**才在锁屏 / 控制中心显示完整 widget。普通 Safari tab 只有基础控制。
- **Android Chrome**:支持,显示在通知栏。
- **蓝牙 / CarPlay / Android Auto**:走系统 Media Session,所以接了这个就自动支持。

## artwork 优先级

Media Metadata 里的 `artwork` 数组用法:

```js
artwork: [
  { src: "icon-96.png", sizes: "96x96", type: "image/png" },
  { src: "icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "icon-512.png", sizes: "512x512", type: "image/png" },
]
```

浏览器挑最合适的尺寸。**别忘了 type**,不写有些 UA 不识别。

artwork 必须是同源或 CORS 允许的。OneDrive driveItem 有 `thumbnails` 字段可以取 cover art,但需要 expand 且涉及 CORS,要测。

## 坑

- iOS 上**注册 handler 太早**(在 first play 之前)有时被忽略。稳妥做法是 `loadedmetadata` 里(此时 play 即将发生 / 已发生)再注册。
- 设了 metadata 但 `<audio>` 没 src 不会出现在系统 UI,**先 play 再有效**。
- `setPositionState` 参数有数值约束(duration > 0、position <= duration、playbackRate > 0),违反会抛 InvalidStateError —— 用 try/catch 包,或者前置 isFinite 检查。
- handler 失败(throw)不会导致按钮消失,但系统会重试,影响体验。handler 内部用 `.catch(() => {})` 兜住。
- `playbackRate` 必须给。给 1 就行,改速度时再变。
