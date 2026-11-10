# Create a missing agent-account folder on Connect (#1918)

Source doc: .ai/specs/2026-07-29-agent-profiles.md

## Goal

Connect on a named agent account whose folder does not exist yet creates it (`mkdir -p`, 0700) before the status probe and the vendor login, so `codex login` (and every other profile-capable CLI) starts instead of failing with `CODEX_HOME … does not exist`.

## Scope

- `POST /api/v1/providers/connect`: for a non-default account on a local-handoff cockpit, create the folder before the probe; a mkdir failure answers 409 `{ error, command }` with `invalid_folder` telemetry.
- Fix the "Connect creates it" comments to name the real mechanism.
- Regression test in `agent-profiles-api.test.ts` for every `PROFILE_CAPABLE_PROVIDERS` kind.

Non-goals: account validation, the copy-paste command format, the hosted refusal, creating the folder at save time.

## Risks

- Hosted mode must never create host folders: the mkdir is gated on `localHandoff`.

## Progress

PR: #2069

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix

- [x] 1.1 Create the account folder before the probe in the Connect route — 239977bcd
- [x] 1.2 Regression tests for every profile kind, red without the fix — 239977bcd
