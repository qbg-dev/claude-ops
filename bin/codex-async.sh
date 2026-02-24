#!/bin/bash
# Async Codex wrapper for Claude Code
# Usage:
#   codex-async.sh start <task_id> <prompt>  - Start a Codex task in background
#   codex-async.sh check <task_id>            - Check if task is done
#   codex-async.sh wait <task_id>             - Wait for task and get output
#   codex-async.sh output <task_id>           - Get output if done

CODEX_TASKS_DIR="$HOME/.claude/codex-tasks"
mkdir -p "$CODEX_TASKS_DIR"

case "$1" in
  start)
    TASK_ID="$2"
    PROMPT="$3"
    EFFORT="${4:-high}"  # default to high, can be xhigh
    TASK_DIR="$CODEX_TASKS_DIR/$TASK_ID"
    mkdir -p "$TASK_DIR"

    # Write prompt to file
    echo "$PROMPT" > "$TASK_DIR/prompt.txt"
    echo "running" > "$TASK_DIR/status.txt"

    # Run codex in background (exec = non-interactive mode)
    (
      cd "$(pwd)"
      codex exec -c "model_reasoning_effort=\"$EFFORT\"" "$PROMPT" > "$TASK_DIR/output.txt" 2>&1
      echo "done" > "$TASK_DIR/status.txt"
    ) &

    echo "$!" > "$TASK_DIR/pid.txt"
    echo "Started task $TASK_ID (PID: $!)"
    ;;

  check)
    TASK_ID="$2"
    TASK_DIR="$CODEX_TASKS_DIR/$TASK_ID"
    if [ -f "$TASK_DIR/status.txt" ]; then
      cat "$TASK_DIR/status.txt"
    else
      echo "not_found"
    fi
    ;;

  wait)
    TASK_ID="$2"
    TIMEOUT="${3:-300}"  # default 5 min timeout
    TASK_DIR="$CODEX_TASKS_DIR/$TASK_ID"

    if [ ! -f "$TASK_DIR/pid.txt" ]; then
      echo "Task not found: $TASK_ID"
      exit 1
    fi

    PID=$(cat "$TASK_DIR/pid.txt")
    ELAPSED=0

    while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
      STATUS=$(cat "$TASK_DIR/status.txt" 2>/dev/null)
      if [ "$STATUS" = "done" ]; then
        cat "$TASK_DIR/output.txt"
        exit 0
      fi
      sleep 2
      ELAPSED=$((ELAPSED + 2))
    done

    echo "Timeout waiting for task $TASK_ID"
    exit 1
    ;;

  output)
    TASK_ID="$2"
    TASK_DIR="$CODEX_TASKS_DIR/$TASK_ID"
    if [ -f "$TASK_DIR/output.txt" ]; then
      cat "$TASK_DIR/output.txt"
    else
      echo "No output yet"
    fi
    ;;

  list)
    for d in "$CODEX_TASKS_DIR"/*/; do
      if [ -d "$d" ]; then
        TASK_ID=$(basename "$d")
        STATUS=$(cat "$d/status.txt" 2>/dev/null || echo "unknown")
        echo "$TASK_ID: $STATUS"
      fi
    done
    ;;

  clean)
    rm -rf "$CODEX_TASKS_DIR"/*
    echo "Cleaned all tasks"
    ;;

  *)
    echo "Usage: codex-async.sh {start|check|wait|output|list|clean} [args...]"
    exit 1
    ;;
esac
