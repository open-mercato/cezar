# AI Gateways — capability catalog

Source: reference implementation `544d0c76` and AGENTS.md; `.ai/agentic.config.json` selects `.ai/specs`, with no `knowledge.sources` or `platform.repo`. Entries were inspected in reference-branch source, not verified against running vendor CLIs. The new PR base is main at `4040b404`; gateway-specific entries are reference-only until implemented on this branch. The new PR does not require PR #1726 to merge. No external license-tier catalog applies.

| Kind | Capability | Reuse / gap | Source file |
|---|---|---|---|
| Contract | Zod gateway/runner compatibility | Generalize protocols/auth; add optional provisioning identity/pending state and strict apply manifest/results | `packages/contract/src/llm-providers.ts` |
| Service | LlmProviders | List/add/remove/resolve/models; add edit/enable/defaults, shared batch preflight and coherent write/recovery | `packages/cezar/src/workspace/llm-providers.ts` |
| Persistence | Optional workspace config and atomic merge writer | Reuse salvage/home isolation; existing per-process queue needs cross-process writer coordination | `packages/cezar/src/workspace/config.ts` |
| Seed/init | Numbered workspace migrations | Atomic seed identity/completion; share gateway coordinator with apply; no standalone seed command | `packages/cezar/src/workspace/migrations.ts` |
| Secrets | Encrypted SecretStore + OS keychain/file data-key fallback | Reuse workspace scope, cezar audience, write-only API | `packages/cezar/src/workspace/secrets.ts`, `secret-keyring.ts` in same directory |
| Routing | routeLlmProvider | Existing per-agent env/native files; special OpenRouter behavior must be data | `packages/cezar/src/core/llm-provider-routing.ts` |
| Process boundary | createRunner, buildChildEnv | Reuse launch translation and curated env | `packages/cezar/src/core/runner-factory.ts`, `agent-env.ts` in same directory |
| Lifecycle | RunManager / run store | Existing provider UUID affinity; defaults/revisions/native pinning need extension | `packages/cezar/src/workflows/run.ts`, `packages/cezar/src/runs/store.ts` |
| Access/API | Chained Hono families, host/origin guard, Zod middleware | Reuse; no new login/RBAC | `packages/cezar/src/server/server.ts`, `validators.ts` in same directory |
| Surface | Global settings shell / provider form | Reuse components; move provider form to dedicated page | `packages/web/src/routes/settings/settings-shell.tsx`, `llm-provider-settings.tsx` in same directory |
| UI components | Input, Label, Select, Button, Switch | Existing house components, no new UI library | `packages/web/src/components/ui/` |
| Composition | New Task and Continue connection/model pickers | Extend inherited/native/explicit semantics | `packages/web/src/routes/new-task.tsx`, `packages/web/src/routes/task-thread/follow-up-engine.tsx` |
| CLI | Reference list/add/remove/models/exec operations | Implement public `ai-gateways` only, with file/stdin batch apply and results/retry; separate update/default assignment; no old-name alias | `packages/cezar/src/workspace/llm-providers-cli.ts` |
| Events/cache | Existing run events and TanStack Query invalidation | Reuse; no new global polling/notification mechanism | `packages/web/src/api/llm-providers.ts`, `packages/cezar/src/runs/store.ts` |
| Restriction | Gateway tasks cannot defer start | Preserve after inheritance resolves | `packages/cezar/src/automations/deferred-start.ts` |

Baseline behavior: `.ai/specs/2026-10-27-llm-provider-connections.md`, `docs/reference.md` LLM provider connections section. These are supporting docs, not evidence of live external compatibility.

## Availability on the isolated base

- `packages/contract/src/llm-providers.ts`: reference-only; absent on starting main.
- `packages/cezar/src/workspace/llm-providers.ts`: reference-only; absent on starting main.
- `packages/cezar/src/core/llm-provider-routing.ts`: reference-only; absent on starting main.
- `packages/cezar/src/workspace/llm-providers-cli.ts`: reference-only; absent on starting main.
- `packages/web/src/routes/settings/llm-provider-settings.tsx`: reference-only; absent on starting main.
- `packages/cezar/src/workspace/secrets.ts`: present on base; planned gateway changes still need verification.
- `packages/cezar/src/workspace/config.ts`: present on base; planned gateway changes still need verification.
- `packages/cezar/src/core/runner-factory.ts`: present on base; planned gateway changes still need verification.

## Provisioning amendment evidence (2026-10-28)

Read local `config.ts` (`serializedByPath`, `mergeWriteWorkspaceConfig`), `secrets.ts` (`set`, `update`, `locked`) and migrations. Workspace writes serialize within a process and atomically replace one file; SecretStore separately uses a cross-process lock. Neither supplies a transaction over both stores. The amendment chooses a durable pending marker plus coordinated snapshots, preserving the existing vault format. Cross-process workspace coordination is required for unrelated writers too.

Reference `544d0c76` source confirms protocol spellings, the 100-provider cap, UUID-derived secret slot names and standalone CLI/stdin handling. These remain reference evidence, not features shipped on this checkout. [kubectl apply](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/) and [Terraform apply errors](https://developer.hashicorp.com/terraform/tutorials/cli/apply) informed explicit stdin and partial-progress/retry conventions only. No live gateway calls or runtime tests were performed for this catalog update.

Naming decision: the owner confirmed the feature has no implementation to preserve. `llm-providers` file paths and earlier source names above identify reference material only; the planned public CLI is `ai-gateways`, with no compatibility alias, old-input serializer or legacy-provider migration.
