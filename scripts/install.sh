#!/usr/bin/env bash
# Task 7 Step 1（计划骨架 + A-C3 偏差）：交付 .ts 产物——全局扫描只认 *.ts、*.js 静默忽略。
# 因此不拷 dist/blackboard.js，而是 bun build --target=bun 产出自包含单文件 dist/blackboard.ts。
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="global"; TARGET_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) MODE="project"; TARGET_DIR="${2:?--project 需要目录参数}"; shift 2 ;;
    *) echo "用法: install.sh [--project <目录>]"; exit 2 ;;
  esac
done
if [[ "$MODE" == "global" ]]; then TARGET_DIR="$HOME/.config/opencode/plugin"; else TARGET_DIR="$TARGET_DIR/.opencode/plugin"; fi
cd "$REPO"
bun build ./src/plugin.ts --target=bun --outfile=./dist/blackboard.ts >/dev/null
mkdir -p "$TARGET_DIR"
cp dist/blackboard.ts "$TARGET_DIR/blackboard.ts"
echo "installed: $TARGET_DIR/blackboard.ts ($(wc -c < "$TARGET_DIR/blackboard.ts") bytes)"
