# César enxuto: upstream v0.15.1 + Antigravity

Base: `open-mercato/cezar` tag `v0.15.1`, commit
`ae60471e94331310b72524540a4d35fb9834e7fc`.
Historical source inspected: `personal/backup/personalized-cezar`, commit
`52a0bfc3ce0709f855cd72d44ce8a5a0da7921dc`.

## Scope

The new branch starts from the official tag. No complete source file is taken
from the historical branch. Only reviewed Antigravity registration hunks are
ported. The runner, mapper, model catalog, mock and fixtures are reconstructed
against the native AgentRunner interface and Google headless documentation.

Upstream owns continuation with runner switching/context reconstruction,
per-task handoff, prompt planning, project instructions/templates, issue/PR
automations, built-in workflows and all graph node types. The personalized
supervisor, routing policies, work profiles, custom workflows, launchers,
capacity checks and design intelligence are not carried into this tree.
Existing external project state is not rewritten by this code migration.

## Adapter contract

Backend id: `antigravity`; executable: `agy`, overridden by `CEZ_AGY_BIN`.
Opt-in: `CEZ_ANTIGRAVITY=1`. Credentials belong to the official CLI. Child
processes use the upstream environment filter; D-Bus session access is forwarded
for the CLI keyring without forwarding unrelated Google/Gemini API keys.

A headless process handles one turn. The conversation id is persisted through
the native session event and resumed with `--conversation`. Cross-runner context
uses upstream continuation machinery. Real turns are serialized per César
process, not across independent server instances. Cancellation and timeout
signal the process group and captured descendants, with SIGKILL escalation.
A nonzero exit, ERROR result, missing terminal result, timeout or sign-in prompt
fails the run. Deliberate cancellation resolves normally.

The mapper emits v1 and v2 from the same fold. Text deltas on DONE are appended;
result.response only supplies text when no streamed response exists. Tool calls
carry normalized names and TitleCase parameters; tool ERROR states and abandoned
tools complete as failed. Unknown frames are ignored. Usage remains raw.
Plans, reasoning text and file content are absent from the documented/observed
wire contract, so parity excludes these three cells explicitly. Subagent
fixtures are document-derived. Images and launch-time private MCP injection are
rejected explicitly, rather than silently discarded. Google documents a newer
persistent stdin protocol; adopting it is outside this minimal reconstruction.

Sources checked 2026-10-14:
- https://antigravity.google/docs/cli/headless/
- historical agy 1.3.3 behavior recorded in the backup branch

## Maintenance

Keep this branch's delta restricted to the adapter, tests, documentation and
registration at existing seams. Update by rebasing onto a verified official
release, then run all validation commands from AGENTS.md. Never replace a native
file with its historical personalized counterpart. Review against the tag with
`git diff v0.15.1 --stat` and confirm the upstream subsystems are unchanged:

```sh
git diff v0.15.1 -- packages/cezar/src/server/forge/github.ts \
  packages/cezar/src/automations/store.ts packages/cezar/src/workflows
```

The old backup branch and deployed services are preserved. Switching the default
branch or deploying is separate from preparing this clean reconstruction.

## Validation evidence (2026-10-14)

Node 24 in an isolated toolchain; final checks run as the unprivileged `cezarops`
user. No real Google conversation was started.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed for contract, API client, server and web |
| Final targeted Vitest gate (adapter, parity, auth/APIs, Settings and composer) | 32 files / 663 tests passed |
| `npm run test:unit` | 42 passed |
| `npm run build` | Passed, including inline contract and tarball gate (797 files) |
| `npm run test:package` | 17 passed, including install and CLI execution |
| Built CLI `quick-task` with `defaultRunner: antigravity`, `CEZ_DRY_RUN=1` | Exit 0; task done; persisted conversation id and 15 tokens |
| Malformed event discriminator / prototype-shaped tool name regressions | Both failed before the mapper fix and passed in the final gate |

The whole Vitest suite was also executed: 9,660 passed, 4 skipped, 6 failed.
One adapter assertion was captured before the final mapper changes; the final
32-file gate above re-ran it successfully. The remaining FIVE failures were
reproduced independently on the untouched official `v0.15.1` tag, with the same
lockfile/dependencies, Node version and user:

- `create-project-dialog.test.tsx`: immediate navigation assertion after creation
- `diff.test.tsx`: cold lazy diff header rendering
- `diff-virtualize.test.tsx`: cold lazy file rendering
- `task-changes.test.tsx`: cold diff rendering without Markdown
- `task-commits.test.tsx`: cold commit diff rendering

These native UI files and tests remain unchanged. This is not a claim of a green
whole-repository suite; the five inherited failures remain outside the adapter
scope. The forge adapter, automation store and workflow directory have zero diff
against the official tag, including GraphQL pagination and the 15-second lock
with a 1-second heartbeat. Live Google authentication/model execution remains
unverified; fixtures and process simulations validate the transport contract.
