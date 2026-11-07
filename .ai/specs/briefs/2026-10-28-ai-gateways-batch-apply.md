# Batch AI gateway provisioning for sandboxes

- Date: 2026-10-28
- Category: feature
- Priority signal: medium — requested convenience for repeatable sandbox setup; no deadline supplied.
- Risk signal: medium — stable record identity and coordinated metadata/secret updates must survive retries.
- Routing: Next: om-spec-writing "Uzupełnij istniejącą .ai/specs/2026-10-28-app-spec-ai-gateways.md z PR #1730 o apply z JSON-em z pliku lub stdin do konfiguracji gatewayów w sandboxach (WF4/G4/US6), bez przypisywania domyślnych gatewayów agentom — brief: .ai/specs/briefs/2026-10-28-ai-gateways-batch-apply.md"

## Problem

Sandbox provisioning should configure several AI gateways with one explicit operation. The user's concrete example is changing the seeded OpenRouter base URL and adding another provider in the same invocation. Setup scripts should be able to generate the configuration directly, without creating an intermediate JSON file or keeping a separate ledger of generated gateway UUIDs.

[PR #1730](https://github.com/open-mercato/cezar/pull/1730) currently carries the [AI Gateways specification](../2026-10-28-app-spec-ai-gateways.md). Its WF4/G4/US6 provisioning path describes creating a connection, saving its returned ID, and subsequently updating it by ID. The PR was inspected at `e85e5b989b225b5a3e60b8430c8f3fe33160694a`: seven Markdown files, no runtime implementation. Recheck its current state before editing.

## Agreed direction

Extend the existing specification's provisioning workflow, contracts, work breakdown and acceptance criteria. Keep this within the AI Gateways feature; do not create a duplicate feature specification or start implementation from this brief.

Provide an explicit, server-independent batch apply operation using the same workspace and secret storage as cockpit configuration. Both a JSON file and stdin are required. Canonical public command spelling, confirmed by the owner:

```sh
cezar ai-gateways apply --file gateways.json
./generate-gateways-config | cezar ai-gateways apply --file -
```

Both sources use one input schema and identical validation and update semantics. Stdin requires no intermediate input file. Read and validate the complete document before beginning mutations; do not echo the document or credentials in output or validation errors.

Apply creates or updates the specified connections, including URL, protocol/auth settings, credentials and ON/OFF state. Preserve existing record IDs, unlisted connections and omitted fields/secrets. New records must satisfy the existing gateway requirements and defaults. Explicitly supplied fields may overwrite later UI edits on reapplication. Repeating the same input must converge on the same records without duplicates, including after a lost success response.

The existing OpenRouter seed must be addressable despite changes to its display name or URL. Define a stable provisioning identity and its relationship to the immutable gateway UUID; do not use mutable names or endpoints as identity keys. Preserve existing seed initialization and deletion guarantees.

Alternatives considered: automatic import at server startup, and building nothing new while a sandbox script sequences individual CRUD operations and stores returned IDs. The user chose explicit apply: it avoids startup reconciliation and moves repeatable multi-record setup out of each sandbox script.

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| When is configuration applied? | Explicit CLI invocation during sandbox provisioning, not automatic startup import. |
| What is the public CLI name? | `ai-gateways`; no `llm-providers` or singular compatibility aliases. The owner confirmed the feature is not implemented. |
| Is an input file mandatory? | No. Support both a JSON file and JSON through stdin. |
| What is the batch scope? | Gateway configuration only, including credentials and ON/OFF. No per-agent default assignment. |
| What concrete use case must work? | Update the seeded OpenRouter URL and add a second provider in one invocation. |
| What happens on repetition? | Update the same records without duplicates; retain unlisted connections and omitted values. |
| Where does this work belong? | Extend the existing AI Gateways specification from PR #1730, principally WF4/G4/US6. |
| Is the brief authorized? | After refining scope and explicitly adding stdin support, the user requested: “okej zapisz brief”. |
| What if a later gateway fails to persist? | During spec writing the owner chose: “Zachowaj postęp i pozwól ponowić”. Retain completed entries, stop on failure, return partial results and safely retry the complete document; no all-or-nothing batch requirement. |

## Design work for the specification

- Finalize the JSON schema, stable provisioning identity, seed adoption and explicit apply behavior after seed deletion. A repeated apply must not accidentally create another OpenRouter or restore it merely because Cezar restarted.
- Define absent, empty and null field behavior; preserve omitted secrets and never infer secret deletion from a blank value. Specify credential delivery for both input sources, reusing the existing vault and excluding raw secret argv literals and secret output.
- Distinguish full-input validation failure (no mutation) from storage failure or interruption during application. Specify nonzero exit status, sanitized actionable results and safe retry/recovery. One command does not imply an existing atomic transaction spanning multiple records and the separate metadata/secret stores.
- Account for simultaneous seed initialization, UI edits, other apply invocations and launch reads. Preserve coherent metadata/key pairs and unrelated records using the existing persistence discipline.
- Verify the planned CLI/store boundary before assuming no HTTP changes are necessary. Share validation and storage behavior; do not introduce a second configuration store.

## Non-goals

- Assigning default gateways to agents, selecting task models or launching tasks.
- Automatic configuration import or reconciliation on server startup.
- Removing gateways omitted from the input, pruning, or a new deletion interface.
- A required config file, a new secret vault, cloud deployment manifests, proxying or provider failover.
- Compatibility aliases, input adapters or legacy-provider migrations for the unshipped reference design.
- Live provider validation or billable requests during apply.
- Implementing code, publishing changes or editing PR #1730 during this brainstorm.

## Affected areas

- Existing specification: WF4, G4, US6, gateway/seed identity invariants and provisioning acceptance criteria; synchronize affected supporting planning notes.
- Planned CLI/store and contract: `llm-providers-cli.ts`, `llm-providers.ts`, workspace config/migrations and `packages/contract`. Gateway-specific files were reference-only on the inspected PR base; verify availability before implementation planning.
- Existing secret persistence and workspace home selection: preserve `CEZ_HOME` isolation and vault behavior.
- Verification to specify: isolated-home smoke for both input sources and equivalent results; OpenRouter update plus second-provider creation; repeat/lost-response recovery without duplicates; preservation of unlisted records and omitted secrets; invalid-input no-write case; interrupted/concurrent writes; no credentials in output.

## Review evidence and limits

A fresh-context challenger approved extending the existing specification, with no critical routing blockers. It identified identity/seed adoption, field ownership and retry semantics as design work; these remain explicit above. File and stdin support was added afterward at the user's request and uses the same proposed behavior.

Repository/spec inspection and read-only tracker searches informed this brief. No implementation, runtime tests or live provider calls were performed during the brainstorm. The brief was subsequently saved in the task branch by cockpit autosave; it accompanies the existing specification amendment, including the later owner-confirmed failure policy above.
