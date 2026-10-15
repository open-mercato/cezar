# Remote access — macOS + Caddy (local basic auth)

Front a cezar cockpit running on your **Mac** with [Caddy](https://caddyserver.com):
HTTPS, and a **username + password that cezar sets up for you** — no external
identity provider, no tunnel account, nothing to configure afterwards.

**How it's wired:** cezar runs locally on the Mac (a launchd agent, bound to
loopback). Caddy runs beside it as a second launchd job and is the only thing
that answers on the network: it terminates TLS, challenges every request for
the login, and proxies what's left to `127.0.0.1:4321`. The login is a **bcrypt
hash in a `0600` Caddyfile that cezar owns** — the macOS analogue of what
`ubuntu-vps` does with nginx + htpasswd.

```
  your device ──HTTPS + Basic-Auth──►  Caddy  ──►  cezar (127.0.0.1:4321)
                                       launchd     launchd agent
```

This is the macOS target to pick when you want the cockpit reachable **on your
own network** (or on a domain you own) without handing identity to Cloudflare
Access, a tailnet, or ngrok's edge.

---

## Pick an exposure

The installer asks once. Only *how TLS is obtained* differs — the basic-auth
login is enforced by Caddy in all three.

### LAN / VPN — HTTPS with Caddy's own CA *(default)*

Caddy issues the certificate from its **internal CA**. Nothing public is
needed: no DNS record, no open router port, no root. Reach the cockpit at
`https://<your-mac>.local:8443` from anything on the same network (or over a
VPN / tailnet, using that name instead).

The catch is trust: browsers don't know Caddy's local CA until you install it.

```bash
sudo caddy trust     # this Mac
# other devices: install ~/Library/Application Support/Caddy/pki/authorities/local/root.crt
```

### Public domain — automatic HTTPS

A real domain with a real Let's Encrypt certificate, renewed by Caddy forever.
Requires the parts only you can do: `cezar.example.com` resolving to this Mac's
public address, and **ports 80 and 443 forwarded** to it. Those ports are
privileged, so cezar installs Caddy as a **root LaunchDaemon**
(`/Library/LaunchDaemons/ai.cezar.caddy.plist`) — the one privileged command in
this platform, printed and verified like every other.

> Exposing a Mac on your home connection to the open internet is a real
> decision. The login is enforced, but consider a tunnel
> ([Cloudflare Tunnel](./macosx-cloudflare-tunnel.md), [Tailscale](./macosx-tailscale.md))
> if you'd rather not open ports at all.

### Plain HTTP on a local port

No TLS here — for when something else already terminates it (a tunnel you run
yourself). Caddy still checks the login, so the tunnel doesn't have to. The
site matches any `Host`, so a forwarded request lands correctly.

---

## Prerequisites

- macOS with [Homebrew](https://brew.sh) (the installer runs `brew install caddy`
  if Caddy is missing).
- For the *public domain* exposure: a domain pointing at this Mac, and :80/:443
  reachable from the internet.
- At least one logged-in agent CLI — `claude`, `codex`, or OpenCode (experimental).

---

## Install

```bash
npx cezar-cli server-install --platform macosx-caddy
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects the agent CLIs / `gh` / `git`; offers to `brew install` the missing ones. |
| **Autostart** | Installs the cezar cockpit agent (`~/Library/LaunchAgents/ai.cezar.cockpit.plist`) with `RunAtLoad` + `KeepAlive`, so the cockpit comes back on login. |
| **Caddy front** | Installs Caddy if needed, asks how to publish (above), asks for the hostname/port, and sets the **cockpit login** — generate a strong password (shown once) or type your own. The password is hashed with `caddy hash-password` (bcrypt, fed on stdin so it never appears in `ps`), written into `~/.cezar/Caddyfile` at `0600`, checked with `caddy validate`, then run by a launchd job. |
| **Verify** | Confirms cezar answers on loopback, that an anonymous request through Caddy is **challenged (401)**, and that an **authenticated** request actually reaches cezar. |

**The login is the whole identity.** cezar has no built-in authentication;
Caddy's `basic_auth` is what stands between the network and your agents. The
plaintext password is never written anywhere — only the bcrypt hash — so if you
lose it, re-run with `--reconfigure caddy` to set a new one.

### Where things live

| Path | What |
|------|------|
| `~/.cezar/Caddyfile` | The site: address, login hash, upstream. `0600`, cezar-owned. |
| `~/Library/LaunchAgents/ai.cezar.caddy.plist` | The front, on a non-privileged port. |
| `/Library/LaunchDaemons/ai.cezar.caddy.plist` | The front, when it binds :443 (root). |
| `~/.cezar/caddy.log` · `/var/log/cezar-caddy.log` | Caddy's own output — where a failed certificate or a taken port explains itself. |

---

## Updating / redeploying

```bash
npx cezar-cli server-deploy --platform macosx-caddy
```

Restarts the cockpit agent (picking up the new cezar version) and the Caddy
job, then re-runs the same end-to-end check the install ends with.

To change the setup itself — a different hostname, port, exposure, or a new
password — the installer is idempotent:

```bash
npx cezar-cli server-install --platform macosx-caddy --reconfigure caddy
npx cezar-cli server-install --platform macosx-caddy --reinstall   # redo everything
```

---

## Troubleshooting

| Symptom | Where to look |
|---------|---------------|
| Browser warns about the certificate | Expected on the internal CA — run `sudo caddy trust`, or install the root CA on the device you're browsing from. |
| `curl` gets nothing on the port | `tail -n 50 ~/.cezar/caddy.log`; a port already in use or a bad config is named there. `caddy validate --adapter caddyfile --config ~/.cezar/Caddyfile`. |
| Login prompt loops | The password was set as a bcrypt hash — re-run with `--reconfigure caddy` to set a known one. |
| 502 behind the login | The cockpit is down: `launchctl print gui/$(id -u)/ai.cezar.cockpit`. |
| Let's Encrypt never issues | :80 **and** :443 must reach this Mac from the internet, and the domain must resolve to its public address. `tail -n 50 /var/log/cezar-caddy.log`. |

---

## Uninstall

```bash
npx cezar-cli server-uninstall --platform macosx-caddy
```

Stops and removes the launchd job (the root daemon via one printed, verified
privileged command) and deletes `~/.cezar/Caddyfile` along with the login it
holds. Shared tools (`caddy`, the agent CLIs, `gh`) are *listed* for manual
removal, not deleted — as is Caddy's own certificate store.

---

← Back to [Remote access overview](./README.md)
