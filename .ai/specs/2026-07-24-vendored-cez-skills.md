# Bundled harness skills

Status: implemented. This specification covers the skill collection shipped with
the [multi-model harness](2026-07-23-harness-orchestration.md), its provenance,
discovery and materialization. The orchestration spec owns execution and trust rules.

## Collection and ownership

The published CLI includes `packages/cezar/vendor/skills/`. It works without a
network fetch or a separately installed skill collection. Missing optional sources
must not prevent cezar from booting.

`MANIFEST.json` records the pinned `open-mercato/skills` source commit and generated
skill provenance. The source branch is `main`; updating the pin is a deliberate
repository change, not a runtime download.

| Ownership | Skills |
| --- | --- |
| Cezar source, edited here | `cez-harness`, `cez-setup-harness`, `cez-pre-implement-spec`, `cez-implement-spec` |
| Generated from the pinned source | `cez-spec-writing`, `cez-code-review`, `cez-verify-in-repo`, `cez-root-cause`, `cez-fix` |

`scripts/vendor-skills.mjs` regenerates only the generated collection, applies the
reviewed generic transformations and records hashes. Never hand-edit generated
skills. The runtime, adapter/schema references and setup templates are Cezar-owned
dependencies of the shipped playbooks. The conductor owns sandbox enforcement;
standalone hooks, worker-command adapters and packet settings are not shipped.

The generic skill profile is the default. An explicit `open-mercato` profile maps
the same fixed phase graph to canonical `om-*` skills. The graph and safety boundary
do not change with the judgment playbooks; missing required skills fail preflight
with their names rather than silently switching profiles.

## Discovery and dependency closure

The catalog preserves local-first precedence:

1. Repository skill directories and agent mirrors.
2. Global installed skills.
3. Cached team collections.
4. The bundled collection, merged last.

An existing skill with the same name shadows the bundled entry. Bundled skills are
listed only when the project's `multiModel` flag is enabled; internal recovery can
explicitly resolve the collection for an existing harness run. No network work is
added to ordinary discovery.

Directory skills may declare optional `requires: string[]` frontmatter. Discovery
preserves it in the shared skill contract, and materialization walks that dependency
closure with deduplication and cycle protection. A missing or unsafe dependency
returns failure for the caller to report; resolvable companions are still copied.

`skills-materialize.ts` copies directory contents and required companions into the
run worktree's `.claude/skills/<name>/`, preserving relative references. It runs for
harness phases and bundled skills; ordinary single-file skills keep their existing
system-prompt path. Materialization reports errors through run evidence rather than
crashing the server.

## Trust and provenance

The ordinary catalog's local-first resolution is a discovery policy, not proof that
worktree files are safe to execute. Harness preflight selects and snapshots trusted
skill bytes outside the writable worktree, records whole-tree hashes in the ledger
and renders phase prompts from that pinned copy. The driver seals the runtime and
companion files from its trusted source, never from a model-modified materialization.
Resume verifies the same hashes before reusing the run.

The status API exposes whether the runtime is installed, its source and the pinned
commit when available. Bundled provenance comes from `MANIFEST.json`; local/team
overrides identify themselves. The cockpit must not label an override as bundled
or claim an unknown commit.

## Verification and compatibility

`vendor-skills.test.ts` checks the manifest, generated files and runtime contract.
`skills.test.ts` covers precedence and feature-off discovery;
`skills-materialize.test.ts` covers closure and filesystem safety. Runtime sealing
and skill-binding tests verify that changing a worktree copy cannot change a
phase's trusted instructions. The build and installed-tarball gate must retain the
whole vendor tree and its relative paths.

The public additions are the optional `requires` field and `bundled` skill source.
Existing skills without dependencies keep the same body and precedence. No required
user configuration, global installation or startup network operation is introduced.
