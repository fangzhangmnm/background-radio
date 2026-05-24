# MSAL v3 浏览器 SPA 集成 — 第一次会踩的坑

## TL;DR

- v3 **不在** `alcdn.msauth.net` 上,Microsoft 那个老 CDN 只到 v2。v3 从 jsDelivr / unpkg 拉,且要带 fallback。
- 用 **`loginRedirect` 不要用 `loginPopup`**。popup 会被各种拦,且在 PWA standalone 下行为更怪。
- `redirectUri` 字符串必须**和 Azure portal 里登记的完全一致**,包括结尾斜杠。Python `http.server` 服务根目录会让 `location.origin + location.pathname` 带斜杠,所以 portal 里两条都登记是稳妥的:`http://localhost:5173` 和 `http://localhost:5173/`。
- **缓存账号 ≠ 本 app 已被授权**。MSAL 的 account entity 按 user identity 存,同 origin 不同 clientId 的 app 互相看得见对方的账号。如果直接 `setActiveAccount(getAllAccounts()[0])` 就标"已登录",UI 是骗人的。要做一次 **silent token probe**,silent 拿到本 clientId 的 token 才算真登录。

## 加载脚本

```js
const MSAL_VERSION = "3.27.0";
const MSAL_URLS = [
  `https://cdn.jsdelivr.net/npm/@azure/msal-browser@${MSAL_VERSION}/lib/msal-browser.min.js`,
  `https://unpkg.com/@azure/msal-browser@${MSAL_VERSION}/lib/msal-browser.min.js`,
];
```

懒加载,失败一条试下一条。一定要 fallback —— 单点 CDN 偶发挂掉时全 app 启动不了。

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
