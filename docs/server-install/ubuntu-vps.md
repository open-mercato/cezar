# Remote access — Ubuntu / Debian VPS

Host the cezar cockpit on a bare Ubuntu/Debian server, reachable over the
internet, behind a login and (optionally) HTTPS.

**How it's wired:** cezar itself stays **loopback-bound** (`127.0.0.1:4321`,
`CEZ_REMOTE=1`). **nginx** is the only public surface — it terminates TLS,
challenges every request with HTTP Basic-Auth, and proxies to cezar. A systemd
service keeps cezar running and restarts it on boot.

```
  internet ──HTTPS──► nginx (:443)  ──proxy──►  cezar (127.0.0.1:4321)
                      basic-auth + Let's Encrypt         systemd service
```

The wizard never escalates silently: **every privileged command is printed**,
and you choose to run it via `sudo` or paste it into a root shell yourself. Each
command is verified before the installer moves on.

---

## Prerequisites

- Ubuntu/Debian VPS with `apt`, reachable over SSH.
- A **normal, sudo-capable user** (the wizard refuses to run as root).
- At least one logged-in agent CLI on that user — `claude`, `codex`, or
  OpenCode (experimental). (The installer can install `gh` and the npm-based CLIs for you.)
- For HTTPS: a domain with a DNS `A`/`AAAA` record pointing at the box.
- **Ports 80/443 free.** If another reverse proxy already owns them (Dokploy,
  Coolify, Caddy…), don't run the default install — see
  [The box already has a reverse proxy](#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy).

> Tools installed in `~/.local/bin` or via nvm are found automatically — the
> installer merges your **login-shell PATH** before probing, so `claude`/`gh`
> are detected even when launched non-interactively.

---

## Install

From a published release:

```bash
npx cezar-cli server-install --platform ubuntu-vps
```

Or from a git checkout on the box:

```bash
git clone https://github.com/open-mercato/cezar && cd cezar
npm install && npm run build
node packages/cezar/dist/index.js server-install --platform ubuntu-vps
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects `claude` / `codex` / `opencode` / `gh` / `git`; offers to install the missing ones. At least one agent CLI is required. |
| **Reverse proxy** | Installs **nginx**, writes an `auth_basic` + SSE-safe proxy vhost, creates the **htpasswd** identity file, and — if `ufw` is active — allows `Nginx Full` (ports 80/443). |
| **Domain + SSL** *(optional)* | Points the vhost's `server_name` at your domain, then runs `certbot --nginx` for a Let's Encrypt certificate with auto-redirect. Skippable — you can add it later. |
| **Service** | Installs a **systemd** unit (rootless `--user` + linger where possible, else a system unit), **starts cezar now**, enables it on boot, and waits for it to answer on the loopback port. |
| **Verify** | Confirms an anonymous request is challenged (401) **and** that an authenticated request actually reaches cezar (2xx/3xx) — a real end-to-end check, not just "nginx is up". |

### Setting the cockpit login

During the reverse-proxy step you pick the **username** (defaults to your OS
user) and a **password** — either type your own or let the installer **generate
a strong one** (shown once, so save it). This is the HTTP Basic-Auth credential
you enter in the browser over HTTPS. cezar stores only a hash.

### The privileged-command prompt

For each root action you're asked:

- **"I'll run it myself as root"** (default) — the installer prints the exact
  command; you paste it into a root shell, then confirm. File writes show the
  **decoded** file content first, so nothing is hidden inside base64.
- **"Run it now via sudo"** — the installer runs it for you and streams output.

Your choice is remembered for the rest of the run.

---

## The box already has a reverse proxy (Dokploy, Coolify, Caddy…)

The default install above assumes cezar owns the HTTP front. If something else
already serves **:80/:443** — Dokploy/Coolify (which run **Traefik** in Docker),
a hand-rolled nginx, Caddy — installing cezar's nginx would fight it for those
ports. Use `--external-proxy`:

```bash
npx cezar-cli server-install --platform ubuntu-vps \
  --external-proxy --domain cezar.example.com --bind-host 172.17.0.1
```

That installs **the service only** — no nginx, no certbot. Steps run:
`deps → autostart → identity`. Your proxy terminates TLS and enforces auth.

```
internet ──HTTPS──► your proxy (Traefik/Caddy/nginx) ──► cezar (172.17.0.1:4321)
                    TLS + auth are YOURS to configure          systemd service
```

> ⚠️ **cezar has no built-in authentication.** In the default install nginx's
> basic-auth is that gate; with `--external-proxy` there is none, and anyone who
> can reach the bound host:port can run agents on your box. Put auth on the proxy
> and keep the port off the public internet (ufw / cloud firewall).

### Which `--bind-host`?

| Your proxy runs… | `--bind-host` | Why |
|---|---|---|
| **in a container** (Dokploy/Coolify → Traefik) | `172.17.0.1` (docker bridge) | a container cannot dial the host's `127.0.0.1` |
| **on the host** (nginx, Caddy, HAProxy) | omit (defaults to `127.0.0.1`) | loopback is reachable and stays private |

Check your bridge address with `ip -brief addr show docker0`.

### Wiring it to Dokploy / Traefik

Traefik needs a route to a **host** address, so use a file-provider config
(the installer prints this snippet, filled in, at the end of the run):

```yaml
http:
  routers:
    cezar:
      rule: "Host(`cezar.example.com`)"
      entryPoints: [websecure]
      middlewares: [cezar-auth]
      service: cezar
      tls: { certResolver: letsencrypt }
  services:
    cezar:
      loadBalancer:
        servers: [{ url: "http://172.17.0.1:4321" }]
  middlewares:
    cezar-auth:
      basicAuth:
        users: ["me:$$apr1$$...."]   # htpasswd -nb me 'pass' — double every $
```

`server-deploy` and `server-uninstall` work the same in this mode (uninstall
only removes the service — it never touches the proxy it doesn't own).

---

## Updating / redeploying a new version

Once a new cezar is available (a fresh local build, or a newly published
`cezar-cli`), reload the running service with one standardized command:

```bash
npx cezar-cli server-deploy --platform ubuntu-vps
#   from a checkout:  node packages/cezar/dist/index.js server-deploy --platform ubuntu-vps
#   npm script:       npm run server-deploy -- --platform ubuntu-vps
```

`server-deploy` reloads systemd, **restarts the cezar service**, waits for it to
answer, and re-runs the same authenticated end-to-end check as install — so a
green deploy means the cockpit is actually serving the new version.

- **From a checkout** the service runs `<node> <repo>/packages/cezar/dist/index.js` — so build
  first, then deploy: `git pull && npm run build && npx cezar-cli server-deploy --platform ubuntu-vps`.
- **Via npx** the service runs `npx --yes cezar-cli`. npx caches the resolved
  package under `~/.npm/_npx` and reuses it on restart, so `server-deploy` first
  **clears that cached `cezar-cli` build** and then restarts — the next launch
  re-resolves the latest published version. (Before this, a restart silently
  kept running the cached version — see #696.) `server-deploy` alone is enough.

The installer is also **idempotent** if you need to change the setup itself:

- `--reconfigure <ids>` — force specific steps (`deps,nginx-proxy,ssl,autostart,identity`).
- `--reinstall` — force **every** step (rewrites the unit, htpasswd, vhost…).
- `--reconfigure ssl` — add HTTPS to an existing HTTP-only install (needs a domain).

> Use `--reconfigure autostart` (not just `server-deploy`) when the **unit file
> itself** changed — e.g. after upgrading the installer — since a restart alone
> won't rewrite it.

---

## Hosting several cockpits on one box (multiple domains)

One VPS can run **several independent cezar cockpits**, one per domain. Each
instance gets its **own** loopback port, nginx site, htpasswd, systemd service,
and state file — they share only nginx and certbot, which route by `Host`
header. Pass `--domain` to select or create an instance:

```bash
# first cockpit — the default instance (loopback :4321, ~/.cezar/server.json)
npx cezar-cli server-install --platform ubuntu-vps

# a SECOND, fully independent cockpit for another domain
npx cezar-cli server-install --platform ubuntu-vps --domain shop.example.com
```

Because instances are **keyed by domain**, running `server-install` again with a
**new** `--domain` never resumes or overwrites an existing install — it stands
up a fresh instance. Run it again with the **same** `--domain` to resume or
reconfigure that instance.

What differs per instance:

| Instance | State file | nginx site | htpasswd | systemd unit | Loopback port |
|----------|-----------|-----------|----------|--------------|---------------|
| default (no `--domain`) | `~/.cezar/server.json` | `…/sites-available/cezar` | `/etc/cezar/htpasswd` | `cezar.service` | `4321` |
| `--domain shop.example.com` | `~/.cezar/server-instances/shop-example-com.json` | `…/cezar-shop-example-com` | `/etc/cezar/htpasswd-shop-example-com` | `cezar-shop-example-com.service` | auto (next free, e.g. `4322`) |

- **Port** — a new instance auto-picks the next free loopback port (`4321`,
  `4322`, …). Override with `--port <n>`. Each cockpit still serves loopback-only;
  nginx is the single public surface for all of them.
- **Login** — each instance has its own htpasswd, so every cockpit can have a
  different username/password.
- **Deploy / uninstall** — pass the same `--domain` to target that instance:

  ```bash
  npx cezar-cli server-deploy    --platform ubuntu-vps --domain shop.example.com
  npx cezar-cli server-uninstall --platform ubuntu-vps --domain shop.example.com
  ```

  A named-instance uninstall removes only that instance's owned artifacts and
  deletes its state file; the other cockpits and the shared nginx/certbot are
  left running. (Uninstalling the **default** instance does not remove a shared
  nginx that a named instance still needs — it lists it for manual removal.)

> Interactive installs help here too: if a cockpit already exists and you run
> `server-install` with no `--domain`, the wizard asks whether you want to set up
> a **second instance for a new domain** or manage the existing one — so the
> common "it just asks me to reinstall" case now has an obvious path forward.

---

## Uninstall

```bash
node packages/cezar/dist/index.js server-uninstall --platform ubuntu-vps
```

Removes what cezar **owns**: the nginx vhost, htpasswd, systemd unit, and boot
linger (when this install enabled it); the distro's default nginx site is
re-enabled if the install disabled it. Shared tools it merely *lists* for you
to remove by hand (agent CLIs, `gh`, and — when this install added them —
`nginx` and `certbot` packages, plus the TLS certificate: pulling a cert can
break other vhosts).

---

## Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `502 Bad Gateway` | cezar isn't running. `systemctl status cezar` / `journalctl -u cezar -n 50`. |
| `status=203/EXEC — Unable to locate executable` | An old unit with a bare `ExecStart`. Re-run `--reconfigure autostart`; the unit now uses an absolute `<node> <entry>`. |
| "no gh / claude installed" but you have them | Launched from a non-login shell without `~/.local/bin`/nvm on PATH. The current installer merges your login-shell PATH; update and re-run. |
| certbot "verification failed" but it succeeded | Fixed — verification now reads the world-readable nginx vhost, not root-only `/etc/letsencrypt/live`. |
| Cockpit unreachable, nginx fine | Ports 80/443 blocked. Check `ufw status` **and** any cloud firewall (Hetzner/AWS security groups). |
| nginx won't start: `Address already in use` | Another proxy (Dokploy/Coolify → Traefik, Caddy) owns :80/:443. Re-run with `--external-proxy` (see above). `sudo ss -ltnp \| grep -E ':80\|:443'` shows who holds them. |
| `run server-install as a normal sudo-capable user, not root` | You're `root`. `adduser cezar && usermod -aG sudo cezar`, `su - cezar`, log your agent CLI in **as that user**, then re-run. |
| External-proxy install: proxy returns 502 | Traefik runs in a container and can't reach `127.0.0.1`. Reinstall with `--bind-host 172.17.0.1` (or your `docker0` address). |
| Cockpit stuck on an old version after `server-deploy` | npx-based unit whose cache wasn't refreshed (fixed in #696 — `server-deploy` now clears it). Manual: `rm -rf ~/.npm/_npx` as the service user, then `sudo systemctl restart cezar-<instance>`. |

← Back to [Remote access overview](./README.md)
