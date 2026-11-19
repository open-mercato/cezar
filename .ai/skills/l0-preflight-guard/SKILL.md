---
name: l0-preflight-guard
description: Developer pre-commit and authoring aid. Checks a draft task prompt for credentials and PII before you submit it to Cezar. NOT a runtime gate - the fail-closed gate is deterministic TypeScript in the host process (see ADR).
---

# L0 Preflight Guard (Developer Aid)

> **Scope.** This skill helps a human or agent author clean prompts *before* dispatch.
> It is advisory. The enforcing gate runs as TypeScript in the Cezar host process
> before any task is sent to a vendor runner. Passing this skill does not bypass that gate.

## Policy: reject, never mask

A prompt is either 100% clean or rejected. Do not substitute placeholders
(`EMAIL_001`, `PHONE_001`, `[REDACTED]`): this destroys command semantics
(e.g. `git log --author=EMAIL_001`) and makes the agent fail in confusing ways.

## Procedure

1. Scan the draft against the canonical credential patterns (`TOKEN_PATTERNS`
   in `packages/cezar/src/core/secret-redaction.ts`): API keys, JWTs, private key blocks, etc.
2. If `CEZ_REDACT_PII=1` is set in the target environment, also scan for e-mail
   addresses and phone numbers.
3. On any match: STOP, report the match type and location (not the value), and ask the
   author to remove or reference the data indirectly (env var name, file path).
4. No match: the draft is safe to submit.

Do not use entropy heuristics. Lockfile hashes, base64 fixtures and minified bundles
cause false rejections in a dev repository.

## Truth table

| Secret match | PII match | `CEZ_REDACT_PII` | Result |
|---|---|---|---|
| Yes | any | any | **REJECT** (unconditional) |
| No | Yes | 1 | **REJECT** |
| No | Yes | unset / 0 | ALLOW |
| No | No | any | ALLOW |

`CEZ_REDACT_SECRETS` is irrelevant to this table. It only controls on-disk transcript
redaction (`runs/store.ts`) and never permits sending a credential to a cloud model.

## Output format

```
VERDICT: REJECT | ALLOW
FINDINGS: <type> at line <n> (no raw values)
```
