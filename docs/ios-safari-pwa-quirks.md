# iOS Safari / PWA standalone 的具体坑

整理自一个反复迭代的项目。iOS 上能踩的几乎全踩过。

## TL;DR

- **autoplay 永远拒**(无 user gesture 时)。设计上不要假定自动播放。
- **`audio.volume` 是只读的**。系统硬件键独占音量。in-app 音量滑块在 iOS 上等于装饰品。WebAudio + GainNode 理论上能绕,但 AudioContext 状态管理一旦没对就**完全没声音**,实测不值得。藏掉滑块更稳。
- **status-bar-style 是装机时锁定的**。`<meta name="apple-mobile-web-app-status-bar-style">` 改了只对新装的 PWA 生效,**老的装机 PWA 仍按当初的设定跑**。
- **viewport-fit=cover + env(safe-area-inset-*) 一定要配**。否则 status bar / home indicator 会盖住内容,或者反过来留出不该留的空白。
- **iOS 状态栏会把 viewport 顶部 47pt 左右单独保留**(default 模式),home indicator 把底部 34pt 保留。content 落在保留区会被截 / 被遮。
- **iOS 16.4+ 第三方浏览器(Edge / Chrome)可以装 PWA 到主屏**,入口在 `⋯` 菜单不在 share。

## autoplay 策略

iOS 上 `audio.play()` 必须在 **synchronous 的 user gesture handler 里**调,否则 promise 立即 reject(NotAllowedError)。

实际意味着:

- **Resume on open 不能自动放**。app 打开后,显示当前曲信息,**等用户点一下播放按钮**才能 play。
- **早期 cache resume 阶段**可以试试 `audio.play()`(不阻塞),Windows / Chrome 上有 engagement 时可能通,iOS 上必拒,拒了就拒了,反正按钮在。
- **跨 await 边界后**算丢 user gesture。`tapHandler` 里 `await someAsync(); audio.play()` 在 iOS 上 reject。要么 sync 调,要么把 play() 放在 await **之前**。

## audio.volume 只读

```js
audio.volume = 0.5;  // iOS Safari 上无效,audio.volume 始终 1
```

试过的方案:

1. **Web Audio API:`createMediaElementSource(audio)` → `GainNode` → `destination`**。理论上 `gainNode.gain.value` 可控,iOS 也支持。**实际**:`AudioContext` 默认 suspended,即使 resume 调了,跨 await 后状态不一定 running。一旦 audio 走了 AudioContext 这条路但 AudioContext 是 suspended,**完全没声音**(PC + iOS 都受影响)。
2. **走原 audio.volume 老路 + iOS 上藏掉滑块**。`audio.volume = X` 在 iOS 上是 no-op 但**不破坏播放**,这是关键。其它平台正常工作。最稳。

最终选 2,UA detect 加 body class:

```js
const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
if (IS_IOS) document.body.classList.add("no-volume");
```

```css
body.no-volume .vol-strip { display: none; }
```

iPad 在 iPadOS 13+ 默认 desktop UA 还报 `Macintosh`,所以加 `maxTouchPoints > 1` 兜底。

## status-bar-style 装机时锁定

```html
<meta name="apple-mobile-web-app-status-bar-style" content="default">
```

可选值:`default`、`black`、`black-translucent`。

**iOS 把这个值写到 PWA 的 plist 里,一次装机定死**。后面再改 meta 标签,**老的装机 PWA 仍按当初的值跑**。新装的 PWA 用新值。

不同值对 viewport 的影响:

| 值 | viewport 包含状态栏区? | env(safe-area-inset-top) |
|---|---|---|
| default | 否(状态栏自占,opaque)| 通常 0 |
| black | 否 | 通常 0 |
| black-translucent | 是(状态栏透明,内容可在下面)| > 0(状态栏高度,~47pt)|

iOS 升级 / 改 meta 之后用户的体感"app 顶部行为变了" —— 删了重装就行,代码不需要动。

## safe-area-inset 使用

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```

`viewport-fit=cover` 让 viewport 覆盖整个屏幕(包括安全区)。然后 CSS 用 `env(safe-area-inset-*)` 给内容让位。

```css
.top-bar {
  padding-top: max(0.6rem, env(safe-area-inset-top));
}
```

`max` 保证非 notch 设备上至少有 0.6rem 的视觉边距。

## bottom safe-area 的几种处理(都试过)

| 方案 | 视觉 | 缺点 |
|---|---|---|
| `.shell { padding-bottom: env(saib) }` | 内容停在 controls 顶,下面一条 bg-surface | 用户觉得"被吃掉一块"(白条像未渲染) |
| 不加 padding,controls 顶到屏底 | controls 直通 home indicator | iOS 自动截 viewport,controls 底部被切 |
| **混合:每列加 `border-bottom: env(saib) solid bg-surface`** | 列底色延伸到屏底,内容仍在 9rem 安全区 | grid 列宽 / box-sizing 要算对 |

最终用第三种。每个 grid 列 `box-sizing: content-box; height: 9rem; border-bottom: env(safe-area-inset-bottom) solid var(--bg-surface)`,网格容器自动 fit,1px 列间隙的 hairline 跟着延伸到屏底,**不再有"色彩断层"的视觉感**。

关键陷阱:**grid 子元素如果有 padding,所有列的总高要相等,否则 grid row 拉满到最高,其它列下方露出容器底色**。本项目 vol-strip 有 padding 而 ctrl-col 没有,导致 vol-strip 比其它列高 0.8rem,grid row 拉满后其它列下方露出 hairline 灰条。修法:**vol-strip 改 `justify-content: center` 加 flex 居中,padding 撤掉**。

## status bar 跟 PWA 装机时机的 race

具体场景:用户先把 PWA 装好,然后开发者改了 status-bar-style meta。

- 用户既有 PWA 仍按老 status-bar-style 跑
- 新装的 PWA 按新 status-bar-style 跑
- 同样的 CSS 在两种装机版本表现不同

防御做法:CSS 不要假设某个具体 status-bar-style,**全部 padding 都用 `max(默认值, env(safe-area-inset-*))`**。两种装机版本都不会出问题。

## "添加到主屏" 入口

| 浏览器 | iOS 版本 | 入口 |
|---|---|---|
| Safari | 全部 | 底部分享按钮 → 添加到主屏幕 |
| Edge | iOS 16.4+ | `⋯` 菜单(底部右侧)→ 添加到主屏(**不在 share 里**)|
| Chrome | iOS 16.4+ | 跟 Edge 类似,`⋯` 菜单 |

不同浏览器同样的网页装出来的 PWA **是独立的**(各自的 SW / cache / localStorage)。用户在 Safari 装的跟 Edge 装的互不共享数据。

## PWA standalone 跟普通 Safari tab 的区别

- standalone 没浏览器 chrome,锁屏 / 控制中心显示**完整** Media Session widget
- 普通 tab 锁屏只有基础控制
- 普通 tab 切到后台后会被 iOS 暂停音频(节能);standalone 会保持(对正在播放的 media 通常成立)
- standalone 模式下 `navigator.standalone === true`,可以检测

## 排查"卡死"的几个常见原因

| 症状 | 大概率原因 |
|---|---|
| iOS PWA 一片空白 | SW install 失败(cross-origin precache 之一炸了),停留在更早 SW 上 |
| 锁屏 widget 不出现 | metadata 注册得太早(在 first play 之前),iOS 没接住,在 `loadedmetadata` 里注册一次 |
| 音量条没反应 | `audio.volume` 只读;装饰品,藏掉 |
| 顶栏被状态栏盖 | 缺 `env(safe-area-inset-top)` padding,或者 status-bar-style 是 black-translucent 但 padding 没加 |
| 底栏被 home indicator 盖 | 同上,缺 `env(safe-area-inset-bottom)` |
| autoplay 永远 reject | 这就是 iOS 的设计,接受,改成 tap-to-play 模式 |

## 调试技巧

- iOS Safari devtools 连接 Mac:Mac Safari → 偏好设置 → 高级 → 启用开发者菜单。iPhone 设置 → Safari → 高级 → Web 检查器。USB 连线,Mac Safari → 开发菜单看到设备。
- console.log 在 in-app 显示(用 in-app debug panel)比 USB 调试方便,**只要不嫌 log spam**。本项目最后留了个菜单里折叠的 debug log 面板,出问题让用户截图 log 就行。
- iOS 上的 `performance.now()` 准,可以用来定位 cold start 哪一段最慢。
