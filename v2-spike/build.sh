#!/usr/bin/env bash
# BR v2 spike 构建（ad hoc）：esbuild 直接从 store src 打包（正式收货以后走 tgz，这是 spike 特权）。
set -euo pipefail
cd "$(dirname "$0")"
ESBUILD="../../20260524 WebPaint/tools/esbuild/esbuild"
[ -x "$ESBUILD" ] || { echo "缺 esbuild：$ESBUILD（先在 WebPaint 跑一次 build.sh 让它自动 curl）" >&2; exit 1; }
"$ESBUILD" src/main.ts --bundle --format=esm  --target=safari16 --outfile=app.js
"$ESBUILD" src/sw.ts   --bundle --format=iife --target=safari16 --outfile=sw.js
echo "OK: app.js sw.js"
