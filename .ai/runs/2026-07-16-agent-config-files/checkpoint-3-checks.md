# Checkpoint 3 — code-review fixes

Covers review-fix Steps 5.2-review-fix, 5.3-review-fix (`31c6f09`, `3ed1ffb`), from an adversarial staff code review of `origin/main..HEAD`.

## Findings applied

| Sev | Finding | Fix |
|-----|---------|-----|
| HIGH | `GET /api/agent-config/:id` had no hosted gate — a networked client could read `~/.claude/settings.json`, `~/.codex/config.toml` raw (secrets). | Outside-repo reads now 409 in hosted mode, matching the write gate + withheld userMcp. Repo files stay readable. Regression test added. |
| MEDIUM | Emptying a populated file passed validation → silent wipe (unrecoverable for ungit-tracked ~/ files). | `writeConfigFile` refuses empty-over-non-empty for every format; creating a fresh empty file still works. Test added. |
| LOW | `stripJsonComments` dropped the opening `/*`, shifting error offsets. | Blanked in place; byte-length-preserving test added. |
| LOW | Atomic-write tmp name keyed only on pid → two concurrent same-file saves could tear bytes. | Added `randomUUID()` to the tmp name. |

Findings the reviewer explicitly cleared (no action): seed check-ignore correctness, version/stale logic, symlink write-through, editor XSS (React text nodes, no innerHTML), FileEditor draft/version state.

## Checks

| Check | Result |
|-------|--------|
| `npm run typecheck` | ✅ pass |
| `npm test` (vitest) | ✅ 122 files, 1979 tests |
| `npm run test:unit` | ✅ 4 pass |

Fixes touched only `src/agent-config/{files,validate}.ts` and `src/server/server.ts` (+tests); the full fast gate was re-run since code outside a single module changed.
