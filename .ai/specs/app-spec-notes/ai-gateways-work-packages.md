# AI Gateways — deduplicated work boundaries

Planning estimate from reference branch `544d0c76`. The independent PR starts at main `4040b404` with documentation only; reference-only gateway foundations must also be implemented here if still absent. Re-estimate before implementation; do not treat the earlier PR as a merge prerequisite.

| Package | Atomic change boundaries | Stories | Estimate |
|---|---|---|---|
| G1 | Generic protocol/auth contract and compatibility adapter; update/enable store+API; shared cross-process writes and pending-key recovery; seed/provisioning identity and revision-aware config isolation | US1, US2, US5, US6 | 4–6 commits |
| G2 | Dedicated global settings page and editor; agent-independent enabled/unavailable/seed UX and UI coverage | US1, US2 | 1–2 commits |
| G3 | Per-runner defaults contract/resolver; native/gateway binding persistence; composer + lifecycle/dispatch/naming/handoff/headless integration and guards | US3, US4, US5 | 3–5 commits |
| G4 | Batch apply contract/service; file and stdin inputs; partial results/retry; provisioning docs and isolated-home smoke. Separate update/enable/default operations under `ai-gateways` | US6 | 3–4 commits |

WF1 uses G1/G2; WF2 uses G3; WF3 shares G1/G3; WF4 uses G1/G4. Shared commits are counted once: 11–17 total after the provisioning amendment. No promised per-workflow additive totals. A release must preserve the working default path while covering all four workflows; atomic development commits are not independently advertised incomplete user features.

G1 and G3 exceed a one-change estimate because current provider kind, task/session affinity, contracts and multiple launch paths carry real behavior. Reuse current stores/adapters rather than introducing a routing framework. No cloud deployment manifests, required config file or third-party dependency are included.

## Provisioning amendment dependencies

The [specification §4.6 and §7.1](../2026-10-28-app-spec-ai-gateways.md) owns the contract and ordered steps: A1 writer coordination → A2 identity/recovery → B1 preflight/batch service → B2 file/stdin CLI → C1 integration/docs → C2 release gate. G4 cannot independently invent persistence semantics or bypass G1's pending-state guard. Update all construction/mutation/read sites, including seed, UI/individual CLI, managed-secret writes, launch and catalog snapshots; changing only apply would leave half a guarantee.

Batch scope is gateway configuration only. The owner chose to retain completed entries, stop on the first persistence failure and safely retry the same input; full-batch rollback, pruning, startup import and assigning agent defaults from apply are excluded. These estimates are design ranges, not measured implementation effort.

Public CLI naming: `ai-gateways` only, without a `llm-providers` compatibility alias. The reference CLI is design evidence, not a shipped surface; do not implement legacy-input adapters or provider-kind migrations. Internal source names may remain where useful. Include canonical help/examples/generated handoffs and old-name rejection in the CLI checks.
