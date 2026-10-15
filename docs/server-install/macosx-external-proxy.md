# Remote access — macOS + external proxy

Run a cezar cockpit on your **Mac** behind a public front you **already own** —
Caddy, nginx, a tunnel you manage yourself, Tailscale Funnel, anything that
terminates TLS and can enforce a login. cezar installs no proxy of its own:
just the launchd service, verified listening where your front will look for it.

**How it's wired:** a **launchd** agent keeps cezar serving on a fixed
host:port (loopback by default). **Your** front routes a public hostname to
that address and is responsible for TLS **and** authentication — cezar has no
built-in auth, so the installer says so loudly instead of standing up an open
cockpit. This is the macOS analogue of `ubuntu-vps --external-proxy` as a
first-class platform.

```
  internet ──HTTPS──► your front (Caddy/nginx/…) ──►  cezar (127.0.0.1:4321)
                      TLS + auth = yours              launchd agent
```

---

## Prerequisites

- macOS with [Homebrew](https://brew.sh).
- A reverse proxy / tunnel you control, able to reach the Mac and to enforce
  authentication (basic-auth, an IdP, mTLS — your choice).
- At least one logged-in agent CLI — `claude`, `codex`, or OpenCode (experimental).

---

## Install

```bash
npx cezar-cli server-install --platform macosx-external-proxy
```

If your front runs in a container or VM and cannot dial the Mac's loopback,
bind an interface it *can* reach:

```bash
npx cezar-cli server-install --platform macosx-external-proxy --bind-host 192.168.64.1
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects the agent CLIs / `gh` / `git`; offers to `brew install` the missing ones. |
| **Autostart** | Installs the cezar cockpit agent (`~/Library/LaunchAgents/ai.cezar.cockpit.plist`) with `RunAtLoad` + `KeepAlive`, bound to `127.0.0.1` (or your `--bind-host`) on the instance port. |
| **Verify** | Confirms cezar actually answers on that address — the install fails loudly if not — and prints ready-to-adapt Caddy and nginx routing snippets. |

**Auth is your front's job.** Anyone who can reach the bound host:port can run
agents on your Mac, so the front must challenge every request, and the bound
interface must stay off the public internet (firewall / bind) — the front
should be the only thing that can reach it.

---

## Updating / redeploying

```bash
npx cezar-cli server-deploy --platform macosx-external-proxy
```

Restarts the cockpit launchd agent (picking up the new cezar version) and
re-verifies it answers where your front expects it.

---

## Uninstall

```bash
npx cezar-cli server-uninstall --platform macosx-external-proxy
```

Removes the cezar launchd agent cezar **owns**. Shared tools (the agent CLIs,
`gh`) are *listed* for manual removal, not deleted; your front's config is
yours to keep or revert.

---

← Back to [Remote access overview](./README.md)
