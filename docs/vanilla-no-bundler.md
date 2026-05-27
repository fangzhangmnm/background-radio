# 不上构建工具的边界与做法

## TL;DR

- 像这种规模(单页 PWA、几百行 JS)的项目,纯 HTML / JS / CSS + 浏览器原生 ES modules **完全可行**,不需要 Vite / Webpack / 任何 bundler。
- 调试少一层,部署是"把文件 copy 到任何静态服务器"。
- 第三方依赖**整包 vendor 到 `vendor/<lib>/`,SW 精缓存**,懒加载从本地。原最早写的是 CDN 懒加载 + fallback,2026-05-27 翻转 —— 见下面"vendor 第三方库"小节,以及 [msal-v3-spa.md](msal-v3-spa.md) 里"反转决策"那段。
- 必须有 dev server(`file://` 协议下 ES modules 不工作、Service Worker 不能装、MSAL redirect 不工作)—— Python `http.server` 够用。

## 何时上 bundler

| 现象 | 是否上 bundler |
|---|---|
| 主要逻辑就这几百行,UI 简单 | 不上 |
| 要 React / Vue / Svelte | 上 |
| 用 TypeScript | 上(或 deno / 在线 tsc) |
| 引大量 npm 依赖,且依赖间有交叉 | 上 |
| 团队多人协作,要 lint / format / 测试套件 | 上 |
| 单人快速验证、原型、个人小工具 | 不上 |

## 文件分工(本项目示例)

```
index.html                           — UI 结构 + 入口 <script type="module">
style.css                            — 样式
config.js                            — 常量(client_id 等)
auth.js                              — MSAL 包装
app.js                               — 状态 + 渲染 + 业务逻辑
manifest.webmanifest                 — PWA manifest
service-worker.js                    — (有则)PWA 离线壳
icon.svg / icon-*.png                — 图标
vendor/msal/msal-browser.min.js      — vendored @azure/msal-browser@3.27.0
```

8~10 个文件,扫一眼就知道在哪。不需要 src/ public/ build/ 分层。

## vendor 第三方库 + 懒加载

第三方库整包 vendor 到 `vendor/<lib>/`,**懒加载从本地** —— 用户不触发用到的功能就不拉,但拉的时候不依赖外网:

```js
// MSAL_URL 解析成同源的 vendor 路径
const MSAL_URL = new URL("./vendor/msal/msal-browser.min.js", import.meta.url).href;

async function loadOnce() {
  if (window.msal) return window.msal;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = MSAL_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed ${MSAL_URL}`));
    document.head.appendChild(s);
  });
  if (!window.msal) throw new Error("lib 加载完但 global 没出现");
  return window.msal;
}
```

为什么不 `<script src="https://cdn.../...">` 写死在 HTML(原本写过、后来改成 CDN 懒加载、最终又改成 vendor 懒加载):
1. CDN 挂掉的时候整 app 起不来,且不知道为什么
2. 校园网 / 酒店网 / 移动信号弱时,jsdelivr 和 unpkg 经常被墙或慢到几秒。fallback 跑完用户已经看到"加载失败"了
3. PWA 装在 homescreen 上,SW 精缓存就是为了不依赖外网。CDN 懒加载等于在最关键的"sign-in"路径上反悔 offline-first 承诺

为什么仍然懒加载(不在 HTML 用 `<script src="./vendor/...">` 同步):用户不点 sign-in 就不需要 MSAL,~300KB 不在主线程上 parse 减少冷启动延迟。SW 精缓存保证拉的时候不走网络。

### 历史:CDN 懒加载 + 双 fallback(已退役)

最初是 `cdn.jsdelivr.net` 主 + `unpkg.com` fallback。下面这套是原始代码,留着是因为 SW 那边还有些"曾经为 CDN 写的"防御代码可以对照理解(见 [service-worker-and-updates.md](service-worker-and-updates.md))。如果未来引入一个新的、暂时不打算 vendor 的库,这套结构能直接拿过去用。

```js
const VERSION = "3.27.0";
const URLS = [
  `https://cdn.jsdelivr.net/npm/@azure/msal-browser@${VERSION}/lib/msal-browser.min.js`,
  `https://unpkg.com/@azure/msal-browser@${VERSION}/lib/msal-browser.min.js`,
];
// for (url of URLS) { 拉,挂了换下一条 }
```

## ES modules 直接用

```html
<script type="module" src="./app.js"></script>
```

```js
// app.js
import { initAuth, getToken } from "./auth.js";
import { CLIENT_ID } from "./config.js";
```

浏览器原生支持。**相对路径必须带 `./`**,直接 `from "auth.js"` 浏览器认成 bare specifier(npm 名),报错。

## Dev server

```bash
# Python(WSL / macOS / Linux 基本都有)
python3 -m http.server 5173

# 或者 node 的 live-server,有自动刷新
npx live-server --port=5173 --no-browser
```

为什么必须有 server:

- `file://` 协议下 `import` 失败(CORS 拒绝)
- Service Worker 不能注册
- MSAL / OAuth redirect 必须是 http(s)
- `fetch()` 跨源行为乱

端口选 5173 是惯例(Vite 默认),但任何固定端口都行,跟 Azure portal 的 redirect URI 对上即可。

## CSS

CSS 不用 PostCSS / SCSS,直接写 CSS:

- `--var: value` 原生 CSS 变量,跟 dark mode 配合:`@media (prefers-color-scheme: dark) { :root { --var: ... } }`
- `backdrop-filter` / nested(现代 CSS)都浏览器原生
- 不需要 vendor prefix 自动加 —— modern 浏览器都不需要,实在要写就手写一行 `-webkit-`

## State 管理

不用 Redux / Zustand,**plain object + localStorage**:

```js
const STATE_KEY = "br.state";
let state = { ...defaults };

function load() {
  const raw = localStorage.getItem(STATE_KEY);
  if (raw) state = { ...defaults, ...JSON.parse(raw) };
}
function save() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}
```

每次改 state 后手动 save。**比订阅模型简单一个数量级**,小项目根本不需要响应式。

## DOM 绑定

```js
const $ = id => document.getElementById(id);
const btnPlay = $("btn-play");
btnPlay.addEventListener("click", ...);
```

不用 framework 的 ref / template ref。少抽象,改改就是。

要复杂的列表渲染再考虑模板引擎,但通常 `innerHTML` + escape 函数够用:

```js
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
el.innerHTML = items.map(i => `<li>${escapeHtml(i.name)}</li>`).join("");
```

事件用 delegation:在父元素上一个 listener,从 `event.target` 找哪一项被点。

## 啥时候要重新考虑上 bundler

- 单文件超过 1000~1500 行,开始难导航
- 同样的逻辑在多个文件重复了 3 次以上
- 加 TypeScript 想要类型(`// @ts-check` + JSDoc 能续命,但有上限)
- 加测试套件(vanilla 也能跑 vitest / jest 但开销跟 bundler 接近)

这个项目没到。
