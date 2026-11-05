# Execution plan — keep a task's TMPDIR short enough for Unix sockets (#1936)

## Goal

A task's `TMPDIR` must leave room for the Unix-domain sockets tools create in it.
`tsx` puts its IPC socket at `$TMPDIR/tsx-<uid>/<pid>.pipe`. `sun_path` is 104 bytes on
macOS and 108 on Linux, so today's `<cezarHome>/tmp/agent/<16-hex>/<36-char uuid>`
overflows on ordinary home paths, and tools fail with `listen EINVAL`.

## Scope

- `packages/cezar/src/runs/agent-tmpdir.ts`:
  - Shorten the per-run leaf to the first 16 characters of the run id. For a uuid that is
    the id8 plus about 52 random bits, which stays distinct across concurrent tasks.
  - Check each candidate root against a per-platform socket budget: `<cezarHome>/tmp/agent`,
    then the platform-temp fallback, then a short POSIX root `/tmp/cez-<uid>`. Use the
    first that fits. A shared root is vetted with `securePrivateDir`.
  - Sweep and reap every candidate root under the project's hashed namespace. Keep the
    leaves and the full ids of live runs, so scratch in the #1825 layout is handled safely.
- Tests: a real `net` socket bound at a tsx-shaped path under a long `CEZ_HOME` with a full
  UUID (it fails on the current implementation), plus distinct leaves for concurrent runs
  and sweep/reap across roots and layouts.
- Docs: `docs/reference.md`, `.env.example`, `docs/site` operations page and
  `BACKWARD_COMPATIBILITY.md` for the scratch location.

## Non-goals

- Scheduler capacity, automation schedules, run-history migration, any new config knob.
- The `CEZ_AGENT_TMPDIR=0` opt-out stays byte-for-byte unchanged.

## Risks

- A shortened leaf could collide. It is a prefix of a random uuid, so the chance is negligible.
- `/tmp/cez-<uid>` sits in a world-writable directory. It gets the same owner/symlink vetting
  as the existing platform fallback.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Socket-safe scratch path

- [x] 1.1 Budgeted root selection and short run leaf — 09569fdc5
- [x] 1.2 Sweep and reap across roots and layouts — 09569fdc5
- [x] 1.3 Regression tests (real socket bind, concurrency, cleanup) — 09569fdc5

### Phase 2: Docs

- [x] 2.1 Update the documented scratch-location contract — 70fe57c8d
