# Remote access — a private tailnet front, in local mode

This is the third option next to the two installers: reach the cockpit from another device over a
**private network that already authenticates devices** (a Tailscale tailnet, a WireGuard mesh, an
SSH-tunnelled proxy on the host) while the cockpit keeps running in **local mode** — local handoff,
home-file browsing and agent-config editing all stay available. `CEZ_REMOTE=1` is *not* used here.

```
  phone ──tailnet──► tailscale serve ──► cezar on 127.0.0.1:4321   (local mode)
                                          (Host: <tailnet name>)
```

The catch: the loopback Host allowlist (the DNS-rebinding guard, #426) refuses a request whose
`Host` is a tailnet name. `CEZ_TRUSTED_HOSTS` names the authorities that are allowed through.

## Setup

1. Keep cezar on loopback and let a front that runs *on this host* proxy to it:

   ```bash
   npx cezar-cli                        # stays on 127.0.0.1:4321
   sudo tailscale serve --bg --https=8445 http://127.0.0.1:4321
   ```

   > **A direct `--bind-host 100.x.y.z` is a different mode, not a shortcut.** A non-loopback bind
   > drops `localHandoff` (that is the documented hosted-mode switch), and hosted mode **skips the
   > Host guard entirely** — so `CEZ_TRUSTED_HOSTS` is inert there and the local-mode promises below
   > (handoff, home-file browsing, agent-config editing) no longer hold. If you want local mode, use
   > the loopback + `tailscale serve` shape above; if you want the direct bind, you are in hosted
   > mode and this page does not apply.

2. Tell cezar which `Host` values are legitimate. The value must be exactly what the request
   carries — authority, port included when the URL has one:

   ```bash
   CEZ_TRUSTED_HOSTS=my-node.example.ts.net:8445 npx cezar-cli
   # several hosts: CEZ_TRUSTED_HOSTS=a.example.ts.net:8445,b.example.ts.net
   ```

3. Point the terminal QR at that address so a phone can scan it:

   ```bash
   CEZ_PUBLIC_URL=https://my-node.example.ts.net:8445/ npx cezar-cli
   ```

   The banner prints the URL and a scannable QR code (`CEZ_NO_QR=1` silences it; a loopback-only
   cockpit never prints one). An explicit `CEZ_PUBLIC_URL` prints the QR even when stdout is not a
   terminal — captured logs and `--no-open` runs included — while a target inferred from
   `--bind-host` still needs the interactive check. The code is drawn with the terminal's foreground
   colour for dark modules, which is right for a light profile and inverted on a dark one; phone
   cameras read both, and a light terminal profile is the fallback if yours does not.

## Security — read once

* `CEZ_TRUSTED_HOSTS` extends the Host allowlist; it does **not** disable it. A DNS-rebound
  `evil.com` still sends `Host: evil.com`, is not in the list, and is still refused; writes still
  require `Origin` to match the served `Host`.
* The perimeter is your private network. Anything that can reach the address **and** present that
  `Host` reaches a cockpit whose agents can run commands as your user. Keep the tailnet ACL tight,
  never run a Funnel (public) front against a trusted host, and don't put a wildcard here — the
  value is an exact authority.
* cezar still has no authentication of its own. If the network is shared, use an ACL or add a front
  that authenticates.

## Undo

Unset `CEZ_TRUSTED_HOSTS` (and `CEZ_PUBLIC_URL`); with `tailscale serve`, also run
`sudo tailscale serve --https=8445 off`. Local mode goes back to loopback-only.
