# 项目沉淀

为类似项目(浏览器端 / OneDrive / 音视频播放 / PWA)留下的可复用经验。每篇独立可读。

## 集成 / 协议

- [20260524-msal-v3-spa.md](20260524-msal-v3-spa.md) — MSAL v3 浏览器集成里第一次会踩的几个具体坑
- [20260524-onedrive-graph-readonly.md](20260524-onedrive-graph-readonly.md) — 用 Graph 只读访问 OneDrive 的实际行为(approot、downloadUrl、同步延迟)

## 音频播放

- [20260524-audio-streaming-pattern.md](20260524-audio-streaming-pattern.md) — 用浏览器原生 `<audio>` 直接喂 OneDrive 预签名 URL,不写 proxy
- [20260524-player-state.md](20260524-player-state.md) — 三种 loop 模式、per-track 位置 map、resume 语义统一化的过程、`ended` 事件的边界
- [20260524-media-session.md](20260524-media-session.md) — Media Session API 怎么接、什么时候更新什么

## PWA / Service Worker

- [20260524-pwa-svg-icons.md](20260524-pwa-svg-icons.md) — SVG → PNG 时 ImageMagick 不渲染渐变这件事
- [20260524-service-worker-and-updates.md](20260524-service-worker-and-updates.md) — SW lifecycle、cache-first + SWR、3 通路热更新 toast、cross-origin precache 防御
- [20260524-offline-and-cache-tiers.md](20260524-offline-and-cache-tiers.md) — 两级 IndexedDB cache(pinned + LRU)、离线降级模式、长按删除的陷阱

## 平台具体

- [20260524-ios-safari-pwa-quirks.md](20260524-ios-safari-pwa-quirks.md) — iOS Safari 各种约束(autoplay、audio.volume 只读、status-bar-style 装机时锁定、safe-area-inset 用法)

## 工程姿势

- [20260524-vanilla-no-bundler.md](20260524-vanilla-no-bundler.md) — 不上构建工具的可行性、边界、注意事项
- [20260524-theme-system.md](20260524-theme-system.md) — day / night / auto 三模式,`data-theme` attribute,FOUC 防护,token 命名

## 视觉系统(沿用到后续项目)

- [20260524-design-spec.md](20260524-design-spec.md) — 用户给的 Ivory-Platinum / Black-Gold spec 原文 + 一路迭代固化下来的设计纪律(flat fills only、暖中性、hairline 是金属感载体、填色按钮字色强约束等)

## 协作

- [20260524-collaboration-notes.md](20260524-collaboration-notes.md) — 给协作的 AI:这个用户的合作风格观察
