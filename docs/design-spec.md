# 个人设计规范 — Ivory-Platinum / Black-Gold

> 这是用户在协作中给出的明确 spec + 一路迭代固化下来的设计纪律。沿用到后续类似项目可以保持视觉一致性。区别于 [theme-system.md](theme-system.md)("怎么实现主题切换"),本文是**"用什么 token 值 + 遵守哪些纪律"**。

## TL;DR

- 两套主题:**Day 象牙白金 / Night 黑金**。auto = 跟系统;day / night = 强制锁定
- 所有中性色**都暖调**,**绝不用纯白 `#FFFFFF` 当 canvas、绝不用纯黑 `#000000` 当 bg**(其实 Day surface 用了 `#FFFFFF`,但 canvas 是 #F6F4EF 暖象牙,平衡靠这层 lift)
- **Flat fills only**:不要 gradient、不要 box-shadow、不要 backdrop-filter blur 当装饰、不要"金粉飘流"这种 effect
- **不靠效果撑感觉**,靠**对比 + 字距 + 留白**
- **填色按钮上字色用 on-accent(深字)**,Day 模式 light text on platinum 对比度不够,不合规

## 完整 Spec(用户原文)

```
DAY · 象牙白金 (v3)
  bg.canvas      #F6F4EF   warm ivory, base
  bg.surface     #FFFFFF   cards, lifted off canvas
  border.gold    #E0D6BE   champagne hairline — borders, dividers, track
  text.primary   #2A2620   warm near-black
  text.secondary #6B6456   muted warm gray
  accent.metal   #B7B19F   platinum — fill buttons, progress bar
  accent.deep    #8A8472   icons, hover, emphasis

NIGHT · 黑金 (v2)
  bg.canvas      #121110   near-neutral deep black
  bg.surface     #1C1B18   cards
  border         #33302A   warm hairline
  text.primary   #EDE7D6   warm ivory (echoes day canvas)
  text.secondary #9A9176   muted warm gray
  accent.gold    #C8A24C   antique gold — icons, accent, fill buttons

RULES
  - All neutrals are warm-tinted; never pure #000 / #FFF.
  - Day fill-buttons: gold/platinum bg + dark text (#2A2620). Light text fails on it.
  - Night gold #C8A24C: safe for icons/accent/large text. Not for body copy.
  - Hairline carries the metallic read in day mode — keep it gold-tinted.
  - Flat fills only. No gradients/highlights (Gatsby route deferred).
```

抄进 CSS:

```css
:root, :root[data-theme="day"], :root[data-theme="auto"] {
  --bg-canvas: #F6F4EF;
  --bg-surface: #FFFFFF;
  --hairline: #E0D6BE;
  --fg: #2A2620;
  --fg-soft: #6B6456;
  --accent: #B7B19F;
  --accent-deep: #8A8472;
  --on-accent: #2A2620;       /* spec 规定:填 accent 后字色用 text.primary,不要浅字 */
  --hover: #F1ECDE;            /* 比 surface 稍深一点的 ivory */
  --active: #E8E0CB;
}

@media (prefers-color-scheme: dark) {
  :root[data-theme="auto"] {
    --bg-canvas: #121110;
    --bg-surface: #1C1B18;
    --hairline: #33302A;
    --fg: #EDE7D6;
    --fg-soft: #9A9176;
    --accent: #C8A24C;
    --accent-deep: #C8A24C;   /* night 模式 deep 与 accent 同(都是 antique gold)*/
    --on-accent: #121110;
    --hover: #252220;
    --active: #2E2A24;
  }
}
:root[data-theme="night"] { /* 同 @media 块内值,但强制不看系统 */ }
```

## 设计纪律(一路撞墙后固化下来)

### 1. Flat fills only

撞过:
- 加 `backdrop-filter: blur(...)` 玻璃质感 → 用户改 spec 时撤掉
- 加 radial gradient 模拟"金粉散落" → 用户撤
- 加 box-shadow / outline 让 cell 浮起 → 用户撤,改成靠**色阶差**(canvas 暗一档 / surface 亮一档)

结论:**没有 gradient、没有 shadow、没有 blur 当主元素**。
- backdrop-filter 偶尔用于"半透 overlay"(eg. menu drawer 的 dimming backdrop)是可以的,但**不当装饰**用
- shadow 默认不要;真要表示 elevation 就用 surface 色阶差

### 2. 暖中性

不要 cool gray、不要纯黑、不要纯白。所有"中性色"都是**暖调**(R ≥ G ≥ B 大致成立的近灰)。

具体:
- `#F6F4EF` 不是 `#F5F5F5`(冷)。微差,但放一起一眼能看出
- `#2A2620` 不是 `#222222`(冷)。深色字也要暖
- `#1C1B18` 不是 `#1A1A1A`(冷)

理由:Spec 的"白金"概念本来就是暖色金属,色偏稍冷就破气质。

### 3. Hairline 是"金属感"的载体

Day 模式里**没有大块金色**(accent 用得很克制)。"金属感"主要靠 **hairline 颜色** = champagne `#E0D6BE`。

- borders、dividers、slider tracks、grid gap 都用这个色
- 1px 宽,不要 2px
- 不要 dashed / dotted,solid

肉眼看上去整个 UI 像是被金线勾边的白瓷,这就是"白金"。

### 4. 字重 400,不要 300

中间试过 `font-weight: 300` 显得"精致"。但在小尺寸下细体字读起来累、对比度不够。用户反馈"太瘦"。

**400 是默认。重要标题用 400 配大字号,不用 600/700 加粗**。

### 5. Win8 flat tile 风的边界

借鉴 Win8 的:
- 大色块 + sharp edges(border-radius: 0 在 controls 区,8px 在 buttons 区)
- 无外阴影
- 几何 layout(grid)
- 直接图标 / 字体(Segoe UI / system-ui)

**不**借鉴 Win8 的:
- 高饱和 tile 颜色(红 / 绿 / 蓝 / 紫块)
- 大字标题(Win8 把字撑得很大)
- Live tile 翻转动画

总结:**Win8 的克制骨架 + 暖白金的配色**。

### 6. 填色按钮的字色规则(强约束)

Spec 第二条 "Day fill-buttons: gold/platinum bg + dark text. Light text fails on it." 是**对比度规则**,不是审美偏好。

- Day fill button(eg. 大 play 按钮): bg `#B7B19F` platinum + text `#2A2620` 深字 → 对比 ~4.5:1,WCAG AA 边缘合格
- 同 bg 上用 light text(`#FFFFFF` 或近白)→ 对比 < 2:1,失败

所以引入 `--on-accent` token,**专门表示"填在 accent 上时用什么字色"**。所有 fill button 都用 `--on-accent`,**禁止猜**。

### 7. 不要"两条 hairline 之间留半截白"

具体场景:`.controls` grid 用 `gap: 1px` + 容器底色 hairline 让 1px 缝充当 cell 分隔线。如果 grid 容器高度 > 子 cell 实际高度,**子 cell 下面会露出容器底色(hairline 灰)**,看起来像"控件被截掉一块"。

解决:**所有同行 grid 子 cell 的 box-sizing + height + padding 都对齐**,确保每个 cell 的总高完全相等。如果某个 cell 需要 padding,其它 cell 也用同样的 padding 或者改成 flex 内部居中。

### 8. Safe area 不是白边

iOS home indicator 区想留出 bg-surface 让 indicator pill 有地方画。**错误做法**:在 `.shell` 上 `padding-bottom: env(safe-area-inset-bottom)`,会留出一块"空白"(用户感觉"UI 被吃掉一块")。

**正确做法**:每个 grid 列单独加 `border-bottom: env(safe-area-inset-bottom) solid var(--bg-surface)`,这样:
- 每列的底色(包括 hairline 列分隔)**直通屏底**
- 内容(icons + text)仍在 9rem 安全区内
- home indicator pill 落在每列下方的"色块延伸"上,不挡 content

视觉上是"controls 一直延伸到屏底",而不是"controls 9rem,下面一条空白条"。

### 9. iOS 上某些控件直接藏掉,不假装能用

iOS Safari `audio.volume` 是只读的。在 iOS 上**继续显示音量条 = 装饰品 + 用户误以为坏了**。

更诚实的做法:**UA detect 后直接 `display: none`**,grid 自动重排,UI 看不出缺角。

```js
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
if (IS_IOS) document.body.classList.add("no-volume");
```

```css
body.no-volume .vol-strip { display: none; }
```

广义化:**平台能力差异在 UI 上就要 surface,不要在所有平台上都展示但实际只有一部分能用**。

### 10. 滚动条也要主题化

```css
.scrollable {
  scrollbar-width: thin;
  scrollbar-color: var(--accent-deep) transparent;
}
.scrollable::-webkit-scrollbar { width: 8px; }
.scrollable::-webkit-scrollbar-track { background: transparent; }
.scrollable::-webkit-scrollbar-thumb {
  background: var(--accent-deep);
  border-radius: 4px;
  border: 2px solid var(--bg-surface);  /* 给 thumb 一圈 surface 边,视觉透气 */
}
```

Windows 上默认的灰色 chunky bar 跟暖白金主题完全不搭。**主题色就主题色到底**。

## 字体

```css
--font: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif;
```

- 系统字体优先,**别用 Web Font**(慢、有 FOUT 问题、跟系统语感不统一)
- Segoe UI 放在前面是 Win 系统的默认字体,跟 Win8 flat 同源(虽然这条主要影响 Windows 用户的渲染)
- macOS / iOS 走 system-ui / `-apple-system` 自动用 SF Pro
- 中文不指定,系统挑(macOS PingFang / Win 微软雅黑 / iOS PingFang)

## 不做的东西(用户明确拒绝过)

- 高饱和 accent 色(亮金、亮蓝、亮红)→ 用 `#C8A24C`(antique gold)而不是 `#FFD700`
- backdrop-filter blur 当主元素 → "flat fills only"
- gradient 当 accent → 同上,gradient 都是负面词
- box-shadow / drop-shadow 当 lift → 用色阶差 lift
- 微动画 / 弹跳 / 飞入 → 没必要,**只在状态切换时用 0.12-0.2s ease 的简单过渡**
- emoji 当 icon(`⏮ ⏭ ⏸ ▶`)→ 用 SVG path,自己控制色
- 浏览器默认 form 控件 → 自定义 styled

## 留下的拓展位

- 文档里 spec 末尾标注 "(Gatsby route deferred)" —— 用户保留了一个**未来要做更高质感版本**的位置(Gatsby 这里是个代号,可能指 gradient / shimmer / 更复杂效果路线)。当前 spec 是"克制版本",真要做"豪华版"再单独 spec
- token 已经按"用途"命名(`--accent`, `--on-accent`),将来要做第三套主题(比如 forest green)替换 token 值即可,业务规则不动

## 命名 cheatsheet

| token | day | night | 用在 |
|---|---|---|---|
| --bg-canvas | #F6F4EF | #121110 | body 底色 |
| --bg-surface | #FFFFFF | #1C1B18 | cards、cells、drawer、buttons |
| --hairline | #E0D6BE | #33302A | borders、dividers、grid gaps、slider track |
| --fg | #2A2620 | #EDE7D6 | 主字色 |
| --fg-soft | #6B6456 | #9A9176 | 次字色 |
| --accent | #B7B19F | #C8A24C | filled buttons bg、progress 填色 |
| --accent-deep | #8A8472 | #C8A24C | icons、emphasis |
| --on-accent | #2A2620 | #121110 | 填 accent 时的字色 |
| --hover | #F1ECDE | #252220 | hover bg |
| --active | #E8E0CB | #2E2A24 | active bg |

## 把这套搬到新项目的最小步骤

1. 复制 spec(本文 "完整 Spec" 那块)进新项目的 `style.css` 顶部
2. 复制 [theme-system.md](theme-system.md) 里的 `<head>` inline script,防 FOUC
3. 业务 CSS 一律用 token,不写 hex 色值
4. 加 menu / settings 里"主题"radio 三选项,持久化 state.theme

新项目立刻有"白金 / 黑金" 双套,跟本项目视觉一致。
