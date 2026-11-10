#!/bin/sh
# Host-telemetry conformance (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`,
# Implementation Plan step 11).
#
# Runs the REAL probe - the same module the sampler calls - in four environments and prints, for
# each: the cgroup files the process can see, the probe's facts, and the `container` object the
# sampler would put on the wire. The point is to show that a sandbox is read as effective capacity
# and a plain host is read as it always was, on one machine, in one command.
#
# Cases:
#   host        no container at all: the dev-host counterexample (root `max`/`max` + readable usage)
#   cpus        `docker --cpus=2 --memory=1g`: a quota + memory limit
#   cpuset      `docker --cpuset-cpus=<two cores>`: cpu.max stays `max`, cpuset.cpus.effective is 2
#   cgroupns    `docker --cgroupns=host --cpus=2`: the limit sits on an ANCESTOR cgroup of the
#               private namespace, which is the case a root-only read misses
#
# Requires: docker (with an image that has Node; override with CEZ_CONFORMANCE_IMAGE) and network on
# the first run to pull it. Read-only mounts only: nothing here writes into the repository.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
IMAGE=${CEZ_CONFORMANCE_IMAGE:-node:22-bookworm-slim}

log() { printf '%s\n' "$*" >&2; }

# The probe + sampler, imported from the working directory (the repo on the host, /app in the
# container). `tsx` is already a devDependency, so this needs no build of its own and prints the
# FINAL wire object rather than a paraphrase.
PROBE_SNIPPET='
import { createHostSampler } from "./packages/cezar/src/core/host-usage.ts";
import { createCgroupProbe } from "./packages/cezar/src/core/cgroup-probe.ts";
(async () => {
  const facts = createCgroupProbe()();
  const sampler = createHostSampler({ platform: "linux" });
  const first = sampler.sampleHostUsage();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = sampler.sampleHostUsage();
  console.log(JSON.stringify({ facts: facts ?? null, container: second.container ?? null,
    hostCpuCount: second.hostCpuCount ?? null, cgroupProbe: second.cgroupProbe ?? null,
    firstSampleHadCpu: first.cpuPct !== undefined,
    secondSampleHadCpu: second.cpuPct !== undefined }, null, 2));
})();
'

RAW_FILES='for f in /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max \
  /sys/fs/cgroup/cpuset.cpus.effective /proc/self/cgroup; do \
  [ -f "$f" ] && printf "%s: %s\n" "$f" "$(cat "$f")"; done'

run_in_container() {
  description=$1
  shift
  log ""
  log "=== $description"
  docker run --rm "$@" "$IMAGE" sh -lc "$RAW_FILES; echo; cd /app && npx tsx -e '$PROBE_SNIPPET'"
}

# ---- 1. the host itself ------------------------------------------------------
log "=== host (this machine, no container)"
sh -lc "$RAW_FILES"
(cd "$REPO_ROOT" && npx tsx -e "$PROBE_SNIPPET")

# ---- 2..4 the sandbox cases --------------------------------------------------
# Docker refuses `--cpuset-cpus` for cores its daemon cannot see, and the daemon's allowed set is
# not always the shell's: try single cores from the shell's own allowed list until one is accepted.
# A one-core pin is the sharpest form of the case - `cpu.max` stays `max` while effective capacity
# is a single core.
allowed=$(sed -n 's/^Cpus_allowed_list:[[:space:]]*//p' /proc/self/status 2>/dev/null || true)
cores=$(printf '%s' "$allowed" | awk -F, '{
  for (i = 1; i <= NF; i++) {
    n = split($i, range, "-")
    if (n == 1) print range[1]
    else for (c = range[1]; c <= range[2]; c++) print c
  }
}')
cpuset_core=""
for core in $cores; do
  if docker run --rm --cpuset-cpus="$core" "$IMAGE" true >/dev/null 2>&1; then
    cpuset_core="$core"
    break
  fi
done

run_in_container "cpus - docker --cpus=2 --memory=1g" \
  --cpus=2 --memory=1g -v "$REPO_ROOT":/app:ro -w /app

if [ -n "$cpuset_core" ]; then
  run_in_container "cpuset - docker --cpuset-cpus=$cpuset_core" \
    --cpuset-cpus="$cpuset_core" -v "$REPO_ROOT":/app:ro -w /app
else
  log "SKIP cpuset: the docker daemon accepts none of this shell's cores"
fi

run_in_container "cgroupns - docker --cgroupns=host --cpus=2" \
  --cgroupns=host --cpus=2 -v "$REPO_ROOT":/app:ro -w /app

# The two rows the first review of this asset asked for (they pin the cases the dev host cannot
# show): a cpuset pin read through the namespace-host layout, and a process whose cgroup files are
# not visible AT ALL - which must say "unavailable" rather than claim an unconstrained host.
if [ -n "$cpuset_core" ]; then
  run_in_container "cpuset-ancestor - docker --cgroupns=host --cpuset-cpus=$cpuset_core" \
    --cgroupns=host --cpuset-cpus="$cpuset_core" -v "$REPO_ROOT":/app:ro -w /app
else
  log "SKIP cpuset-ancestor: the docker daemon accepts none of this shell's cores"
fi

run_in_container "unreadable - docker --tmpfs /sys/fs/cgroup (no cgroup files visible)" \
  --tmpfs /sys/fs/cgroup -v "$REPO_ROOT":/app:ro -w /app

log ""
log "Expected: host => container null; cpus => cpuQuotaCores 2 + memLimitBytes;"
log "          cpuset => cpuAffinityCores 1 with no quota (cpu.max stays max);"
log "          cgroupns => the same quota as cpus, read from the owned scope;"
log "          cpuset-ancestor => cpuAffinityCores 1 through the namespace-host layout;"
log "          unreadable => cgroupProbe 'unavailable' and NO container key."
