# Desktop remote mode — the app as a window onto a server's cezar

**Status:** implemented (shell 0.1.11). 2026-10-23. Companion to `2026-09-25-self-update-and-desktop.md`.

## Problem

cezar runs on a VPS (`server-install --platform ubuntu-vps`), and the user wants the desktop
app to be only the window: agents, worktrees and runs on the server, nothing started locally.

## Decision

The shell's sidecar is swapped for an **ssh tunnel**: `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<server port> <dest>`
(`packages/desktop/src-tauri/src/remote.rs`), and the window loads `http://127.0.0.1:<local>`.

Why a tunnel and not loading the public `https://` URL:

- The window still shows a loopback origin, so the capability (`http://127.0.0.1:*`),
  `is_own_origin` and every IPC guard stay unchanged — no remote origin gets Tauri IPC.
- Login is the user's SSH key and `~/.ssh/config`. nginx Basic-Auth is not in the path, so
  the shell never has to answer an HTTP auth challenge inside the webview.
- A server without a public front works too.

| Choice | Value | Why |
| --- | --- | --- |
| How it is chosen | menu **Connect to a server…** → `~/.cezar/desktop-remote.json`; `CEZ_DESKTOP_REMOTE` wins | zero config: no file, no variable = local mode, exactly as before |
| ssh options | `BatchMode=yes`, `ExitOnForwardFailure=yes`, `ServerAliveInterval=15`×3, `ConnectTimeout=15`, `StrictHostKeyChecking=accept-new` | a GUI has no terminal for a prompt; fail fast with ssh's own message; refuse a changed host key |
| Destination | `host`, `user@host`, config alias; `[A-Za-z0-9._@-]`, no leading `-`, last after `--` | the one user-typed word on ssh's argv (`-oProxyCommand=…`) |
| Local ports | 4341–4350 | an origin of its own, so the server's cockpit never shares browser storage with the local one |
| Drops | reopened on the same port, backoff ≤15 s, failure page after 10 | the open page reconnects its SSE by itself |
| First failure | failure page at once with ssh's stderr, **Reconnect / Change server… / Use this computer** | an auth or host problem does not fix itself; no error report — not an app bug |
| Local-install actions | Update cezar, Versions, `update_cezar_command`, `show_versions_menu` disabled | they act on this machine's install; the server's cezar updates from its own cockpit |

`connect_server` (new IPC command) is splash-only (`caller_is_splash`) — the cockpit page never
decides what the window points at. Switching modes saves the choice and restarts the app.

## Verified

Against a hosted-mode cezar (`CEZ_REMOTE=1`) behind an unprivileged loopback `sshd`, with the exact
argv from `Remote::tunnel_args`: health 200, cockpit HTML, `capabilities.localHandoff=false`,
same-origin `POST /api/v1/runs` 201, cross-origin 403, SSE streams; a wrong key exits 255 in
~0.2 s with `Permission denied (publickey)`; a wrong server port logs `connect failed`.
