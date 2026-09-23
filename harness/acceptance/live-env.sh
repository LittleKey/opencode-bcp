#!/bin/zsh
export PATH=/home/littlekey/.bun/bin:$PATH
export RUNS=/home/littlekey/github/opencode-bcp/harness/runs
export ACC=/home/littlekey/github/opencode-bcp/harness/acceptance
export BB=$HOME/.cache/opencode/blackboard
export LOG=$BB/log/blackboard.log
export MODEL=newapi/deepseek-v4-flash
mkdir -p "$BB/log" "$RUNS" "$ACC"
[[ -f $LOG ]] || : > "$LOG"
rgc() { [[ -f "$2" ]] || { echo "EVIDENCE-MISSING:$2"; return 1; }; local out rc=0; out=$(rg -c "$1" "$2") || rc=$?; if (( rc >= 2 )); then echo "RG-ERROR:$2"; return 1; fi; printf '%s\n' "${out:-0}"; }
logpos() { [[ -r $LOG ]] || { echo "LOG-UNREADABLE:$LOG" >&2; return 1; }; wc -l < $LOG; }
