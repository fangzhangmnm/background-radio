# 本 app 的图标

11 icons · 提取自家族图标库 `../20260708 SVG Icons/icons.svg` · 由 `extract-icons.py` 生成，别手改。

用法：把 sprite 整段内联到 `<body>` 顶部，然后按 id 引用；
⚠ sprite 根自带的隐藏样式（1×1 + `opacity:0`）别换成 `display:none`——
不渲染的子树里 `<mask>`/`<clipPath>` 不生效，靠遮罩留白的图标会静默糊掉；
颜色跟随 CSS `color`（全部 `currentColor`）：

```html
<!-- 内联 icons-sprite.svg -->
<svg width="24" height="24"><use href="#play"/></svg>
```


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

## cloud

| name | 说明 |
|------|------|
| `download` | 下载 |
| `cloud-synced` | 云+勾 |
| `cloud-unavailable` | — |
| `cloud-pending` | 待判定:虚线云 + 云内问号(加粗 2.4, 遮罩描边留白与云脱开;问号下点的半径=描边半宽) |
| `cloud-busy-base` | 云端忙 静态件:云轮廓中心挖圆洞, 与 cloud-busy-spinner 叠放合成一个资产 |
| `cloud-busy-spinner` | 云端忙 旋转件:弧+箭头, 圆心正在 (12,12) 所以 CSS rotate 原地转不甩 |
