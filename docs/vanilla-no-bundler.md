# 不上构建工具的边界与做法

## TL;DR

- 像这种规模(单页 PWA、几百行 JS)的项目,纯 HTML / JS / CSS + 浏览器原生 ES modules **完全可行**,不需要 Vite / Webpack / 任何 bundler。
- 调试少一层,部署是"把文件 copy 到任何静态服务器"。
- 第三方依赖通过 **CDN 懒加载,带 fallback CDN**。不要 `<script src="...">` 单点写死,挂了全 app 起不来。
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
```

8~10 个文件,扫一眼就知道在哪。不需要 src/ public/ build/ 分层。

## CDN 懒加载 + fallback

第三方库不要 vendor 进 repo。CDN 加载,失败 fallback:

```js
const VERSION = "3.27.0";
const URLS = [
  `https://cdn.jsdelivr.net/npm/@azure/msal-browser@${VERSION}/lib/msal-browser.min.js`,
  `https://unpkg.com/@azure/msal-browser@${VERSION}/lib/msal-browser.min.js`,
];

async function loadOnce() {
  if (window.msal) return window.msal;
  let lastErr;
  for (const url of URLS) {
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`failed ${url}`));
        document.head.appendChild(s);
      });
      if (window.msal) return window.msal;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`lib 加载失败: ${lastErr.message}`);
}
```

为什么不 `<script src="...">` 写死在 HTML:
1. 那个 CDN 挂的话整 app 起不来,且不知道为什么
2. 没法 fallback
3. 没法在初始化失败时给用户友好提示

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
