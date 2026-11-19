# Reconnect an agent account where the error appears

Status: approved 2026-11-18 (`80ec33628`), implementation in progress · Date: 2026-11-18 · Design page: `2026-11-18-inline-account-reconnect.html`
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
- **Signed in**: everything blocked on that account restarts automatically: the clicked turn, other parked tasks, and
  managers whose chat turn failed on it. There is no Resume step and no setting. The card lists what is resuming, a
  toast confirms it, and every other blocked chat or transcript shows "✓ Reconnected … · resumed".
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

**Parking.** An auth rejection parks the task as *waiting* (reason `auth`) instead of failing it, keeping its
`sessionId`/`profileId` and showing the reconnect card. The attention list groups these per account. Two runs still
fail as before: a headless `cezar run` (no reconnect can reach it, so it must exit) and a dispatched child (its parent
waits on a settled report, not on a reconnect).

**Resume.** On a confirmed sign-in the server resumes, once per reconnect, every item parked with reason `auth` on that
`(provider, profileId)`. A task resumes through `POST /runs/:id/continue` on the same account and session, still subject
to `maxParallel`. A manager re-sends its failed chat turn. Watch and job turns are not re-run; they wait for their next
tick. Stopped or archived tasks are no longer blocked and stay put. Switching account goes through the existing `agentProfile`
fields and starts a fresh session (spec 2026-07-29 § sessionId and profileId are a pair).

## Security

- Tokens never reach the page. The page receives only the phase, an allow-listed verification URL, a user code, an
  expiry and a fixed reason.
- Pasted codes and keys go straight to the CLI's stdin. They are never persisted, logged, streamed or sent as
  telemetry.
- Inputs are a closed enum plus an account id.
- Remote starts are allowed for local cockpits and paired phones. Hosted web needs `CEZ_REMOTE_AGENT_ACCOUNTS=1`
  (an existing flag, so `.env.example` only gains a line on its widened meaning); otherwise it gets the existing 409
  with the command.
- API-key paste exists only for Codex and OpenCode, which store the key themselves.
- `CEZ_DRY_RUN=1` uses a mock session.

## Decisions (2026-11-18)

1. **Resume**: everything blocked on the reconnected account restarts automatically, with no Resume step. The owner
   ratified the unattended cost (AGENTS.md § Zero config): one restart per blocked task or manager per reconnect,
   `auth`-parked items only, tasks within `maxParallel`.
2. **Parking**: an auth rejection parks the task (waiting, resumable), not failed.
3. **Hosted web**: host sign-in from hosted web needs `CEZ_REMOTE_AGENT_ACCOUNTS=1`; paired phones are allowed by
   default.
4. **API keys**: offered only for Codex and OpenCode.

## Sign-in path checks (2026-11-18)

Each check ran the installed CLI with its stdio piped (no TTY), in a throwaway `HOME` and config dir, with a PATH shim for
`open`/`xdg-open`. No login was completed and no real credentials were touched.

| Path | CLI | Result |
| --- | --- | --- |
| Claude Code without a terminal | `claude` 2.1.310 | **Confirmed.** `claude auth login` prints "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…" with `redirect_uri=https://platform.claude.com/oauth/code/callback` and then reads "Paste code here if prompted >" from stdin. That is the paste-code flow, and it works headless. Its browser launch goes through `open` with a `localhost` callback URL, which a PATH shim captures, so the local flow needs no paste. |
| Codex device code | `codex-cli` 0.169.0 | **Confirmed.** `codex login --device-auth` prints `https://auth.openai.com/codex/device` and a one-time code in `XXXX-XXXXX` form, "expires in 15 minutes". The plain `codex login` prints its authorize URL on stderr (localhost:1455 callback). `--with-api-key` reads stdin. |
| Cursor without a browser | `agent` 2026.10.22 | **Confirmed.** With `NO_OPEN_BROWSER=1`, `agent login` prints `https://cursor.com/loginDeepControl?challenge=…&uuid=…` and waits; it polls Cursor, so the link works from any device. |
| OpenCode OAuth providers | `opencode` 1.19.2 | **Confirmed through `opencode serve`.** `GET /provider/auth` lists each provider's methods (`oauth`/`api`). `POST /provider/{id}/oauth/authorize {method}` answers `{url, method: 'auto'\|'code', instructions}` (OpenAI: device page plus "Enter code: XXXX-XXXXX"). `POST /provider/{id}/oauth/callback` completes it, and `PUT /auth/{id}` saves a key. The CLI's `auth login -p` is an interactive prompt, so it is not used. |
| Kimi | not installed on the check machine | **Not confirmed.** Kimi keeps today's terminal sign-in (Connect plus the login watcher). |

GitHub Copilot CLI wasn't installed either. Its device flow follows GitHub's documented `login/device` page, and its
driver falls back to the terminal sign-in when the code can't be parsed.
