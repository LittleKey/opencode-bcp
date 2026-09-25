#!/usr/bin/env bash
# Task 7 Step 1（计划骨架 + A-C3 偏差）：交付 .ts 产物——全局扫描只认 *.ts、*.js 静默忽略。
# DESIGN v1.7.1 §16.2/I5：双构建保留；安装按目标 major 互斥——默认装 v1（plugin/），
# --v2 装 v2（plugins/）。同根互斥：装一个 major 清另一 major 的既有文件。
# R3：同一 v2 宿主同时发现 global/祖先 project/目标 project 多个配置根
# （config/discovery.ts:23-36、source.ts:127-133、source-directory.ts:13-24），
# project 模式安装前检测所有可见根中的另一 major，存在即拒绝（--force 才继续并警告）；
# 不自动删除其他根的文件。
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="global"; TARGET_DIR=""; MAJOR="v1"; FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) MODE="project"; TARGET_DIR="${2:?--project 需要目录参数}"; shift 2 ;;
    --v2) MAJOR="v2"; shift ;;
    --force) FORCE=1; shift ;;
    *) echo "用法: install.sh [--v2] [--project <目录>] [--force]"; exit 2 ;;
  esac
done
cd "$REPO"
if [[ "${BB_INSTALL_SKIP_BUILD:-0}" != "1" ]]; then
  bun build ./src/adapters/v1/index.ts --target=bun --outfile=./dist/blackboard.ts >/dev/null
  bun build ./src/adapters/v2/index.ts --target=bun --outfile=./dist/blackboard-v2.ts >/dev/null
fi
if [[ "$MODE" == "global" ]]; then
  V1_DIR="$HOME/.config/opencode/plugin"
  V2_DIR="$HOME/.config/opencode/plugins"
else
  V1_DIR="$TARGET_DIR/.opencode/plugin"
  V2_DIR="$TARGET_DIR/.opencode/plugins"
fi

# 规范文件名检查：$1=v1 目录 $2=v2 目录；输出现存的「另一 major」规范文件路径
other_major_files() {
  if [[ "$MAJOR" == "v1" ]]; then
    [[ -e "$1/blackboard-v2.ts" ]] && echo "$1/blackboard-v2.ts"
    [[ -e "$2/blackboard-v2.ts" ]] && echo "$2/blackboard-v2.ts"
  else
    [[ -e "$1/blackboard.ts" ]] && echo "$1/blackboard.ts"
    [[ -e "$2/blackboard.ts" ]] && echo "$2/blackboard.ts"
  fi
  return 0
}

conflicts=()
if [[ "$MODE" == "project" ]]; then
  # N2：冲突检测范围必须与宿主实际发现范围等价（discovery.ts:23-69 从目标向上的
  # 全祖先链 + global.ts 的实际全局根覆盖）。
  # 先规范化：目标必须是已存在的目录，按物理路径（pwd -P）解析，拒绝不支持形态。
  if [[ ! -d "$TARGET_DIR" ]]; then
    echo "ERROR: --project 目标不是已存在目录: $TARGET_DIR" >&2
    exit 3
  fi
  TARGET_DIR="$(cd "$TARGET_DIR" && pwd -P)"
  [[ -d "$HOME" ]] && HOME="$(cd "$HOME" && pwd -P)" # 不存在的 HOME：保留字面值（其下根不存在、无冲突可检）
  global_root=""
  if [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
    global_root="$OPENCODE_CONFIG_DIR"
  elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    global_root="$XDG_CONFIG_HOME/opencode"
  else
    global_root="$HOME/.config/opencode"
  fi
  # 实际全局根：无论项目在哪都被宿主发现，恒检测
  while IFS= read -r f; do conflicts+=("$f"); done < <(other_major_files "$global_root/plugin" "$global_root/plugins")
  # $HOME/.opencode 不单独扫描（M-install）：仅当目标是 HOME 后代时宿主才可发现它，
  # 由下方完整祖先链覆盖；HOME 非祖先时该根不可见（误报跨根冲突），目标=HOME 时
  # 该根即本次安装目标根（同根互斥清理处理，不得判作跨根冲突）。
  # 目标的完整祖先链（物理路径），含文件系统根，无层数上限（超限即宿主可发现，必须检出）
  seen_root=""
  d="$(dirname "$TARGET_DIR")"
  while [[ -n "$d" ]]; do
    [[ "$d" == "$seen_root" ]] && break
    seen_root="$d"
    [[ -e "$d/.opencode" ]] && while IFS= read -r f; do conflicts+=("$f"); done < <(other_major_files "$d/.opencode/plugin" "$d/.opencode/plugins")
    [[ "$d" == "/" ]] && break
    d="$(dirname "$d")"
  done
  # 去重（HOME 可能同时出现在全局根与祖先链）
  if [[ ${#conflicts[@]} -gt 0 ]]; then
    mapfile -t conflicts < <(printf '%s\n' "${conflicts[@]}" | awk '!seen[$0]++')
  fi
  if [[ ${#conflicts[@]} -gt 0 && "$FORCE" != "1" ]]; then
    echo "ERROR: 同一宿主可发现的其他配置根存在另一 major，拒绝歧义安装（用 --force 覆盖）：" >&2
    printf '  %s\n' "${conflicts[@]}" >&2
    exit 2
  fi
  for f in "${conflicts[@]:-}"; do
    [[ -n "$f" ]] && echo "WARNING: --force 跨根混装，另一 major 仍将被宿主发现: $f" >&2
  done
fi

# 同根互斥清理：只删除本插件两个规范文件名（另一 major 的既有安装/错位拷贝），
# 不自动改动用户其他插件文件；其余 blackboard*.ts 残留仅警告。
cleanup_other_major() {
  local other="$1" # "v2"（装 v1 时）或 "v1"
  if [[ "$other" == "v2" ]]; then
    rm -f "$V2_DIR/blackboard-v2.ts" "$V1_DIR/blackboard-v2.ts"
  else
    rm -f "$V1_DIR/blackboard.ts" "$V2_DIR/blackboard.ts"
  fi
}

warn_mixed() {
  local f
  for f in "$V1_DIR"/* "$V2_DIR"/*; do
    [[ -e "$f" ]] || continue
    case "$(basename "$f")" in
      blackboard.ts|blackboard-v2.ts) continue ;; # 刚安装/已清理的规范名
      blackboard*) echo "WARNING: 疑似 blackboard 插件混装残留: $f" ;;
    esac
  done
  return 0
}

if [[ "$MAJOR" == "v1" ]]; then
  cleanup_other_major v2
  mkdir -p "$V1_DIR"
  cp dist/blackboard.ts "$V1_DIR/blackboard.ts"
  echo "installed: $V1_DIR/blackboard.ts ($(wc -c < "$V1_DIR/blackboard.ts") bytes)"
else
  cleanup_other_major v1
  mkdir -p "$V2_DIR"
  cp dist/blackboard-v2.ts "$V2_DIR/blackboard-v2.ts"
  echo "installed: $V2_DIR/blackboard-v2.ts ($(wc -c < "$V2_DIR/blackboard-v2.ts") bytes)"
fi
warn_mixed
