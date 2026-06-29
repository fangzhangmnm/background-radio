# Theme system — day / night / auto,三模式 + FOUC 防护

## TL;DR

- 主题分 day(浅)、night(深)、auto(跟系统)。**用户可强制锁定到 day 或 night,不只跟系统**。
- 实现:`<html data-theme="day|night|auto">` + CSS 用 `:root[data-theme="..."]` 切 token。auto 用 `@media (prefers-color-scheme: dark) { :root[data-theme="auto"] { ... } }`。
- **FOUC 防护**:在 `<head>` 内、CSS 加载**之前**插一小段 inline JS 读 localStorage 设 `data-theme`。否则页面打开瞬间会从默认主题闪到用户选的主题。
- 颜色 token 拆开**用语义命名**(`--bg-canvas`、`--bg-surface`、`--fg`、`--fg-soft`、`--accent`、`--hairline`),不要直接用 `--gold` / `--brown` 这种具体色名。换主题时只改 token,业务规则不动。
- Spec 风设计文档:给出每个 token 的具体色值 + 用法,**列出禁止组合**(eg. light text on accent fill on day mode 对比度不够)。

## CSS 结构

```css
:root, :root[data-theme="day"], :root[data-theme="auto"] {
  --bg-canvas: #F6F4EF;       /* 底色:暖象牙 */
  --bg-surface: #FFFFFF;       /* 卡片色,跟 canvas 拉对比制造"抬起"感 */
  --hairline: #E0D6BE;          /* 边框 / divider / 滑条 track */
  --fg: #2A2620;                 /* 主字色:暖近黑 */
  --fg-soft: #6B6456;             /* 次字色:暖中性灰 */
  --accent: #B7B19F;              /* 主 accent:platinum,用于 fill button + progress */
  --accent-deep: #8A8472;          /* 深 accent:icon / hover / emphasis */
  --on-accent: #2A2620;             /* 填 accent 之后字色(深字才合规)*/
  --hover: #F1ECDE;
  --active: #E8E0CB;
}

@media (prefers-color-scheme: dark) {
  :root[data-theme="auto"] {
    --bg-canvas: #121110;
    --bg-surface: #1C1B18;
    --hairline: #33302A;
    --fg: #EDE7D6;
    --fg-soft: #9A9176;
    --accent: #C8A24C;        /* gold */
    --accent-deep: #C8A24C;
    --on-accent: #121110;
    --hover: #252220;
    --active: #2E2A24;
  }
}

:root[data-theme="night"] {
  /* 跟上面 @media 块完全相同的值,但是强制(不看系统配色)*/
  --bg-canvas: #121110;
  ...
}
```

注意 `:root[data-theme="auto"]` 在 `@media` 里:**只有 auto 模式才跟系统**。`night` 模式无论系统是 light 还是 dark 都是暗,`day` 反之。

## FOUC 防护(关键)

```html
<head>
  <link rel="stylesheet" href="style.css">
  <script>
    // CSS 应用前先把 data-theme 设好,避免页面打开瞬间从默认主题闪到用户选的主题
    (function () {
      try {
        const raw = localStorage.getItem("app.state");
        let theme = "auto";
        if (raw) {
          const s = JSON.parse(raw);
          if (s && (s.theme === "day" || s.theme === "night" || s.theme === "auto")) {
            theme = s.theme;
          }
        }
        document.documentElement.setAttribute("data-theme", theme);
      } catch (_) {
        document.documentElement.setAttribute("data-theme", "auto");
      }
    })();
  </script>
</head>
```

放在 `<link rel="stylesheet">` **之后**。这样:
1. CSS 已经准备好,但还未应用 selector
2. script 立即把 `data-theme` attr 设好
3. CSS 开始 match selector,直接用正确的主题

如果脚本放在 `</body>` 之前或者 module script(deferred),用户会看到主题闪烁("看一下白色再变黑" 或反之)。

## 用户切换 + 持久化

```js
function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.theme);
  // radio 按钮同步
  for (const r of themeRadios) {
    r.checked = r.value === state.theme;
  }
}

for (const r of themeRadios) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    state.theme = r.value;
    saveState();    // 写回 localStorage,inline script 下次读
    applyTheme();
  });
}
```

## 选 token 名字

**好**(语义化):
- `--bg-canvas` / `--bg-surface` —— 表示**层级**(底 vs 抬起)
- `--fg` / `--fg-soft` —— 表示**重要性**(主字 vs 次字)
- `--accent` / `--accent-deep` —— 表示**强度**
- `--hairline` —— 表示**用途**(边线)

**不好**(具体色):
- `--gold` / `--bronze` —— 切到深色主题时这名字没意义了(深色主题里"gold" 是浅色)
- `--white` / `--gray-300` —— Tailwind 风,但跟语义脱节,主题切换时不知道哪儿改

语义命名让一个主题换皮变成"改 token 值",业务规则不动。

## `meta name="theme-color"` 也分主题

```html
<meta name="theme-color" content="#F6F4EF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121110" media="(prefers-color-scheme: dark)">
```

iOS Safari / Chrome 上影响 status bar 背景色 / browser chrome 边色。两条 media 各管一头,系统切换时浏览器自动选合适的。

**但用户的"强制 day/night" 这条 meta 控制不到** —— meta 只看系统。要让 status bar 颜色也跟用户选的主题一致,得 JS 动态改:

```js
function syncThemeColorMeta() {
  const effective = state.theme === "auto"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day")
    : state.theme;
  const color = effective === "night" ? "#121110" : "#F6F4EF";
  // 找/建一个不带 media 的 meta
  let meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", color);
}
```

本项目止步于让 media queries 处理,够用。

## 设计 spec 的好处

用户给了一份明确的 spec(每个 token 具体色值 + 用法 + 禁忌组合):

```
DAY · 象牙白金 (v3)
  bg.canvas      #F6F4EF
  bg.surface     #FFFFFF
  border.gold    #E0D6BE  — borders, dividers, track
  text.primary   #2A2620
  text.secondary #6B6456
  accent.metal   #B7B19F — fill buttons, progress bar
  accent.deep    #8A8472 — icons, hover, emphasis

RULES
  - All neutrals are warm-tinted; never pure #000 / #FFF.
  - Day fill-buttons: gold/platinum bg + dark text. Light text fails.
  - Hairline carries the metallic read in day mode.
  - Flat fills only. No gradients/highlights.
```

**有这种 spec 的时候直接抄进 token 名字**,不要二次发挥。需求迭代时 user 直接改 spec,你改 token,可控。

如果没 spec,**你先列一个 draft spec 给用户确认**再开 CSS。否则迭代到第 N 次会发现命名跟语义脱节,改不动。

## 设计 lesson:Flat fills only

经历过:加 backdrop-filter blur 玻璃感、加 radial gradient "金粉" 氛围 —— 都被用户撤了。

教训:**用户说"flat" 就真的 flat**。gradient / blur / shadow 都是"加重量"的元素,跟"flat" 是矛盾的。用户要的是**靠对比 + 字距 + 留白来撑住感觉**,不是靠效果。

具体到本项目:cards 跟 canvas 的"抬起感"靠**色阶差**(#FFFFFF 跟 #F6F4EF 的微差),不靠 shadow。Section divider 靠 1px hairline 不靠 gap。这条**节制**让 spec 看起来有"味道"而不"花"。
