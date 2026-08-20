# 本 app 的图标

18 icons · 提取自家族图标库 `../20260708 SVG Icons/icons.svg` · 由 `extract-icons.py` 生成，别手改。

用法：把 sprite 整段内联到 `<body>` 顶部，然后按 id 引用；
⚠ sprite 根自带的隐藏样式（1×1 + `opacity:0`）别换成 `display:none`——
不渲染的子树里 `<mask>`/`<clipPath>` 不生效，靠遮罩留白的图标会静默糊掉；
颜色跟随 CSS `color`（全部 `currentColor`）：

```html
<!-- 内联 icons-sprite.svg -->
<svg width="24" height="24"><use href="#play"/></svg>
```

> ⚠ 库里还没有这些图标，当前用 `icon-missing` 占位：`skip-next`、`repeat-one`
> 等它们进 `icons.svg` 后重跑本脚本即可换成真图标。


## media

| name | 说明 |
|------|------|
| `play` | 播放:实心右向三角 ▶(IEC 60417 磁带机惯例统一实心, 描边同色叠加得圆角); 20260819 media 批入库 |
| `pause` | 暂停:双竖杠 ⏸(粗 3.2 圆帽, brush-width 同款加粗手法); 20260819 media 批入库 |

## file

| name | 说明 |
|------|------|
| `folder` | 文件夹:左边 tab + 矩形主体 |

## common

| name | 说明 |
|------|------|
| `back` | 返回:左向整箭头(带杆;裸 chevron-left 曾因小尺寸渲染差被 sunset) |
| `x` | 叉 |
| `check` | 勾 |

## cloud

| name | 说明 |
|------|------|
| `cloud` | 云 |
| `cloud-synced` | 云+勾 |
| `cloud-unavailable` | — |
| `cloud-pending` | 待判定:虚线云 + 云内问号(加粗 2.4, 遮罩描边留白与云脱开;问号下点的半径=描边半宽) |
| `cloud-busy-base` | 云端忙 静态件:云轮廓中心挖圆洞, 与 cloud-busy-spinner 叠放合成一个资产 |
| `cloud-busy-spinner` | 云端忙 旋转件:弧+箭头, 圆心正在 (12,12) 所以 CSS rotate 原地转不甩 |
| `refresh` | 刷新:顺时针 3/4 圆 + 箭头(从 12 点绕到 9 点, 箭头尖在右上) |
| `sign-out` | 退出登录:门框+向外箭头(通用 logout 图元) |
| `download` | 下载 |

## ui

| name | 说明 |
|------|------|
| `menu` | 汉堡菜单:三条等长横线(y=7/12/17) |

## missing

| name | 说明 |
|------|------|
| `skip-next` ⚠占位 | 缺图标占位 — skip-next 尚未进 icons.svg |
| `repeat-one` ⚠占位 | 缺图标占位 — repeat-one 尚未进 icons.svg |
