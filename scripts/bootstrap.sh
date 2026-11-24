#!/usr/bin/env bash
# 一行安装（macOS / Linux）：
#   curl -fsSL https://raw.githubusercontent.com/<owner>/video-subtitle-extractor/main/scripts/bootstrap.sh | bash
# 可选环境变量：
#   VSX_DEST   技能安装目录（默认 ~/.doubao/skills/video-subtitle-extractor）
#   VSX_REPO   owner/repo 覆盖
#   VSX_REF    分支/标签
#   VSX_MODEL  small|base|medium|large-v3|none
set -euo pipefail

REPO="${VSX_REPO:-Zblac/video-subtitle-extractor}"
REF="${VSX_REF:-main}"
DEST="${VSX_DEST:-$HOME/.doubao/skills/video-subtitle-extractor}"
MODEL="${VSX_MODEL:-small}"

PY="${VSX_PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || PY=python

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[bootstrap] 下载安装器 $REPO@$REF"
curl -fsSL --retry 3 --retry-all-errors --retry-delay 3 \
  "https://raw.githubusercontent.com/$REPO/$REF/scripts/install.py" -o "$TMP/install.py"

echo "[bootstrap] 拉代码 + 装依赖 → $DEST"
"$PY" "$TMP/install.py" --bootstrap --repo "$REPO" --ref "$REF" --dest "$DEST" \
  --install-deps --model "$MODEL"

echo "[bootstrap] 完成。用法："
echo "  node \"$DEST/ytsub.js\" \"<视频链接>\" --json"
