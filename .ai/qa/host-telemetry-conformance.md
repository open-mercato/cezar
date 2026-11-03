# Host telemetry conformance - fixture matrix and live Docker run

Spec: `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md` (Implementation Plan step 11).
Script: `.ai/scripts/host-telemetry-conformance.sh` (`sh .ai/scripts/host-telemetry-conformance.sh`).

The script runs the REAL probe (`packages/cezar/src/core/cgroup-probe.ts`) and the REAL sampler
(`packages/cezar/src/core/host-usage.ts`) - not a paraphrase - in four environments, printing both
the cgroup files the process can see and the `container` object the sampler would put on the wire.
It is read-only: every container mount is `:ro`, and nothing here writes into the repository.

## Matrix

| Case | Raw files the process sees | Expected wire object | Why it matters |
| --- | --- | --- | --- |
| **host** - no container | `cpu.max: max 100000`, `memory.max: max`, own scope `/user.slice/...`, `memory.current` readable | `container: null`, `hostCpuCount: null` | The dev-host counterexample: usage without a limit must NOT become "limits detected", and the payload must stay byte-identical to v1. |
| **cpus** - `docker --cpus=2 --memory=1g` | `cpu.max: 200000 100000`, `memory.max: 1073741824`, `/proc/self/cgroup: 0::/` | `container.cpuQuotaCores: 2`, `memLimitBytes: 1073741824`, `memUsedBytes` cache-excluded, `cpuPct` from the second tick | Quota + memory read from the process's own cgroup, not the namespace root. |
| **cpuset** - `docker --cpuset-cpus=<one core>` | `cpu.max: max 100000`, `memory.max: max`, `cpuset.cpus.effective: 4` | `container.cpuAffinityCores: 1`, no `cpuQuotaCores`, no `memLimitBytes` | The case a quota-and-memory-only probe calls "unlimited host": a one-core pin reads as ONE core, and its `cpuPct` is relative to that core. |
| **cgroupns** - `docker --cgroupns=host --cpus=2` | `cpu.max: max 100000` at `/sys/fs/cgroup`, `/proc/self/cgroup: 0::/system.slice/docker-<id>.scope` | `container.cpuQuotaCores: 2` | The limit lives on the process's own (ancestor) scope while the namespace root reads `max` - the F11 case a root-only read misses. |

## Observed run (2026-09-20, Node 26.8.1, Docker 29.8.0, 24 physical cores)

`host`:

```json
{ "facts": { "source": "cgroup-v2", "memUsedBytes": 1862463488, "cpuUsageUs": 10064462985 },
  "container": null, "hostCpuCount": null,
  "firstSampleHadCpu": false, "secondSampleHadCpu": true }
```

`cpus` (`--cpus=2 --memory=1g`):

```json
{ "facts": { "source": "cgroup-v2", "cpuQuotaCores": 2, "cpusetCores": 8,
             "memLimitBytes": 1073741824, "memUsedBytes": 128868352, "cpuUsageUs": 594066 },
  "container": { "source": "cgroup-v2", "cpuQuotaCores": 2, "cpuAffinityCores": 8,
                 "memLimitBytes": 1073741824, "memUsedBytes": 129138688, "cpuPct": 1 },
  "hostCpuCount": 24, "firstSampleHadCpu": false, "secondSampleHadCpu": true }
```

`cpuset` (`--cpuset-cpus=4`, one core):

```json
{ "facts": { "source": "cgroup-v2", "cpusetCores": 1, "memUsedBytes": 132587520, "cpuUsageUs": 700121 },
  "container": { "source": "cgroup-v2", "cpuAffinityCores": 1, "cpuPct": 2.6 },
  "hostCpuCount": 24, "firstSampleHadCpu": false, "secondSampleHadCpu": true }
```

`cgroupns` (`--cgroupns=host --cpus=2`):

```json
{ "facts": { "source": "cgroup-v2", "cpuQuotaCores": 2, "cpusetCores": 8,
             "memUsedBytes": 132378624, "cpuUsageUs": 560846 },
  "container": { "source": "cgroup-v2", "cpuQuotaCores": 2, "cpuAffinityCores": 8, "cpuPct": 1.2 },
  "hostCpuCount": 24, "firstSampleHadCpu": false, "secondSampleHadCpu": true }
```

Two readings worth naming, because they look surprising and are correct:

- The sandbox cases carry BOTH a quota and an affinity figure. The dev machine is itself
  cpuset-restricted (its `/proc` exposes 8 of 24 cores), and inside a container `os.cpus()` still
  reports the physical 24 - so the ambient 8-core set is a real, finite limit below the host
  count. Effective capacity is the tighter of the two (`min(24, 8, quota)`), which is the rule the
  card and the widget apply.
- `firstSampleHadCpu: false` then `true` on the second sample: a CPU percentage is a delta, so the
  first tick after a gap legitimately has none - the same rule the host figure already followed.

## Reproducing

```sh
sh .ai/scripts/host-telemetry-conformance.sh      # four cases, ~10 s warm, ~2 min on a cold image pull
```

Override the image with `CEZ_CONFORMANCE_IMAGE=<image>` (default `node:22-bookworm-slim`). The script
picks a CPU the local Docker daemon actually accepts for the cpuset case, and skips that case
explicitly (never silently) when the daemon accepts none of this shell's cores.

Unit-level twins of these fixtures (the same shapes, no Docker) live in
`packages/cezar/src/core/cgroup-probe.test.ts` and `packages/cezar/src/core/host-usage-container.test.ts`;
this file is the live counterpart that proves the parsing rules against a real kernel, not a
hand-written map.
