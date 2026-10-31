#!/bin/sh
# Adaptive admission demo (spec `.ai/specs/2026-09-20-adaptive-admission-governor.md`).
#
# Shows the whole feature end to end against a REAL cgroup, in about a minute:
#
#   1. configure the ceiling the governor reduces (`dispatchMaxConcurrent = 4`),
#   2. read the baseline: state `normal`, effective 4,
#   3. induce real memory pressure INSIDE the container's own cgroup (a 30 s allocation that
#      crosses the 85 % threshold),
#   4. watch the governor lower the effective ceiling (2 at `elevated`),
#   5. release, and watch it lift back to 4 after the calm streak.
#
# Usage:  sh .ai/scripts/adaptive-admission-demo.sh [baseUrl] [containerName]
#   baseUrl        default http://127.0.0.1:4399  (the docker demo instance from the PR body)
#   containerName  default cez-sandbox-demo       (its name, so the pressure is induced INSIDE it)
#
# Prereqs: a cezar built from this branch, running inside a container with a memory limit
# (`docker run --cpus=2 --memory=1g ...`) and a workspace where the demo may set the ceiling.
set -eu

BASE_URL=${1:-http://127.0.0.1:4399}
CONTAINER=${2:-cez-sandbox-demo}
POLLS=${CEZ_DEMO_POLLS:-30}

say() { printf '%s\n' "$*"; }

# One read of the governor's snapshot, in a compact one-liner.
admission() {
  curl -sf "$BASE_URL/api/v1/workspace/host-usage" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      const sample = JSON.parse(raw);
      const admission = sample.admission;
      if (!admission) { console.log("(no admission key - no ceiling configured)"); return; }
      console.log(`state=${admission.state} effective=${admission.effective} of configured=${admission.configured}`);
    });
  '
}

# The ratio the GOVERNOR thresholds on, read from the container's own cgroup files - not the card's
# rendered value, which is a different quantity (it resolves the tightest limit on the ancestor
# chain). Narrating the display number next to a governor decision is how the page-cache inflation
# stayed invisible in the first live run.
pressure() {
  docker exec "$CONTAINER" sh -c '
    limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max)
    if [ "$limit" = "max" ]; then echo "(no finite memory limit on the container cgroup)"; exit 0; fi
    current=$(cat /sys/fs/cgroup/memory.current)
    inactive=$(awk "/^inactive_file /{print \$2; exit}" /sys/fs/cgroup/memory.stat 2>/dev/null)
    awk -v c="$current" -v i="${inactive:-0}" -v l="$limit" \
      "BEGIN { u = c - i; if (u < 0) u = 0; printf \"used=%dMiB of %dMiB (%d%% cache-excluded - the ratio the governor thresholds on)\n\", u/1048576, l/1048576, 100*u/l }"
  '
}

say "== 0. baseline before any ceiling"
say "admission: $(admission)"

say "== 1. configure dispatchMaxConcurrent = 4"
curl -sf -X PUT "$BASE_URL/api/v1/workspace/config" \
  -H 'content-type: application/json' \
  -d '{"resources":{"dispatchMaxConcurrent":4}}' >/dev/null
sleep 1
say "admission: $(admission)"
say "pressure:  $(pressure)"

say "== 2. induce real memory pressure inside $CONTAINER for ~25 s"
docker exec -d "$CONTAINER" node -e '
  // Hold a big allocation so memory.current crosses the governor threshold, then release it.
  const held = [];
  for (let i = 0; i < 9; i += 1) held.push(Buffer.alloc(95 * 1024 * 1024, 1));
  setTimeout(() => held.length = 0, 25_000);
'

say "== 3. watching for the reduction (elevated or critical)"
seen=""
i=0
while [ "$i" -lt "$POLLS" ]; do
  i=$((i + 1))
  line=$(admission)
  say "  poll $i: $line  | $(pressure)"
  case "$line" in
    *state=normal*) ;;
    *) seen=$line; break ;;
  esac
  sleep 2
done
if [ -z "$seen" ]; then
  say "!! the governor never left normal - is the ceiling configured and the pressure real?"
  exit 1
fi
say "reduced: $seen"

say "== 4. pressure released; watching for the lift back (needs 6 calm samples)"
i=0
while [ "$i" -lt "$POLLS" ]; do
  i=$((i + 1))
  line=$(admission)
  say "  poll $i: $line"
  case "$line" in
    *state=normal*effective=4*) say "lifted back to the configured ceiling"; break ;;
  esac
  sleep 2
done

say "== done. The readout on Settings -> Resources shows the same state machine."
