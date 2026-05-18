import { CLIENT_ID, AUTHORITY, SCOPES } from "./config.js";

const MSAL_VERSION = "3.27.0";
const MSAL_URLS = [
  `https://cdn.jsdelivr.net/npm/@azure/msal-browser@${MSAL_VERSION}/lib/msal-browser.min.js`,
  `https://unpkg.com/@azure/msal-browser@${MSAL_VERSION}/lib/msal-browser.min.js`,
];

let pca = null;
let activeAccount = null;
let initPromise = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
}

async function loadMsal() {
  if (window.msal) return window.msal;
  let lastErr = null;
  for (const url of MSAL_URLS) {
    try {
      await loadScript(url);
      if (window.msal) return window.msal;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`MSAL 加载失败: ${lastErr?.message ?? "unknown"}`);
}

// Init 时除了恢复账号身份,还要 silent 试一次拿 token,确认本 app 真的被授权过。
// 否则缓存账号(可能来自同 origin 的另一个 app)会让 UI 误标"已登录"。
// 离线场景:MSAL CDN 全失败 → 返回 { offline: true },app 进入只读 / 缓存模式。
export function initAuth() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let msal;
    try {
      msal = await loadMsal();
    } catch (e) {
      return { signedIn: false, account: null, offline: true, msalError: e.message };
    }
    pca = new msal.PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        redirectUri: location.origin + location.pathname,
        postLogoutRedirectUri: location.origin + location.pathname,
      },
      cache: {
        cacheLocation: "localStorage",
        storeAuthStateInCookie: false,
      },
    });
    await pca.initialize();

    let response = null;
    try {
      response = await pca.handleRedirectPromise();
    } catch (e) {
      console.warn("handleRedirectPromise failed:", e);
    }

    if (response?.account) {
      pca.setActiveAccount(response.account);
      activeAccount = response.account;
      return { signedIn: true, account: activeAccount };
    }

    const cached = pca.getAllAccounts();
    if (cached.length === 0) {
      return { signedIn: false, account: null };
    }

    // 探测:能 silent 拿到本 clientId 的 token = 本 app 已被授权
    try {
      await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
      pca.setActiveAccount(cached[0]);
      activeAccount = cached[0];
      return { signedIn: true, account: activeAccount };
    } catch (e) {
      // 静默失败 = 本 app 未授权,UI 标未登录,等用户点 login
      return { signedIn: false, account: null, probedAccount: cached[0] };
    }
  })().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}

export async function signIn() {
  if (!pca) await initAuth();
  return pca.loginRedirect({ scopes: SCOPES });
}

export async function signOut() {
  if (!pca || !activeAccount) return;
  const account = activeAccount;
  activeAccount = null;
  try {
    await pca.clearCache({ account });
    pca.setActiveAccount(null);
  } catch (e) {
    console.warn("clearCache failed:", e);
  }
}

export async function getToken() {
  if (!pca || !activeAccount) throw new Error("尚未登录");
  try {
    const result = await pca.acquireTokenSilent({
      scopes: SCOPES,
      account: activeAccount,
    });
    return result.accessToken;
  } catch (e) {
    await pca.acquireTokenRedirect({ scopes: SCOPES });
    throw e;
  }
}

export function getActiveAccount() {
  return activeAccount;
}

export function isSignedIn() {
  return !!activeAccount;
}
