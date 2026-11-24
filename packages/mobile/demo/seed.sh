#!/usr/bin/env bash
# Seed the store-review demo. On the VPS it runs as the cezar-demo user (reset.sh calls it through
# runuser); local.sh runs it on a Mac with DEMO_LOCAL=1.
#
#   seed.sh repos           # create the three sample git repositories (before cezar starts)
#   seed.sh tasks [--force] # through cezar's HTTP API on loopback: projects, tasks in every state, a manager
#   seed.sh tick            # every 2 h (cezar-demo-tick.timer): keep one task running, so the demo looks alive
#
# Agents are the bundled mock in its demo mode (CEZ_DEMO=1, packages/cezar/scripts/mock-claude.mjs): every
# reply says it is a demo. A hidden `<!-- demo:… -->` tag in a task's text picks its script.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"
cd /

if [ "${DEMO_LOCAL:-}" != 1 ]; then
  [ "$(id -un)" = "$DEMO_USER_NAME" ] || die "run seed.sh as $DEMO_USER_NAME (reset.sh does: runuser -u $DEMO_USER_NAME -- …)"
fi

# ---- repos --------------------------------------------------------------------------------------
make_repo() {
  local message=$2 dir=$DEMO_PROJECTS/$1
  shift 2
  [ -d "$dir/.git" ] && return 0
  mkdir -p "$dir"
  while [ $# -ge 2 ]; do
    mkdir -p "$dir/$(dirname "$1")"
    printf '%s\n' "$2" >"$dir/$1"
    shift 2
  done
  git -C "$dir" init -q -b main
  git -C "$dir" add -A
  git -C "$dir" -c user.name='Cezar Demo' -c user.email=demo@cezar.invalid commit -q -m "$message"
  log "Created $dir"
}

seed_repos() {
  # The default Claude profile must exist even for the mock (automations/deferred-start.ts).
  mkdir -p "$DEMO_ROOT/.claude"
  make_repo todo-cli 'Initial to-do CLI' \
    README.md $'# todo-cli\n\nA tiny command-line to-do list. Sample project of the cezar demo: nothing here is real work.' \
    package.json '{ "name": "todo-cli", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test test/" } }' \
    src/cli.js $'#!/usr/bin/env node\n// TODO: add --json\nconsole.log("todo-cli");' \
    test/cli.test.js $'import { test } from "node:test";\ntest("placeholder", () => {});'
  make_repo storefront 'Storefront skeleton' \
    README.md $'# storefront\n\nA sample web shop for the cezar demo. Nothing here is real.' \
    src/checkout.js $'export function total(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}' \
    src/cart.js 'export const cart = [];'
  make_repo docs-site 'Docs site skeleton' \
    README.md $'# docs-site\n\nSample documentation site for the cezar demo.' \
    docs/getting-started.md $'# Getting started\n\nInstall, then run.'
}

# ---- API helpers ----------------------------------------------------------------------------------
post() {
  local path=$1 body=$2 want=${3:-201} resp
  resp=$(api POST "$path" "$body")
  if [ "$(api_status "$resp")" != "$want" ]; then
    warn "POST $path answered $(api_status "$resp"): $(api_body "$resp" | head -c 300)"
    return 1
  fi
  api_body "$resp"
}

project_id() { # the registered id of a project directory
  api_body "$(api GET /projects)" | jq -r --arg root "$DEMO_PROJECTS/$1" '[.projects[]? // .[]? | select(.root == $root or (.root | endswith("/" + ($root | split("/") | last))))][0].id // empty'
}

start_task() { # project dir name, task text → run id
  local project=$1 text=$2 id body
  id=$(project_id "$project")
  [ -n "$id" ] || { warn "project $project is not registered"; return 1; }
  body=$(jq -n --arg task "$text" '{workflow: "quick-task", task: $task}')
  post "/p/$id/runs" "$body" | jq -r '.id'
}

wait_settled() { # wait until nothing but the long task is busy
  local i busy
  for ((i = 0; i < 90; i++)); do
    busy=0
    for project in todo-cli storefront docs-site; do
      id=$(project_id "$project")
      n=$(api_body "$(api GET "/p/$id/runs")" | jq '[.[] | select((.status == "queued" or .status == "running") and ((.task // "") | contains("demo:long") | not))] | length')
      busy=$((busy + n))
    done
    [ "$busy" = 0 ] && return 0
    sleep 2
  done
  warn "$busy task(s) still busy; they will settle on their own"
}

open_pr() { # fake in a dry run: no push, no GitHub call
  local project=$1 run=$2 id
  id=$(project_id "$project")
  post "/p/$id/runs/$run/pr" '{}' 201 >/dev/null || warn "could not open the demo PR for $run"
}

# ---- tasks --------------------------------------------------------------------------------------
LONG_TASK=$'Refactor the storage layer\n\nMove reading and writing tasks behind one small module, and keep every test green.\n\n<!-- demo:long -->'

seed_tasks() {
  local force=${1:-} existing
  wait_for_health 90 || die "cezar is not answering on $DEMO_API"
  for project in storefront docs-site; do
    [ -n "$(project_id "$project")" ] || post /projects "$(jq -n --arg root "$DEMO_PROJECTS/$project" '{root: $root}')" 200 >/dev/null || true
  done

  existing=$(api_body "$(api GET /runs)" | jq 'length')
  if [ "$existing" != 0 ] && [ "$force" != --force ]; then
    log "cezar already has $existing task(s); not seeding again (pass --force to add more)"
    return 0
  fi

  log "Starting demo tasks"
  local json_flag due checkout coupon
  json_flag=$(start_task todo-cli $'Add a --json flag to the list command\n\nScripts should be able to read the list as JSON.\n\n<!-- demo:done -->') || true
  start_task todo-cli $'Write a short CONTRIBUTING.md\n\nExplain how to run the tests and how to propose a change.' >/dev/null || true
  due=$(start_task todo-cli $'Add a due date to tasks\n\nLet `add` take an optional --due date and show it in the list.\n\n<!-- demo:reply -->') || true
  checkout=$(start_task storefront $'Fix rounding in the checkout total\n\nPrices like 0.1 + 0.2 show as 0.30000000000000004.\n\n<!-- demo:done -->') || true
  coupon=$(start_task storefront $'Add coupon codes to the cart\n\nA coupon takes a percentage off the total.') || true
  start_task docs-site $'Add a FAQ page\n\nCollect the five questions users ask most.\n\n<!-- demo:done -->' >/dev/null || true
  wait_settled
  [ -n "${json_flag:-}" ] && open_pr todo-cli "$json_flag"
  [ -n "${checkout:-}" ] && open_pr storefront "$checkout"
  : "${due:=}" "${coupon:=}"

  start_task todo-cli "$LONG_TASK" >/dev/null || true

  local managers manager_id body
  managers=$(api_body "$(api GET /workspace/managers)" | jq '.managers | length')
  if [ "$managers" = 0 ]; then
    body=$(jq -n '{
      name: "Demo manager",
      instructions: "This is a demo cezar for App Review: every agent is simulated. Summarize what needs attention.",
      projects: "all",
      cronMinutes: 0
    }')
    if manager_id=$(post /workspace/managers "$body" | jq -r '.id'); then
      post "/workspace/managers/$manager_id/messages" "$(jq -n '{text: "Good morning! What needs me today?"}')" 200 >/dev/null ||
        post "/workspace/managers/$manager_id/messages" "$(jq -n '{text: "Good morning! What needs me today?"}')" 202 >/dev/null || true
      log "Created the manager"
    fi
  fi
  sleep 5
  for project in todo-cli storefront docs-site; do
    api_body "$(api GET "/p/$(project_id "$project")/runs")" | jq -r --arg p "$project" '.[] | "  \($p)\t\(.status)\t\(.title // (.task | split("\n")[0]))"'
  done
}

# Keep one task running: the previous long task finishes on its own after about 50 minutes.
seed_tick() {
  wait_for_health 30 || die "cezar is not answering on $DEMO_API"
  local id running
  id=$(project_id todo-cli)
  running=$(api_body "$(api GET "/p/$id/runs")" | jq '[.[] | select(.status == "running" or .status == "queued")] | length')
  if [ "$running" = 0 ]; then
    start_task todo-cli "$LONG_TASK" >/dev/null && log "Started a new running task"
  fi
}

case "${1:-}" in
  repos) seed_repos ;;
  tasks) seed_tasks "${2:-}" ;;
  tick) seed_tick ;;
  *) printf 'usage: %s repos | tasks [--force] | tick\n' "$0" >&2; exit 2 ;;
esac
