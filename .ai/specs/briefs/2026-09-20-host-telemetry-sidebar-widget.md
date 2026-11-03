# Effective host telemetry + the sidebar glance — container-aware v2

- Date: 2026-09-20
- Category: feature
- Priority signal: high — v1 (#1036) reports host totals; a cgroup-limited process can see
  "64 CPU / 755 GB" while capped at 6 CPU / 16 GB, so the card and any future admission signal
  misread the environment. The owner also wants the glance visible while working.
- Risk signal: medium — the container probe must resolve the **process's own cgroup** and its
  ancestors (not the namespace root), handle cgroup v1 `-1` sentinels and mount layouts, treat a
  cpuset below the host core count as a CPU limit, and never mix host/container scopes; the
  client adds a per-app store and a desktop subscription while keeping the v1 card subscription
  as the `<md` fallback.
- Routing: Next: om-auto-write-spec "Effective host telemetry + sidebar widget — brief: .ai/specs/briefs/2026-09-20-host-telemetry-sidebar-widget.md"

## Problem

v1's sampler is host-level: `cpuPct` from `os.cpus()` deltas, memory from `os.totalmem/freemem`,
load from `os.loadavg()`; only `cpuCount` uses `os.availableParallelism()`, which is
cgroup-quota aware only from libuv 1.49 (Node 22.12+/23.5+/24+; Node 20 is affinity-only). In a
Docker/Sandbox deployment the card therefore shows host numbers, guarded by a static caveat.
Two review rounds (`461df7d3`, `d3d0e2ca`) fixed the widget's subscription/store/UI shape; the
re-reviews (`366cf417` architecture/UX, `9a043744` technical) then found the container layer's
OS-level defects: reading the namespace/root cgroup instead of the process's cgroup, usage-only
being mistaken for a limit, cgroup v1 `-1` producing negative cores, missing mount resolution,
missing `hostCpuCount`, and `??` fallbacks mixing host and container scopes (host-wide CPU %
next to an effective core count; >100 % when no quota). This brief and its spec are the
correction.

The final verification (`f450c6b4`, 0 Critical / 0 High) then pinned twelve residual precision
fixes, folded here and in the spec as v2.3: F1 a numeric `0` memory limit is a zero limit, not
unlimited; F2 `hostCpuCount` rides only with `container`; F3 `effectiveCores` is the `cpuPct`
denominator (a quota wider than the host reads 100 %); F4 the v1 `cpuacct.usage` nanosecond to
microsecond conversion; F5 the named remote reader/writer (`useHostUsageRoute()`); F6
`memUsedBytes` only with `memLimitBytes`; F7 `lastFrameAt` = the client receipt stamp; F8 one
load-chip rule; F9 the stale BC/reference/contract/card sentences rewritten in the same commit;
F10 the card hook's explicit `enabled: !useIsDesktop()` gate; F11 cpuset detection
(`cpuset.cpus.effective`, `cpuAffinityCores`, affinity folded into `effectiveCores`, and
`cpuPct` computed from the process's own `cpu.stat`/`cpuacct.usage` whenever a quota or an
affinity set exists); F12 the adaptive pressure pin (raw `memory.current`/`memory.max`,
`memory.events`, PSI - never the cache-excluded display value).

## Agreed direction (option A — effective capacity first)

**v2 turns host telemetry into effective-capacity telemetry and adds the desktop glance on top.
Adaptive admission stays out of scope; its architecture and hard-ceiling invariant are pinned
here so the future spec cannot drift.**

1. **Cgroup probe resolves the process's cgroup and walks ancestors.** v2: parse
   `/proc/self/cgroup` (`0::<path>`) and the cgroup2 mount from `/proc/self/mountinfo`; walk from
   the process cgroup up to the mount root, taking the **minimum finite** `cpu.max` /
   `memory.max`. Only the literal `max` is unlimited; a numeric `memory.max=0` is a degenerate
   **zero limit**, not unlimited. v1 fallback: per-controller mounts from mountinfo
   (`cpu,cpuacct`, `memory`, `cpuset`), `cpu.cfs_quota_us`/`cfs_period_us` with **quota ≤ 0 /
   `-1` = unlimited**, `memory.limit_in_bytes` with the `-1` write sentinel or the huge read
   sentinel = unlimited (a numeric `0` is a zero limit as above). Usage is read from the
   process's own cgroup (`memory.current` / `memory.usage_in_bytes`, `cpu.stat usage_usec` /
   `cpuacct.usage`, the latter in **nanoseconds**, divided by 1000 to µs). Also read the cpuset
   controller's `cpuset.cpus.effective` (v2, fallback `cpuset.cpus`) and `cpuset.effective_cpus`
   (v1, fallback `cpuset.cpus`): a CPU-list count below the host count is a finite CPU limit even
   when `cpu.max=max`, which is the `docker --cpuset-cpus` case.
2. **`container` is emitted only for a finite LIMIT.** Usage-only (e.g. a normal systemd-scope
   process on a host: root `cpu.max=max`, `memory.max=max`, `memory.current` readable) produces
   **no** `container` object and the exact v1 host payload — no fake "limits detected". The
   payload gains an optional additive `container` (`source`, `cpuQuotaCores?`,
   `cpuAffinityCores?`, `memLimitBytes?`, `memUsedBytes?` - only with `memLimitBytes` - and
   `cpuPct?`) plus `hostCpuCount` (`os.cpus().length`, omitted when 0) emitted **only together
   with `container`**; host fields stay untouched, so the host-mode payload is byte-identical.
3. **One effective composition, no scope mixing.** With any finite CPU limit (quota or cpuset),
   `effectiveCpuPct` comes only from the container's `cpu.stat` delta, clamped to 0–100, with
   `effectiveCores = min(cpuCount, hostCpuCount ?? Infinity, cpuQuotaCores ?? Infinity,
   cpuAffinityCores ?? Infinity)` as the denominator (a quota wider than the host reads 100 %, not
   a fraction of the quota); a missing delta shows `—`, never the host-wide %. With a memory
   limit, the used value comes only from the container (cache-excluded via
   `inactive_file`/`total_inactive_file`, and emitted only alongside `memLimitBytes`; if
   unreadable, `—`, never host-used against a container total). Without a limit, the host pair is
   used. `hostCpuCount` powers the labelled host-context line; `cpuCount` keeps its v1 contract
   meaning (documented as effective-or-affinity depending on Node/libuv).
4. **One root subscription + the v1 card fallback.** A per-app store (context/provider like
   `UsageContext`, `createHostUsageStore`, read via `useSyncExternalStore`, test `reset`) holds
   the latest sample and a timestamped 60 s ring (deduped by `sampledAt`, cleared on a writer
   change/gap, plus a `lastFrameAt` client receipt stamp per sample). `useHostSubscription()`
   (local && `useIsDesktop()`) writes it; the **card keeps its v1 view-scoped subscription with
   `enabled: !useIsDesktop()` as the `<md` fallback** (it is the only local transport there, and
   the gate makes the one-writer rule structural, not incidental); remote keeps the v1 query pair
   as `useHostUsageRoute()` and folds its results into the same store. Exactly one writer is
   active by construction; the bus ref-counts listeners, so an overlap is harmless on the wire.
5. **Sidebar widget (desktop ≥ md).** An `AppShellProps` slot wired by `AppShellContainer`
   (AppShell stays QueryClient-free) renders a row with effective CPU % + sparkline + compact
   RAM, links to Settings → Resources, and is **conditionally unmounted** (not CSS-hidden) below
   `md` and in remote. Stale/age uses a re-armed timeout at `lastFrameAt + 10 s` (no interval),
   where `lastFrameAt` is the client receipt stamp stored with the latest sample (never the server
   `sampledAt`), cleared on unmount. No running/queued counts.
6. **Adaptive admission — deferred, architecture and hard ceiling pinned once**:

   ```
   machine telemetry (host + cgroup) → cgroup probe → effective capacity
     → pressure state (hysteresis) → adaptive ceiling
     → effective = min(adaptive ceiling, DISPATCH_MAX_IN_FLIGHT (4), intent.inFlight,
                       maxParallel, projectMaxParallel, dispatchMaxConcurrent)
   ```

   The fixed cap is a **hard ceiling**: adaptive can only lower slots, never exceed or remove it;
   stale/missing signal ⇒ no reduction (fail-open to the fixed cap); `dispatchMaxConcurrent`
   comes from #1034 (OPEN) and is verified after its merge. No preemption (defined: a running
   child is never stopped by the governor; only new admissions are gated).

   Pressure input is pinned as well (F12): the adaptive spec reads raw `memory.current` /
   `memory.max`, `memory.events` (`oom`, `oom_kill`, `high`) and PSI (`memory.pressure`,
   `cpu.pressure`), keeps `memory.high` (throttle) distinct from `memory.max` (hard limit), and
   never uses the cache-excluded display value as a control signal.

**Rejected, with why** (all review units, including the final verification):

- Root-cgroup reads / usage-only container detection: live counterexample on the dev host (root
  `max`, own scope has usage) — would flip the card to "limits detected" with no limit.
- `??` fallbacks that mix scopes/scales: host-wide CPU % beside effective cores; >100 % cpuPct
  when the quota is unlimited (fails the 0–100 schema and blanks the frame).
- v1 `quota/period` without the `-1`/0 guard: negative effective cores.
- Removing the card's view-scoped subscription: it is the only local transport below `md`.
- Quota-and-memory probing only, without cpuset: a `--cpuset-cpus` sandbox reads `cpu.max=max`
  and would be reported as full host capacity (F11).
- Emitting `hostCpuCount` on every payload: breaks the byte-identical v1 claim for host-mode
  users; the field is only needed when `container` is present (F2).
- Treating a numeric `0` memory limit as unlimited: only the literal `max` (v2), the v1 `-1`
  write sentinel and the huge v1 read sentinel are unlimited (F1).
- "One subscription site because two would duplicate frames": false; the real reasons are one
  owner and one ring writer.
- Module-level singleton store: no change notification/test isolation.
- Counts in the widget; CSS-hidden remote widget; modifying #1036.

## Resolved unknowns

| Question | Answer |
|----------|--------|
| Where is the container limit read from? | The process's own cgroup (`/proc/self/cgroup` + mountinfo), min over ancestors; the CPU limit is a finite quota **or** a cpuset count below the host count; v1 fallback with quota ≤ 0 = unlimited, memory `-1`/huge sentinel = unlimited, numeric `0` = degenerate zero limit. |
| When is `container` emitted? | Only when a finite CPU quota, a cpuset set below the host count, or a memory limit exists; usage-only ⇒ no object and no `hostCpuCount`, v1 host payload byte-identical. |
| Effective CPU % | Container `cpu.stat` delta with any finite CPU limit (quota or cpuset); denominator `effectiveCores`; clamped 0–100; otherwise `—` (never host-wide %). |
| Effective memory | Container pair only when a memory limit exists; `memUsedBytes` only with `memLimitBytes`, cache-excluded when `memory.stat` allows, else `—`; host pair only without a limit. |
| Host context | New optional `hostCpuCount`, emitted only together with `container`; `cpuCount` keeps v1 semantics (documented, Node-version dependent). |
| Store/subscriptions | Per-app context store via `useSyncExternalStore`; root writer (local && desktop), card fallback (`<md` local, `enabled: !useIsDesktop()`), remote folds through `useHostUsageRoute()`; one active writer, and `lastFrameAt` is the client receipt stamp. |
| Stale/age | Re-armed timeout at `lastFrameAt + 10 s` (client receipt stamp) while mounted; test at >15 s. |
| Widget | Desktop-only `AppShellProps` slot, conditionally unmounted below `md`/remote; CPU + sparkline + RAM; no counts. |
| Contract/docs | Additive `container` + gated `hostCpuCount`, documented on the **existing §2 host-usage bullet** (#1036), not §3; the four stale limits-not-subtracted sentences are rewritten in the same commit (F9); parity in `contract-parity.workspace.test.ts`. |
| Landing order | #1034 → #1036 → this; collisions: `resources-section.tsx`, `docs/reference.md`, `BACKWARD_COMPATIBILITY.md`; Phase 2 may ship as its own PR. |
| Adaptive | Chain + hard-ceiling invariant above; static cap never removed; fail-open on stale. |

## Non-goals

- Adaptive admission in this PR (thresholds/hysteresis/pressure state belong to its spec).
- cgroups on macOS/Windows, K8s resource annotations beyond cgroup files, disk/network/per-core.
- Mobile/remote widget parity; counts in the widget; host-load-driven behavior in this PR.
- Per-task CPU affinity UI beyond the cpuset read (`taskset`-style masks are already folded into
  `availableParallelism()`, so they need no payload field).

## Affected areas (if known)

- `packages/cezar/src/core/host-usage.ts` - cgroup probe (`cpu.max`, `memory.max`, `cpuset.*`),
  injection seam (`readCgroupFile`), container sample incl. `cpuAffinityCores`.
- `packages/contract/src/host.ts` - optional `container` (+ `cpuAffinityCores`) and gated
  `hostCpuCount`, contract comments (incl. the stale limits-not-subtracted line).
- `packages/web/src/api/host-usage.ts` + `global-events.tsx` - per-app store/context, root
  subscription, `useHostUsageRoute()` remote writer, `lastFrameAt`.
- app shell/container + footer - desktop-only widget slot (conditional unmount).
- `resources-section.tsx` + Machine card - effective/host labels, cgroup/cpuset wording,
  load-chip rule.
- `docs/reference.md` (session/topic + container wording), `BACKWARD_COMPATIBILITY.md` §2 (stale
  sentence rewrite).

## Watch-outs

- The probe must never emit `container` from usage alone; the dev host is the regression fixture.
- Unlimited: `cpu.max=max`, v1 CPU quota ≤ 0 / `-1`, the v1 memory `-1` write sentinel and the
  huge read sentinel. A numeric `0` is a degenerate zero limit (no `memLimitBytes`), never
  unlimited, and no emitted capacity may be zero or negative.
- Cpuset-only pinning (`docker --cpuset-cpus`) must be detected even when `cpu.max=max`:
  `cpuAffinityCores` below the host count is a finite CPU limit, and cpuPct is relative to those
  cores (host 30-34 % while the pinned cores are at 100 % is the F11 regression fixture). A
  `taskset`-style per-process mask is covered by `availableParallelism()` (`cpuCount`), not by the
  cpuset files; a sparse or wider list (`0-2,4-6,8,18` on an 8-CPU host) is not a limit.
- Ancestor walk: a limit on the parent cgroup applies; take the minimum finite limit.
- `cpu.stat` (µs) / `cpuacct.usage` (ns, ÷1000) deltas: no quota or cpuset ⇒ no
  `container.cpuPct`; denominator `effectiveCores`; zero/negative wall ⇒ omit.
- Memory usage: cache-excluded when possible, otherwise `—`; only ever emitted with
  `memLimitBytes`; never host-used vs container-total.
- Load/swap stay host-level and are labelled host; the load chip pairs with `cpuCount` without a
  container (v1) and with `hostCpuCount` when one is present.
- Store: one instance per app context; `lastFrameAt` is the client receipt stamp; remote snapshots
  fold in through `useHostUsageRoute()`; the card hook is gated `enabled: !useIsDesktop()`.
- Footer: conditional unmount (not `hidden md:flex`); #702 test becomes three desktop rows; e2e
  at 390×844 and 1440×900 plus a 264 px sidebar check.
- Rewrite the now-stale "container/cgroup limits are not subtracted" / "the card says so"
  sentences in `BACKWARD_COMPATIBILITY.md:38`, `packages/contract/src/host.ts:18-19`,
  `docs/reference.md:516-519` and `machine-card.tsx:196-201` in the same commit (F9).
- Adaptive pressure (F12 pin): never use the cache-excluded display value as the control signal;
  read raw `memory.current`/`memory.max`, `memory.events` and PSI, and keep `memory.high`
  (throttle) vs `memory.max` (hard limit) distinct.
- Demo/conformance asset: fixture matrix + live Docker script (`--cpus`, `--cpuset-cpus`,
  `--cgroupns=host`, host) and two screenshots (host totals vs sandbox effective).
- Dev-host live note: `cpuset.cpus.effective` reads `0-2,4-6,8,18` while `os.cpus().length` is 8
  and `availableParallelism()` is 8, so a wider cpuset must not inflate capacity; `taskset -c 0`
  leaves the cpuset files untouched and only moves `availableParallelism()`.
- Harness: Node 26 needs `NODE_OPTIONS=--localstorage-file=<tmp>`; cgroup unit tests need the new
  read seam and fixtures (root no-limit, ancestor limit, Docker combined v1 mount, `-1`, `max`,
  numeric `0`, cpuset-only, sparse cpuset, quota > host cores).
