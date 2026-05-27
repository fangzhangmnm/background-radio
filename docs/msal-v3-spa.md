# MSAL v3 浏览器 SPA 集成 — 第一次会踩的坑

## TL;DR

- v3 **不在** `alcdn.msauth.net` 上,Microsoft 那个老 CDN 只到 v2。**当前做法是把 v3 整包 vendor 到 `vendor/msal/`,SW 精缓存** —— 见下面"加载脚本"小节里"反转决策"那段。
- 用 **`loginRedirect` 不要用 `loginPopup`**。popup 会被各种拦,且在 PWA standalone 下行为更怪。
- `redirectUri` 字符串必须**和 Azure portal 里登记的完全一致**,包括结尾斜杠。Python `http.server` 服务根目录会让 `location.origin + location.pathname` 带斜杠,所以 portal 里两条都登记是稳妥的:`http://localhost:5173` 和 `http://localhost:5173/`。
- **缓存账号 ≠ 本 app 已被授权**。MSAL 的 account entity 按 user identity 存,同 origin 不同 clientId 的 app 互相看得见对方的账号。如果直接 `setActiveAccount(getAllAccounts()[0])` 就标"已登录",UI 是骗人的。要做一次 **silent token probe**,silent 拿到本 clientId 的 token 才算真登录。

## 加载脚本

```js
// vendor/msal/msal-browser.min.js  ← 整包 vendor,~300KB
const MSAL_URL = new URL("./vendor/msal/msal-browser.min.js", import.meta.url).href;

async function loadMsal() {
  if (window.msal) return window.msal;
  await loadScript(MSAL_URL);
  if (!window.msal) throw new Error("MSAL 加载完但 window.msal 没出现");
  return window.msal;
}
```

懒加载(用户点 sign-in 之前不拉),但只从本地。SW 把 `vendor/msal/msal-browser.min.js` 精缓存,跟其它 shell 资源一起在 `install` 阶段 `addAll`。

**反转决策(2026-05-27)**。最初版本是 jsDelivr 主 + unpkg fallback,理由是"第三方库不要 vendor,版本会漂"。实际跑下来踩了几个坑才翻转:

- 校园网 / 酒店网 / 移动信号弱的地方,jsdelivr / unpkg 经常被墙或慢到几秒。两条 fallback 跑完用户已经看到"MSAL 加载失败"了 —— 明明能上网,只是连不上 npm 镜像。
- SW 里曾经搞过一套花活:`MSAL_CDN_PRECACHE` best-effort 装进 cache、`isMsalCdnRequest` 在 fetch handler 里把 cross-origin 的 MSAL 当作 SWR 例外。能跑,但比起"vendor + 同源精缓存"复杂得多 —— 而 vendor 之后这一整套都能删掉。
- MSAL v3 接口稳定,`acquireTokenSilent` / `loginRedirect` 几年没变;PWA 装在 homescreen 上几个月不升级也无所谓。
- 多 300KB 在 PWA precache 里(本来已经有 icons、style、几个 .js)完全可忽略。

需要升 MSAL 时手动换 `vendor/msal/msal-browser.min.js` 并 bump SW 的 `CACHE_VERSION`。

不要在 HTML 用 `<script src="https://alcdn.msauth.net/browser/3.x/...">`,这个 URL 404。

## redirectUri 计算

```js
new PublicClientApplication({
  auth: {
    clientId: ...,
    authority: "https://login.microsoftonline.com/common",
    redirectUri: location.origin + location.pathname,
    postLogoutRedirectUri: location.origin + location.pathname,
  },
  cache: { cacheLocation: "localStorage", storeAuthStateInCookie: false },
});
```

动态算比写死端口好(用户换 dev server / 部署到不同路径都不用改代码)。代价是 Azure portal 里 SPA Redirect URIs 要把**实际访问到的所有 URL 都登记**。

## Authority

`common` 同时支持个人和组织账号,最少阻力。`consumers` 是个人账号专用,但 Azure portal 里的"Directory tenant ID"展示的是 app 注册所在租户,**不**是支持的账号类型。看那个 ID 不能反推 authority。稳妥用 `common`。

## 初始化流程(v3)

```js
const pca = new msal.PublicClientApplication({...});
await pca.initialize();            // v3 强制要求,放在所有其它操作前
const response = await pca.handleRedirectPromise();  // 接登录跳回来的 token
```

`initialize()` 必须 await,顺序错了后面 `handleRedirectPromise` 会出怪事。

## silent token probe

```js
const cached = pca.getAllAccounts();
if (cached.length > 0) {
  try {
    await pca.acquireTokenSilent({ scopes, account: cached[0] });
    // 真的拿到本 clientId 的 token,才标已登录
    pca.setActiveAccount(cached[0]);
    return { signedIn: true, account: cached[0] };
  } catch {
    // 账号在,但本 app 未授权(consent 是按 clientId 隔离的)
    return { signedIn: false, probedAccount: cached[0] };
  }
}
```

不做这一步,UI 会出现:同 origin 装过另一个 MSAL app → 这个新 app 一打开就显示"已登录" → 用户点功能按钮才弹同意页 → 体感非常诡异且像被入侵了。

## signOut 的正确姿势

**不要**调 `logoutRedirect`。那会把用户从 Microsoft 全局会话踢出,Outlook / OneDrive web 等同账号其它 tab 也跟着登出。正确做法:

```js
await pca.clearCache({ account });
pca.setActiveAccount(null);
```

只清本地缓存,不动 Microsoft 那边。

## token 续期

`acquireTokenSilent` 失败时 fallback `acquireTokenRedirect`(整页跳)。Popup 同理别用。

```js
try {
  const r = await pca.acquireTokenSilent({ scopes, account });
  return r.accessToken;
} catch {
  await pca.acquireTokenRedirect({ scopes });
  throw ...;  // 这次调用没结果,跳走了,下一次进来再说
}
```

## scope 选择

App folder 场景用 `Files.ReadWrite.AppFolder`(Microsoft Graph 没有 `Files.Read.AppFolder` 这种只读变体,所以是"有写权限但代码不写")。加 `offline_access` 拿 refresh token,实现"登录一次就不管"。

更严格的边界要走 OneDrive File Picker SDK(picker 给的是**真正按文件夹 scoped** 的 token,越界 Graph 直接 403),代码即使越界也打不穿。
