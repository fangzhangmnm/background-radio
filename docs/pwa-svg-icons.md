# PWA 图标 — SVG 矢量加 ImageMagick 转 PNG 的现实

> 整篇都是本项目实际 ship 的内容:图标、manifest、SW、GH Pages 自动部署 + 热更新 toast 全套都在线上跑。SW lifecycle 细节单独见 [service-worker-and-updates.md](service-worker-and-updates.md)。

## TL;DR

- PWA / iOS 需要的固定文件:`icon.svg`(矢量,现代浏览器 favicon / manifest 都吃)、`icon-192.png` + `icon-512.png`(Chrome/Edge install)、`apple-touch-icon.png`(iOS 主屏,**必须 PNG**,推荐 180×180)。
- **ImageMagick(`convert`)的内置 SVG 渲染器不认 `<linearGradient>` / `<radialGradient>` 引用**,渲出来的 PNG 渐变全失踪、只剩描边。要么装 librsvg 让 convert 走 RSVG 后端,要么 SVG 改成纯实色。
- Win8 扁平风本来就不喜欢渐变,改成实色不一定亏。
- 设计上为小尺寸服务 —— 192px 缩到 32×32 favicon 还要能认出来,主元素只能 1~2 个。

## 三件套生成

```bash
convert -background none -density 300 icon.svg -resize 512x512 icon-512.png
convert -background none -density 300 icon.svg -resize 192x192 icon-192.png
convert -background none -density 300 icon.svg -resize 180x180 apple-touch-icon.png
```

`-density 300` 让 SVG 先栅格化到高分辨率,再 resize 下来,小尺寸更锐。`-background none` 保留透明。

## "我的渐变去哪了" 复现

```svg
<defs>
  <linearGradient id="dial" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ede5cf"/>
    <stop offset="100%" stop-color="#b8a87e"/>
  </linearGradient>
</defs>
<path d="..." fill="url(#dial)"/>
```

ImageMagick 默认用的是 MSVG(内置 micro 渲染器),不认 `url(#id)` 引用。结果:`fill` 当成 none,只有 `stroke` 出现。

判断:渲染后 PNG 里只有线条没有面 = 中了。

修法二选一:
1. 装 librsvg(WSL: `sudo apt install librsvg2-bin`),ImageMagick 会自动走 RSVG 后端,渐变正常
2. SVG 改成 `fill="#solidcolor"`,**所有**渐变都去掉(包括 needle 等小部件)

这个项目走的是 2,因为 Win8 扁平本来推崇实色。

## 设计原则(为小尺寸服务)

- **1~2 个识别元素**。如果主元素能在 32×32 认出来,512×512 自然没问题;反过来不成立。
- **强对比**。底色暖炭灰 + dial 米黄 = 50% 对比,小尺寸也分得清。
- **不靠细节**。tick marks 那种细节在 192px 还看得见,32px 糊成一片但**不影响主体识别**。这就 OK,不要追求 32px 还清晰。
- **圆角方底比正方更友好**。iOS / Android 都会再切圆角,你预切一下(`rx=80` for viewBox=512)避免出现两层圆角错位。
- **safe zone**。Android adaptive icon 会切掉外圈 ~20%,主元素留在中心 60%~80% 的"安全区"。

## manifest.webmanifest

```json
{
  "name": "Background Radio",
  "short_name": "Radio",
  "start_url": "./",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#221f1a",
  "theme_color": "#221f1a",
  "icons": [
    { "src": "icon.svg", "type": "image/svg+xml", "sizes": "any" },
    { "src": "icon-192.png", "type": "image/png", "sizes": "192x192" },
    { "src": "icon-512.png", "type": "image/png", "sizes": "512x512" },
    { "src": "icon-512.png", "type": "image/png", "sizes": "512x512", "purpose": "maskable" }
  ]
}
```

- `display: "standalone"` = 装到主屏后没浏览器 chrome,iOS 后台播放才稳。
- `purpose: "maskable"` 让 Android adaptive icon 用同一张图(前提是 safe zone 留够,否则边缘被切)。
- SVG 给 `sizes: "any"` 让浏览器随便挑尺寸用。

## HTML 引用

```html
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="icon.svg">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="theme-color" content="#221f1a">
```

iOS 不读 manifest 里的 icons —— 必须 `<link rel="apple-touch-icon">` 单独给。这是分开维护两份的原因。

## 坑

- iOS 主屏 icon 用的是装到主屏**那一刻**的 `apple-touch-icon.png` 快照,改了 PNG 用户不会自动看到新图,要长按删了重装。开发阶段忽略,上线前注意。
- Chrome devtools 的 Application → Manifest 面板会缓存 icon,改了图刷新页面看不到 —— 关 tab 重开,或者改 URL 加 query。
- Maskable icon 一定要预留 safe zone,否则装到 Android 主屏 logo 边缘被切。
- SVG 的 `<title>` / `aria-label` 加上,屏幕阅读器友好且 favicon hover 提示用得上。
