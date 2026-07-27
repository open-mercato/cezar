#!/usr/bin/env bash
# cez-harness · PreToolUse(Bash) guard — structural stop-before-PR.
# The staged-only wrappers always STOP before the PR; pushing and opening PRs is
# the human's job. Denies remote pushes and PR creation at the tool boundary so
# a drifted or prompt-injected run cannot publish; the stage-time ref/reflog
# assertion remains the second, detective layer.
input="$(cat 2>/dev/null)"

extract_command() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null
  else
    printf '%s' "$input" | grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' | head -1 | sed -E 's/^"command"[[:space:]]*:[[:space:]]*"//; s/"$//'
  fi
}

cmd="$(extract_command)"
[ -n "$cmd" ] || exit 0

# Match the push/PR verbs even with leading options (git -C <dir> push,
# git --git-dir=<x> push, gh -R <repo> pr create). Each interposed token must
# start with '-' (optionally carrying one value), so subcommands like
# 'git log --grep push' do not match.
git_push='(^|[^[:alnum:]_])git[[:space:]]+(-[^[:space:]]+[[:space:]]+([^-][^[:space:]]*[[:space:]]+)?)*push([^[:alnum:]]|$)'
gh_pr_create='(^|[^[:alnum:]_])gh[[:space:]]+(-[^[:space:]]+[[:space:]]+([^-][^[:space:]]*[[:space:]]+)?)*pr[[:space:]]+create'
if printf '%s' "$cmd" | grep -qE "$git_push|$gh_pr_create"; then
  echo "[cez-harness] stop-before-PR: 'git push' and PR creation are the human's job — stage with 'git add' only." >&2
  exit 2
fi
exit 0
