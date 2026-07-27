#!/usr/bin/env bash
# cez-harness · PreToolUse(Edit|Write) guard — freeze test files during the fix phase.
#
# Gated by a SENTINEL FILE, not an env var: a PreToolUse hook runs in the host's
# own process, so an exported variable inside a Bash tool call can never reach it.
# The orchestrator touches `<worktree>/.om-freeze-tests` after the regression test
# has been observed failing and removes it before staging; while the sentinel is
# present at or above the target file, edits to test files are denied so the fix
# loop cannot weaken the test it is supposed to satisfy.
input="$(cat 2>/dev/null)"

extract_path() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null
  else
    printf '%s' "$input" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/'
  fi
}

fp="$(extract_path)"
[ -n "$fp" ] || exit 0

# Normalize to an absolute path first: a repo-relative path is the common case,
# and both the test-pattern match (leading-slash forms like /__tests__/) and the
# ancestor walk below need the full path.
case "$fp" in
  /*) : ;;
  *)  fp="$PWD/$fp" ;;
esac

# Only test files are ever frozen.
printf '%s' "$fp" | grep -qE '(\.spec\.|\.test\.|/__tests__/|/__integration__/|/(test|tests|spec)/|/(test_[^/]+|[^/]+_test)\.[^/]+$)' || exit 0

dir="$(dirname "$fp" 2>/dev/null || true)"
[ -n "$dir" ] || exit 0
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -e "$dir/.om-freeze-tests" ]; then
    echo "[cez-harness] test files are frozen during the fix phase (found $dir/.om-freeze-tests) — fix product code, not tests. Remove the sentinel to edit tests." >&2
    exit 2
  fi
  parent="$(dirname "$dir")"
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done
exit 0
