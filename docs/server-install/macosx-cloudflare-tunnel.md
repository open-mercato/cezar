# Remote access — macOS + Cloudflare Tunnel

Expose a cezar cockpit running on your **Mac** through a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) —
no ports to open, no TLS to manage, and a stable hostname on your own domain.

**How it's wired:** cezar runs locally on the Mac (a launchd agent).
**cloudflared** is the public front (in place of nginx+certbot): it dials out
to Cloudflare's edge, which serves your public HTTPS hostname. **Identity is a
Cloudflare Access application you attach to that hostname** — cloudflared has
no built-in auth knob, so the installer states the requirement loudly instead
of pretending a tunnel alone is enough. A second **launchd** agent keeps the
tunnel up and restarts it on login.

```
  internet ──HTTPS──► Cloudflare edge ──tunnel──►  cezar (localhost:4321)
                      Access (your IdP)            launchd agent + cloudflared
```

---

## Prerequisites

- macOS with [Homebrew](https://brew.sh).
- A [Cloudflare Zero Trust](https://one.dash.cloudflare.com) account (the free
  tier is enough) with a **token-managed tunnel** created under
  *Networks → Tunnels*.
- A **public hostname** routed to `http://localhost:4321` on that tunnel
  (*Networks → Tunnels → your tunnel → Public Hostname*).
- At least one logged-in agent CLI — `claude`, `codex`, or OpenCode (experimental).

---

## Install

```bash
npx cezar-cli server-install --platform macosx-cloudflare-tunnel
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects the agent CLIs / `gh` / `git`; offers to `brew install` the missing ones. |
| **Cloudflare Tunnel** | Installs `cloudflared` if needed, asks for the **tunnel token** (dashboard → your tunnel → Configure → Install) and your public hostname, and writes a launchd agent running `cloudflared tunnel --no-autoupdate run`. The token rides in the plist's `EnvironmentVariables` — visible in the `0600` plist, never in the process argv where `ps` could read it. |
| **Autostart** | Installs the cezar cockpit agent (`~/Library/LaunchAgents/ai.cezar.cockpit.plist`) with `RunAtLoad` + `KeepAlive`, so the cockpit comes back on login. |
| **Verify** | Confirms the tunnel reports connected (cloudflared's local `/ready`) and reminds you to attach Cloudflare Access. |

**Auth is your Access application.** Cloudflare Tunnel carries no
authentication of its own and cezar has none built in — create a self-hosted
application for the hostname under *Zero Trust → Access → Applications*, or
anyone who learns the URL can run agents on your Mac.

---

## Updating / redeploying

Reload the cockpit and the tunnel with the standardized command:

```bash
npx cezar-cli server-deploy --platform macosx-cloudflare-tunnel
```

`server-deploy` restarts both launchd agents (the cockpit picks up the new
version) and re-verifies the tunnel is connected.

To change the setup itself, the installer is idempotent:

```bash
npx cezar-cli server-install --platform macosx-cloudflare-tunnel --reconfigure cloudflared
npx cezar-cli server-install --platform macosx-cloudflare-tunnel --reinstall   # redo everything
```

---

## Uninstall

```bash
npx cezar-cli server-uninstall --platform macosx-cloudflare-tunnel
```

Removes both launchd plists cezar **owns** (the token goes with the tunnel
agent's plist). Shared tools (`cloudflared`, the agent CLIs, `gh`) are *listed*
for manual removal, not deleted. The tunnel itself — and any Access application
— lives in your Cloudflare account; delete them in the dashboard if you want
them gone.

---

← Back to [Remote access overview](./README.md)
