# Remote access — macOS + Tailscale

Expose a cezar cockpit running on your **Mac** through
[Tailscale](https://tailscale.com) — no ports to open, no TLS to manage, and,
uniquely among the macOS providers, **a login you don't have to wire up
yourself**: the tailnet *is* the identity boundary.

**How it's wired:** cezar runs locally on the Mac (a launchd agent).
`tailscale serve` is the front (in place of nginx+certbot): tailscaled
terminates HTTPS on a MagicDNS name with an automatically provisioned
certificate and proxies to `http://127.0.0.1:4321`. There is **no second
launchd agent** — the mapping lives in tailscaled's own state, so it comes back
with the daemon on boot.

```
  your devices ──HTTPS──► tailscaled on the Mac ──►  cezar (localhost:4321)
  (tailnet members)       *.ts.net + auto TLS        launchd agent
```

---

## Pick a mode

The installer asks one question that decides the whole security story:

| Mode | URL | Who can reach it | Setup cost |
|------|-----|------------------|------------|
| **Tailnet, on this Mac's name** (default) | `https://<mac>.<tailnet>.ts.net` | anyone on your tailnet | none |
| **Tailnet, as a Tailscale Service** | `https://<service>.<tailnet>.ts.net` | only what your ACL grants for `svc:<name>` | admin console + a tagged host |
| **Public internet (Funnel)** | `https://<mac>.<tailnet>.ts.net` | **anyone with the URL — no auth** | Funnel enabled in ACLs |

### Tailnet, on this Mac's name

`tailscale serve --bg --https=443 http://127.0.0.1:4321`. The cockpit is
reachable from every device logged into your tailnet and from nowhere else.
Nothing to configure beyond being logged in — this is the right default for a
personal Mac.

### Tailnet, as a Tailscale Service

[Tailscale Services](https://tailscale.com/docs/features/tailscale-services)
give the cockpit its **own** identity — a stable
`<service>.<tailnet>.ts.net` name and virtual IP that belong to the service,
not to the Mac hosting it. Two things that buys you:

- **The URL survives a move.** Re-host the cockpit on another Mac and the
  address people bookmarked keeps working.
- **Per-service access control.** A grant targets the service, so "only ops
  reaches the cockpit" no longer means opening up the whole machine:

  ```json
  { "src": ["group:ops"], "dst": ["svc:cezar"], "ip": ["443"] }
  ```

Prerequisites the installer states up front, because they're yours to set:

1. Tailscale **1.86.0+**.
2. The service defined in the admin console (*Services → Add service*).
3. **A tagged host.** A device logged in as a *user* cannot host a service:
   `tailscale up --advertise-tags=tag:cezar`.
4. A grant in your ACL policy with `dst: ["svc:<name>"]`.
5. Approval of this host for the service (*Services → your service → Hosts*),
   unless auto-approval is configured.

### Public internet (Funnel)

`tailscale funnel` publishes the same hostname to the open internet. **Funnel
carries no authentication and cezar has none built in** — anyone who learns the
URL can run agents on your Mac. The installer warns about this twice, on
purpose. Use it only behind an authenticating front of your own.

---

## Prerequisites

- macOS with [Homebrew](https://brew.sh) (or the Mac App Store Tailscale app —
  the installer finds either CLI).
- A Tailscale account, and this Mac logged into the tailnet. The installer runs
  `tailscale up` for you if it isn't.
- **HTTPS certificates enabled** for the tailnet (*admin console → DNS → HTTPS
  Certificates*) — `serve`, `service` and `funnel` all need them.
- At least one logged-in agent CLI — `claude`, `codex`, or OpenCode (experimental).

---

## Install

```bash
npx cezar-cli server-install --platform macosx-tailscale
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects the agent CLIs / `gh` / `git`; offers to `brew install` the missing ones. |
| **Autostart** | Installs the cezar cockpit agent (`~/Library/LaunchAgents/ai.cezar.cockpit.plist`) with `RunAtLoad` + `KeepAlive`, so the cockpit comes back on login. |
| **Tailscale front** | Installs `tailscale` if needed, runs `tailscale up` if this Mac isn't on a tailnet, asks which mode you want, and publishes the cockpit. Reads the resulting MagicDNS name out of `tailscale status --json`. |
| **Verify** | Confirms the cockpit answers locally **and** through its `*.ts.net` URL, then prints who can reach it. |

Homebrew installs the daemon but doesn't start it — the installer says so, and
the command is `sudo brew services start tailscale`. The App Store app runs its
own daemon; just launch it once.

---

## Updating / redeploying

```bash
npx cezar-cli server-deploy --platform macosx-tailscale
```

Restarts the cockpit agent (picking up the new version) and re-verifies. The
Tailscale mapping isn't touched — it points at the same local port throughout.
In `service` mode the deploy also re-runs `tailscale serve advertise`, so a host
that was drained comes back into rotation.

To change the setup itself, the installer is idempotent:

```bash
npx cezar-cli server-install --platform macosx-tailscale --reconfigure tailscale  # e.g. switch modes
npx cezar-cli server-install --platform macosx-tailscale --reinstall              # redo everything
```

---

## Uninstall

```bash
npx cezar-cli server-uninstall --platform macosx-tailscale
```

Removes the cockpit's launchd plist and withdraws **only the mapping cezar
created** — `tailscale serve --https=443 off`, or for a service a
`tailscale serve drain` followed by `... --service=svc:<name> --https=443 off`.
It never runs `tailscale serve reset`, which would also wipe mappings you set up
yourself. Shared tools (`tailscale`, the agent CLIs, `gh`) are *listed* for
manual removal, not deleted; the service definition and your ACL grants live in
your Tailscale account.

---

← Back to [Remote access overview](./README.md)
