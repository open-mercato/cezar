# First-Turn Task Ingestion Sanitization & Outbound PII Guard

- **Status:** Proposed
- **Relates to:** Issue #1156

## Context

Cezar implements inbound secret redaction (#427) via `packages/cezar/src/core/secret-redaction.ts` and `packages/cezar/src/runs/stream-redaction.ts`. This protects the web cockpit and persisted transcripts from storing credentials dumped by agent tool execution (`printenv`, etc.).

However, when composing tasks or attaching context briefs, users and integrations risk injecting raw credentials or customer PII into prompts handed to vendor runners (`claude`, `codex`, `cursor`, `opencode`).

### Explicit Seam & Scope Boundaries
To remain architecturally grounded and honest:
- **In-Scope (First-Turn Ingestion Seam):** Sanitization covers text composed by Cezar and handed to a runner on turn 1: task descriptions, continuation context, attached prompt briefs, and system-prompt augmentations (`--append-system-prompt` or prepended prompt blocks).
- **Auxiliary Call Coverage (Turn 1 & Mid-Run):** Crucially covers auxiliary LLM calls for run naming:
  1. Turn-1 auto-naming: `workflows/run.ts:1301` and `runs/auto-name.ts:94–100,163–165`.
  2. Mid-run re-naming: `workflows/run.ts:5020` (`void this.autoNameRun(runId, skillName, run.task, { turnText, diffStat: statText })`).
  - If sensitive tokens or PII are detected in the payload, auto-naming unconditionally falls back to a deterministic slug (`task-<id8>`) without dispatching to external APIs.
- **Out-of-Scope (Sub-process Tool Calls):** This hook does **not** act as an egress proxy or inspect subsequent vendor CLI tool executions (e.g. if an agent runs `cat .env` on turn 2+ inside the spawned vendor process). Those require vendor-specific execution hooks or an external network egress proxy.

## Decision

### 1. Deterministic Architecture Invariant (Zero LLM Delegation)
Sanitization and detection are **100% deterministic (code, AST, and regex rule-based)**.
- **Why No LLM Classifier:** Classifying PII via an LLM classifier is non-deterministic, untestable against formal truth tables, susceptible to prompt injection, and incurs unacceptable latency and cost on every prompt dispatch.
- **Canonical Pattern Source:** The gate reuses the exact credential patterns (`TOKEN_PATTERNS` / exported `detectSecrets()`) from `packages/cezar/src/core/secret-redaction.ts` so inbound scrubbing and outbound rejection cannot drift apart.
- **No Entropy Heuristics:** Entropic detectors (`detectHighEntropyBlobs`) are explicitly excluded to avoid massive false-positive rejections on lockfile integrity hashes, base64 fixtures, and minified bundle artifacts in developer repositories.
- **Adversarial Normalization:** Inbound text is normalized via Unicode NFKC before evaluation to eliminate lookalike homoglyphs and unescape known URL-encoded tokens.

### 2. Policy: Reject, Never Mask
Blindly replacing email addresses or identifiers with placeholders (`[REDACTED]`, `EMAIL_001`, `PHONE_001`) in task prompts causes fatal semantic destruction in coding commands (e.g. `git log --author=alice@corp.com` becomes `git log --author=EMAIL_001` or `git log --author=[REDACTED]`, making agent runs fail in confusing ways).
Therefore, the outbound guard functions exclusively as a **Validation / Rejection Gate**:
- When an actionable violation is detected, task dispatch fails closed with a clear error:
  `"Task contains raw credentials or PII; please remove or reference indirectly before dispatch."`
- This surfaces across all dispatch entry points: cockpit composer, CLI (`cez task create`), POST `/api/v1/runs/:id/dispatch`, and automated `inbox/` messaging.

### 3. Truth Table & Independence from `CEZ_REDACT_SECRETS`
Credential blocking is **unconditional**. The existing `CEZ_REDACT_SECRETS` environment variable (`runs/store.ts`) strictly controls on-disk and streamed transcript redaction for local debugging; it **never permits sending credentials to external model APIs**.

| Secret match | PII match | `CEZ_REDACT_PII` | Gate Action | Result Type |
|:---:|:---:|:---:|:---:|---|
| **Yes** | any | any | **REJECT** | Unconditional credential rejection (`reasonCode: 'credential'`) |
| **No** | **Yes** | **1** | **REJECT** | PII match with scanning active (`reasonCode: 'pii'`) |
| **No** | **Yes** | **unset / 0** | **ACCEPT** | PII scanning opt-in disabled (default) |
| **No** | **No** | any | **ACCEPT** | Clean prompt dispatched |

- **Git Identity Context Whitelist:** Standard benign developer identities (`git commit --author`, `Co-Authored-By:`, `package.json` author, and `CODEOWNERS`) are whitelisted from triggering PII rejection.

### 4. Synthetic Test Fixture Escape Hatch
To avoid false-positive deadlocks when developing tests that deliberately contain synthetic matching tokens (such as `secret-redaction.test.ts`):
- A dedicated external environment variable `CEZ_ALLOW_SYNTHETIC_FIXTURES=1` allows tasks to dispatch with mock tokens while preserving full on-disk transcript scrubbing.
- Escape hatches can **never** be commanded by inline text within the prompt itself, preventing prompt-injected security bypasses.

### 5. Rollout, Migration & Compatibility Plan
Under `BACKWARD_COMPATIBILITY.md` rules, rejecting previously accepted task inputs constitutes a behavior change that requires explicit transition handling:
- **Phase 1 (Audit & Warn):** The gate logs violations to the audit trail with a visible composer warning without blocking dispatch.
- **Phase 2 (Fail-Closed Default with Named Opt-Out):** The gate fails closed by default. A dedicated opt-out flag `CEZ_OUTBOUND_GUARD=0` (following the precedent of `CEZ_AGENT_TMPDIR` in `BACKWARD_COMPATIBILITY.md:24`) is provided for workflows needing legacy behavior.
- **Acceptance Criteria & Test Matrix:**
  1. Raw OpenAI key / GitHub PAT -> `REJECT` under all flag combinations.
  2. Matched email/phone with `CEZ_REDACT_PII=1` -> `REJECT` (`reasonCode: 'pii'`).
  3. Matched email with `CEZ_REDACT_PII=0` -> `ACCEPT`.
  4. Benign `git commit --author="Alice <alice@corp.com>"` with `CEZ_REDACT_PII=1` -> `ACCEPT`.
  5. Synthetic mock token with `CEZ_ALLOW_SYNTHETIC_FIXTURES=1` -> `ACCEPT`.
  6. Auto-naming triggers fallback slug `task-<id8>` on both turn 1 and mid-run re-naming when sensitive tokens are present.

## Consequences

- Task context cannot leak credentials or customer PII to cloud model APIs.
- Auto-naming side channels on turn 1 and mid-run are fully sealed.
- Prompt intent is preserved: task orders are never silently corrupted by destructive placeholder replacement.
- Zero drift between inbound transcript scrubbers and outbound pre-prompt gates via shared token patterns.
