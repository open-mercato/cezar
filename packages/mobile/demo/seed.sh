#!/usr/bin/env bash
# Seed the demo. Runs as the cezar-demo user (reset.sh calls it through runuser):
#
#   seed.sh repo            # create the demo git repository (cezar stopped: it is the service's WorkingDirectory)
#   seed.sh tasks [--force] # through cezar's HTTP API on loopback: finished, waiting and scheduled tasks, and a manager
#
# Every task runs against the bundled mock agent (CEZ_DRY_RUN=1). `mock:done` and `mock:ask` are the
# mock's own markers (packages/cezar/scripts/mock-claude.mjs): the first ends the turn with CEZ:DONE so
# the task settles in review, the second parks it on a question card.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"
cd /

[ "$(id -un)" = "$DEMO_USER_NAME" ] || die "run seed.sh as $DEMO_USER_NAME (reset.sh does: runuser -u $DEMO_USER_NAME -- …)"

# ---- repo ---------------------------------------------------------------------------------------
seed_repo() {
  # The default Claude profile must exist even for the mock: scheduling a task (Start later) checks
  # the account's directory is readable (automations/deferred-start.ts, bindDeferredPlan).
  mkdir -p "$DEMO_ROOT/.claude"
  if [ -d "$DEMO_REPO/.git" ]; then
    log "Demo repository already exists at $DEMO_REPO"
    return 0
  fi
  mkdir -p "$DEMO_REPO/src" "$DEMO_REPO/test"

  cat >"$DEMO_REPO/README.md" <<'EOF'
# tasklist

A tiny command-line to-do list. It is the sample project of the cezar demo server: every change you
see in the cockpit was made by cezar's built-in mock agent, so nothing here is real work.

```bash
node src/cli.js add "Buy milk"
node src/cli.js list
node src/cli.js done 1
npm test
```
EOF

  cat >"$DEMO_REPO/package.json" <<'EOF'
{
  "name": "tasklist",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "tasklist": "src/cli.js" },
  "scripts": { "test": "node --test test/" }
}
EOF

  cat >"$DEMO_REPO/src/tasks.js" <<'EOF'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function load(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export function save(file, tasks) {
  writeFileSync(file, `${JSON.stringify(tasks, null, 2)}\n`);
}

export function add(tasks, title) {
  const id = tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1;
  return [...tasks, { id, title, done: false }];
}

// Known bug, left for the demo: completing a finished task un-completes it.
export function complete(tasks, id) {
  return tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task));
}
EOF

  cat >"$DEMO_REPO/src/cli.js" <<'EOF'
#!/usr/bin/env node
import { add, complete, load, save } from './tasks.js';

const FILE = process.env.TASKLIST_FILE ?? 'tasks.json';
const [command, ...rest] = process.argv.slice(2);
let tasks = load(FILE);

if (command === 'add') {
  tasks = add(tasks, rest.join(' '));
  save(FILE, tasks);
} else if (command === 'done') {
  tasks = complete(tasks, Number(rest[0]));
  save(FILE, tasks);
} else if (command === 'list' || command === undefined) {
  for (const task of tasks) console.log(`${task.done ? '[x]' : '[ ]'} ${task.id}. ${task.title}`);
} else {
  console.error('usage: tasklist add <title> | done <id> | list');
  process.exit(2);
}
EOF

  cat >"$DEMO_REPO/test/tasks.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, complete } from '../src/tasks.js';

test('add numbers tasks from 1', () => {
  assert.deepEqual(add([], 'Buy milk'), [{ id: 1, title: 'Buy milk', done: false }]);
});

test('complete marks a task done', () => {
  assert.equal(complete(add([], 'x'), 1)[0].done, true);
});
EOF

  printf 'node_modules/\ntasks.json\n' >"$DEMO_REPO/.gitignore"

  git -C "$DEMO_REPO" init -q -b main
  git -C "$DEMO_REPO" add -A
  git -C "$DEMO_REPO" -c user.name='Cezar Demo' -c user.email=demo@cezar.invalid \
    commit -q -m 'Initial tasklist CLI'
  log "Created $DEMO_REPO"
}

# ---- tasks --------------------------------------------------------------------------------------
# POST, and fail loudly on anything but the expected status.
post() {
  local path=$1 body=$2 want=${3:-201} resp
  resp=$(api POST "$path" "$body")
  if [ "$(api_status "$resp")" != "$want" ]; then
    warn "POST $path answered $(api_status "$resp"): $(api_body "$resp" | head -c 300)"
    return 1
  fi
  api_body "$resp"
}

start_task() {
  local text=$1 body
  body=$(jq -n --arg task "$text" '{workflow: "quick-task", task: $task}')
  post /runs "$body" | jq -r '.id'
}

seed_tasks() {
  local force=${1:-} existing
  wait_for_health 90 || die "cezar is not answering on $DEMO_API"

  existing=$(api_body "$(api GET /runs)" | jq 'length')
  if [ "$existing" != 0 ] && [ "$force" != --force ]; then
    log "cezar already has $existing task(s); not seeding again (pass --force to add more)"
    return 0
  fi

  log "Starting demo tasks"
  start_task $'Add a --json flag to the list command\n\nScripts should be able to read the list. Print the tasks as a JSON array when --json is passed, and add a test.\n\nmock:done' >/dev/null || true
  start_task $'Fix: completing a finished task un-completes it\n\n`tasklist done 1` run twice should leave task 1 done. Fix complete() in src/tasks.js and cover it with a test.\n\nmock:done' >/dev/null || true
  start_task $'Write a short CONTRIBUTING.md\n\nExplain how to run the tests and how to propose a change.\n\nmock:ask' >/dev/null || true
  start_task $'Add a due date to tasks\n\nLet `tasklist add` take an optional --due YYYY-MM-DD and show it in the list.' >/dev/null || true

  # A scheduled task: shows the deferred-start ("start later") flow, and never runs before the
  # next nightly reset wipes it.
  local date preview revision key body
  date=$(date -u -d '+2 days' +%F)
  body=$(jq -n --arg date "$date" \
    '{task: {workflow: "quick-task", task: "Upgrade the test runner\n\nMove the tests to the newest node:test features and remove anything deprecated.\n\nmock:done"},
      start: {kind: "at", date: $date, hour: 9, minute: 0}}')
  if preview=$(post /deferred-start/preview "$body" 200) &&
    [ "$(printf '%s' "$preview" | jq -r '.available')" = true ]; then
    revision=$(printf '%s' "$preview" | jq -r '.previewRevision')
    key=$(cat /proc/sys/kernel/random/uuid)
    body=$(printf '%s' "$body" | jq --arg rev "$revision" --arg key "$key" '. + {previewRevision: $rev, idempotencyKey: $key}')
    post /deferred-start "$body" >/dev/null && log "Scheduled a task for $date 09:00 (server time)"
  else
    warn "could not schedule the deferred task: ${preview:-no preview}"
  fi

  # The app opens on /manager (StartDecision.java), so give it someone to talk to.
  local managers manager_id
  managers=$(api_body "$(api GET /workspace/managers)" | jq '.managers | length')
  if [ "$managers" = 0 ]; then
    body=$(jq -n '{
      name: "Demo manager",
      instructions: "You oversee the tasklist demo project. Summarize what needs attention and suggest next steps. This is a demo server: every agent is a mock.",
      projects: "all",
      cronMinutes: 60
    }')
    if manager_id=$(post /workspace/managers "$body" | jq -r '.id'); then
      post "/workspace/managers/$manager_id/messages" "$(jq -n '{text: "What needs my attention today?"}')" 200 >/dev/null || true
      log "Created a manager"
    fi
  fi

  # Let the mock finish so the cockpit opens on settled tasks, not on a burst of spinners.
  local i busy=1
  for ((i = 0; i < 120; i++)); do
    busy=$(api_body "$(api GET /runs)" | jq '[.[] | select(.status == "queued" or .status == "running")] | length')
    [ "$busy" = 0 ] && break
    sleep 2
  done
  [ "$busy" = 0 ] || warn "$busy task(s) still running after 4 minutes; they will settle on their own"
  api_body "$(api GET /runs)" | jq -r '.[] | "  \(.status)\t\(.title // .task | split("\n")[0])"'
}

case "${1:-}" in
  repo) seed_repo ;;
  tasks) seed_tasks "${2:-}" ;;
  *) printf 'usage: %s repo | tasks [--force]\n' "$0" >&2; exit 2 ;;
esac
