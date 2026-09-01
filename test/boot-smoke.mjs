// BR v2 headless 启动冒烟：静态起服 → chromium 无头开 /dev/ → 断言 boot 链/DOM 接线/零页面错误。
// playwright 借 WebPaint devDep（家规：能自己验的先自己验完，不转嫁真机）。
import { createRequire } from "node:module";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const wpRequire = createRequire(new URL("../../20260524 WeebPaint/package.json", import.meta.url));
const { chromium } = wpRequire("playwright");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

const srv = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  try {
    const b = await readFile(join(ROOT, p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(b);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
await page.goto(`http://127.0.0.1:${port}/dev/`);
await page.waitForTimeout(5000);

// #log 在折叠的 <details> 里，innerText 对不可见元素返回空串 → 用 textContent
const logText = await page.locator("#log").evaluate((el) => el.textContent ?? "").catch(() => "");
await page.click("#menuToggle");
const menuOpen = await page.locator("#menuDrawer").evaluate((el) => el.classList.contains("open"));
const checks = [
  [logText.includes("启动"), "boot 行出现"],
  [/SW 已接管|SW 接管完成/.test(logText), "SW 接管"],
  [logText.includes("未登录"), "未登录路径走通（headless 无账号）"],
  [(await page.locator("#bigPlay").count()) === 1, "大播放键在"],
  [(await page.locator("#prevBtn").count()) === 1 && (await page.locator("#rewindBtn").count()) === 1, "tile 控制格在（prev/rewind）"],
  [(await page.locator('input[name="loop"]').count()) === 2, "循环模式 radio 在"],
  [(await page.locator('input[name="theme"]').count()) === 3, "主题三选 radio 在"],
  [menuOpen, "抽屉菜单点开"],
  [(await page.locator("#cloudWho").innerText()).includes("未登录"), "未登录时账号节显提示"],
  [await page.locator("#authBtn").isHidden(), "未登录时登出钮藏起"],
  [(await page.locator("#cloudBtn").count()) === 1, "smart cloud 按钮在"],
  [(await page.locator("svg use").count()) > 0, "图标 sprite 接上"],
];
// MSAL 静默探测在无账号 headless 下的网络/授权报错属预期；其余 console/page 错误都算失败。
const realErrors = errors.filter((e) => !/msal|login\.microsoftonline|favicon|AADSTS|interaction_required|no_account/i.test(e));
let fail = 0;
for (const [ok, name] of checks) { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fail++; }
if (realErrors.length) { fail++; console.log("✗ 页面错误：\n  " + realErrors.join("\n  ")); }
await browser.close();
srv.close();
if (fail) { console.error(`boot smoke ✗（${fail} 项失败）\n--- 页面日志 ---\n${logText.slice(0, 1500)}`); process.exit(1); }
console.log("boot smoke 全过");
