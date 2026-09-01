#!/usr/bin/env bash
# BR v2 构建：tsc 类型门 + player-logic mock 测 → esbuild bundle → dev/（index.html=模板+图标 sprite 内联）。
set -euo pipefail
cd "$(dirname "$0")"
ESBUILD="../20260524 WeebPaint/tools/esbuild/esbuild"
[ -x "$ESBUILD" ] || { echo "缺 esbuild：$ESBUILD（先在 WebPaint 跑一次 build.sh 让它自动 curl）" >&2; exit 1; }
npx tsc --noEmit
node test/player-logic.test.mjs
node test/id3.test.mjs
"$ESBUILD" src/main.ts --bundle --format=esm  --target=safari16 --outfile=dev/app.js
"$ESBUILD" src/sw.ts   --bundle --format=iife --target=safari16 --outfile=dev/sw.js
python3 - << 'PY'
tpl = open("src/index.template.html").read()
# 共享 sprite 在前、本地补丁 sprite 在后：同 id 先到先得 → 真图入库重跑 extract 后 stopgap 自动让位
sprite = open("assets/icons-sprite.svg").read() + "\n" + open("assets/icons-local.svg").read()
assert "<!--ICONS_SPRITE-->" in tpl
open("dev/index.html", "w").write(tpl.replace("<!--ICONS_SPRITE-->", sprite))
PY
cp src/style.css dev/style.css
echo "OK: dev/（index.html app.js sw.js style.css）"
