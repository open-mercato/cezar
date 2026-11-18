# Reconnect an agent account where the error appears

Status: design, awaiting approval · Date: 2026-11-18 · Design page: `2026-11-18-inline-account-reconnect.html`
(interactive; deep links such as `?runner=copilot&phase=signing&mode=remote`)

## Problem

When an account's login expires, the manager chat shows one red line ("Sign in to Claude Code again: run its login in a
terminal, or reconnect the account in Settings → Agent accounts", `managers/failure.ts`), and the task transcript shows
`ProviderAuthRequiredCard`, which links to Settings. Either way the user has to leave the conversation. Once they sign
in, nothing resumes.

## Design

An inline **reconnect card** replaces both. It appears in manager chats, task transcripts, the attention list, the
runtime-auth banner, the phone cockpit and CezarBot.

- **Expired**: shows the runner icon, `<Agent> · <account>`, and the actions **Reconnect &lt;account&gt;** (primary),
  **Use &lt;other account&gt; instead** (a split menu of the healthy accounts this task or manager may use), and
  **More options** (Check again · Settings → Agent accounts · terminal command + Copy, as the last resort).
- **Signing in** uses whatever the vendor supports: a browser tab, a device code with Copy and a countdown, a
  paste-the-code step, an API-key field (only where the vendor stores the key itself), or a watched terminal
  hand-off.
- **Signed in**: the turn whose card was clicked resumes automatically. Everything else blocked on the same account
  is listed with **Resume all**. An "Ask first" setting turns the first resume into a single **Resume** button too.
- **Failed**: a fixed reason (code expired, tab closed, different account signed in), plus Try again and the switch
  action.
- **Several accounts out**: one card per account, never one per failure. Older occurrences collapse to a quiet line.
- **Phone or hosted**: there is no localhost callback, so the card uses device codes, pasted codes or links that work
  on any device. Agents that can only sign in on the host get the copy-the-command path, plus a "Finish on my
  computer" hand-off.

## Mechanism

A server **login session** (`POST /api/v1/providers/login`, input, cancel, and a workspace SSE event `agent-login`).
It reuses `resolveWorkspaceProfile`, `loginCommand`, the account folder and `watchOpenedLogin` from
`POST /providers/connect`, which stays as it is as the terminal fallback. Per agent:

| Agent | Headless start | Remote / phone |
| --- | --- | --- |
| Claude Code | `claude auth login` in a PTY, URL captured | the CLI's paste-code flow |
| Codex | app-server `account/login/start`; `--device-auth`; `--with-api-key` | device code |
| Cursor | `agent login`, URL printed, Cursor polls (spike: suppress browser) | same link |
| Copilot | `copilot login` device flow | same |
| OpenCode | `opencode serve` auth API (key; provider OAuth: spike) | key paste |
| Kimi | `kimi login` (spike) | terminal |
| pi, Gemini, Antigravity, Junie, OMP | terminal hand-off (no headless login) | command + Check again |

Success means the login exits 0 **and** a fresh `profileStatus` for that account answers connected **and**
`readAccountIdentity` matches the account's previous identity. Success clears that account's runtime incident (the
user's completed login is the evidence the provider-auth spec asks for) and emits `provider-status`.

**Resume.** Phase 2 parks a task that hits an auth rejection as *waiting* (reason `auth`), keeping its
`sessionId`/`profileId`. Resume is then `POST /runs/:id/continue` on the same account. A manager re-sends its failed
chat turn. Watch and job turns wait for their next tick. Switching account goes through the existing `agentProfile`
fields and starts a fresh session (spec 2026-07-29 § sessionId and profileId are a pair).

## Security

- Tokens never reach the page. The page receives only the phase, an allow-listed verification URL, a user code, an
  expiry and a fixed reason.
- Pasted codes and keys go straight to the CLI's stdin. They are never persisted, logged, streamed or sent as
  telemetry.
- Inputs are a closed enum plus an account id.
- Remote starts are allowed for local cockpits and paired phones. Hosted web needs `CEZ_REMOTE_AGENT_ACCOUNTS=1`;
  otherwise it gets the existing 409 with the command.
- `CEZ_DRY_RUN=1` uses a mock session.

## Open questions

1. Should the clicked turn resume automatically while the rest wait for "Resume all" (recommended), or should
   everything resume automatically?
2. Should an auth rejection park a task (waiting, resumable) instead of failing it?
3. Hosted web: is gating behind `CEZ_REMOTE_AGENT_ACCOUNTS=1`, with paired phones allowed by default, enough?
4. Should the API-key paste be limited to vendors with their own credential store (Codex, OpenCode)?
