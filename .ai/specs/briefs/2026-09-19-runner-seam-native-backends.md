# Handoff brief (DRAFT) — one spec for the runner-seam issues #581 #582 #583 #584

Status: draft produced by the 2026-09-19 analysis (see `README.md`). Not reviewed by a human yet.
Purpose: the `— brief: <path>` input for `om-auto-write-spec 581` / `om-spec-writing`, so the
Open Questions gate is pre-answered where the analysis already settled the answer, and left open
where a human or the research step must decide. Edit the "Resolved unknowns" table before use;
every row marked `human` is a placeholder, not a decision.

## Goal

Land one design document covering the coding-agent runner seam extensions requested in #581
(Gemini CLI runner), #582 (Copilot CLI runner over ACP), #583 (Azure-hosted models on the native
codex runner) and #584 (Grok models on a native agent CLI), phased so each phase ships on its own
implementation PR via `om-auto-implement-spec`.

## Context the spec must start from (verified 2026-09-19)

- Runners today: `claude`, `codex`, `opencode`, `pi` (`packages/cezar/src/core/agent-runner.ts:24`).
  `pi` (PR #470, merged 2026-08-11) is the worked example for `AGENT_PROTOCOL.md` §9 (`:399-447`).
- A fifth runner, Cursor (#805 / PR #807), is open and unmerged on the same seam.
- Codex is driven through `codex app-server` (JSON-RPC over stdio), not `codex exec`.
- The configured provider is already read from the agent's own config and passed into
  `resolveModelIdentity` as `configuredProvider` (`agent-config/model-settings/codex.ts`,
  `workflows/run.ts:110`), so `azure/<deployment>` on codex already resolves when
  `~/.codex/config.toml` sets `model_provider = "azure"`. The remaining gap is discoverability
  and per-run selection, not the guard itself.
- Credentials are least-privilege per backend (`core/agent-env.ts:221-231`); `XAI_` and
  `AZURE_OPENAI_` are in the multi-provider set granted to opencode and pi; codex has `AZURE_OPENAI_`
  but not `XAI_`. #850 asks to gate cloud-credential unlocks on backend identity.
- #881 (triage map) proposes a "runner-seam de-duplication" enabler PR before any new backend.

## Resolved unknowns

| # | Question the gate will raise | Answer | Source / rationale |
|---|---|---|---|
| U1 | The brief bundles four independently deployable capabilities — split into separate specs? | **No. One spec, four phases** (Phase 0 seam de-dup enabler, Phase 1 provider identity for single-transport backends, Phase 2 Gemini runner, Phase 3 Copilot runner). Each phase is independently shippable and gets its own implementation PR. | Triage comment on all four issues (2026-07-21) and #881 Wave 1 row 9. Cohesion is kept through Phasing. |
| U2 | Include an explicit Phase 0 (union-site de-duplication) or fold it into the first runner PR? | **Explicit Phase 0**, small and typecheck-enforced, merged first. | Reduces the collision with PR #807 (Cursor) and the six queued backends. |
| U3 | Provider identity: generalize `BackendModelMap.defaultProvider` to a served-provider set, or build on `configuredProvider` + `providerByModel`? | *human* — recommendation: build on the existing `configuredProvider` path and add only what discoverability needs; keep the #405 invariant "never persist a provider that did not serve the run". | `model-identity.ts:60-100,140-165`; #405 review M2. |
| U4 | Config stance for #583/#584 Option A: document the `model_providers` entry, or generate/validate it? | **Document** (surface-and-document); no writes to `~/.codex/config.toml` by cezar. | `catalog.ts:196-221` treats vendor config as the user's file; config writes are localHandoff-gated (AGENTS.md). |
| U5 | #584: Option A (codex + custom provider) vs Option B (dedicated Grok runner)? | **Option A**, unless the research step finds an official, headless-capable xAI CLI. Option B stays out of scope. | Issue #584 evidence: no built-in xAI provider in codex, no official CLI found as of 2026-07-21. Re-verify. |
| U6 | Gemini runner (#581): persistent process with follow-ups vs `--resume` per turn? | *human / research* — default: whichever Gemini CLI documents; if neither, fresh-session-per-turn documented honestly, following the Cursor v1 precedent (#807). | Issue #581 design question; #807 body. |
| U7 | Copilot runner (#582): ACP stdio server vs one-shot commands? | **ACP stdio server** (`copilot --acp --stdio`). | Issue #582 preference; aligns with the codex JSON-RPC runner shape. |
| U8 | Should the spec also cover #510 (Kimi) and #511 (GLM)? | **No**, but Phase 1 must be written so an Anthropic-compatible provider on the claude transport can reuse it without a rewrite; name them in Risks/Phasing. | Same family; keeping them out bounds the spec. |
| U9 | Merge order vs PR #807 (Cursor) and PR #925 (multi-model harness)? | *human* — default: Phase 0 first, Cursor rebases onto it; note #925 overlap in Risks. | Both touch `agent-env.ts`, `agent-runner.ts`, `ui-events.ts`. |
| U10 | Mockups/screenshots for the spec PR? | **Text-only** unless a test-env descriptor exists (`.ai/qa/test-env.json` is absent today). | `om-auto-write-spec` step 5 degrades to text-only. |
| U11 | Which Google CLI does the `gemini` runner drive, now that Google retired "Sign in with Google" for Gemini CLI (2026-06-18, `IneligibleTierError UNSUPPORTED_CLIENT`)? | *human* — recommendation: **keep Gemini CLI as the Phase 2 transport (API key / Vertex / Workspace users), record Antigravity CLI (`agy`, free individual plan, headless `agy -p --output-format stream-json`, `--conversation <id>` resume) as the follow-up runner, and keep the mapper/fixture layout so the two can share the seam later.** Detection must state the auth reality in its hint (API key required for individuals). | README §4 item 8, §5 Q-F; verified on this host 2026-09-19; google-gemini/gemini-cli#28229. |

## Research items the spec's research step must confirm (do not default these)

- Azure: `base_url` form (Azure OpenAI vs Foundry project endpoint), `wire_api` (`responses` vs `chat`), whether `api-version` must be pinned via `query_params`, API-key vs Entra (`experimental_bearer_token` / `env_http_headers`), deployment-name-as-model, what codex's built-in Azure host detection does, whether `requires_openai_auth` gates anything — against `@openai/codex` ≥ 0.155.
- xAI: does codex work against `https://api.x.ai/v1`, `wire_api` value, `XAI_API_KEY` name; existence of an official xAI CLI.
- Gemini CLI (≥ 0.60): stream-json event set, session id / `--resume` in `-p` mode, exit codes 42/53, whether one process accepts follow-up turns, `--approval-mode` vs the deprecated `--yolo`/`--allowed-tools`, which auth methods still work for individuals (API key free tier = 250 requests/day, Flash only).
- Antigravity CLI (`agy`): headless flags and NDJSON events (`init`/`step_update`/`result`), permission policy in headless mode (soft-deny by default, `permissions.allow` rules, `--dangerously-skip-permissions`), free individual plan limits ("basic weekly rate limits"), keyring-based credentials and what that means for cezar agent accounts.
- Copilot CLI (`@github/copilot` ≥ 1.0.86): ACP `initialize`/session load, permission requests, tool filters as server-start options, token/login precedence.

## Out of scope (carried from the issues)

Routing anything through OpenCode; replacing vendor auth flows; proxying provider APIs directly;
storing provider credentials under `.ai/cezar/`; Option B Grok runner; #510/#511 implementation.
