#!/usr/bin/env bash
# Task 7 Step 2：与 install 同一 target 语义；黑名单产物 blackboard.ts（含历史遗留 .js 一并清除）。
set -euo pipefail
MODE="global"; TARGET_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) TARGET_DIR="${2:?--project 需要目录参数}/.opencode/plugin"; shift 2 ;;
    *) echo "用法: uninstall.sh [--project <目录>]"; exit 2 ;;
  esac
done
[[ -z "$TARGET_DIR" ]] && TARGET_DIR="$HOME/.config/opencode/plugin"
REMOVED=0
for FILE in "$TARGET_DIR/blackboard.ts" "$TARGET_DIR/blackboard.js"; do
  if [[ -f "$FILE" ]]; then rm "$FILE"; echo "removed: $FILE"; REMOVED=1; fi
done
[[ "$REMOVED" -eq 1 ]] || echo "already absent: $TARGET_DIR/blackboard.ts"
echo "storage kept: $HOME/.cache/opencode/blackboard/v1（数据不随回滚删除）"
