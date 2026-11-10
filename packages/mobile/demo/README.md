# Store-review demo server

A dry-run cezar on a small Ubuntu VPS. Apple and Google reviewers sign in to it from the Cezar app
using only the text in the review notes. Agents are the bundled mock, so there are no model keys,
no tokens and no real work. The box resets every night at 03:00 UTC. The design comes from
`.ai/specs/2026-10-31-mobile-apps-manager-first.md` (§ App Store review, Q10: reviewers only,
Hetzner, nightly reset) and `.ai/specs/2026-11-01-relay-qr-pairing.md` (§ How a reviewer pairs).

The reviewer can connect in two ways:

1. **Direct (primary).** The reviewer types `https://<domain>` plus a username and password. This
   works with every app build and needs no QR scanner, no second device and no help from us.
2. **Relay pairing (optional).** It works only with an app build that has the relay client (today
   that is branch `cez/ffb604b4`). The reviewer opens `https://<domain>/demo-pair/` in any browser,
   using the same login, gets a typed code, enters it in the app and presses Approve on the page.
   See [Relay pairing](#relay-pairing) for its limits.

## Files

| File | Runs as | What it does |
| --- | --- | --- |
| `setup.sh <version> [--reset]` | root | Idempotent install. Installs Node 22, Caddy and `@open-mercato/cezar@<version>`, creates the `cezar-demo` user, writes the systemd units and the Caddyfile, then seeds the box (first run) or restarts it (later runs) |
| `reset.sh [--fresh]` | root (and the timer) | Revokes old phones, stops cezar, wipes the demo state, re-seeds and starts cezar again |
| `seed.sh repo` / `seed.sh tasks [--force]` | `cezar-demo` | Creates the sample git repo, then creates tasks, a scheduled task and a manager through cezar's HTTP API on loopback |
| `common.sh` | (sourced) | Paths, the config reader and loopback API helpers |
| `pair/` | (static, served by Caddy) | The pairing page |

On the box:

| Path | Contents |
| --- | --- |
| `/etc/cezar-demo/demo.env` | You create this file. Root-only. Holds the domain and the reviewer login |
| `/var/lib/cezar-demo/` | Home of the `cezar-demo` user. Holds `home/` (`CEZ_HOME`), `projects/demo-app/` (the boot project and its `.ai/cezar/` run state) and caches |
| `/opt/cezar-demo/` | Installed copies of the scripts and `pair/` |
| `/etc/systemd/system/cezar-demo.service`, `cezar-demo-reset.{service,timer}` | Written by `setup.sh` |
| `/etc/caddy/Caddyfile` | Written by `setup.sh`. Mode `0640 root:caddy`. Holds only the bcrypt hash of the password |

## Why not `cezar server-install`

The spec says to use the existing `ubuntu-vps` installer plus a systemd drop-in. As of 0.20.0 the
installer cannot run unattended for this job:

- It refuses to run as root (`server-install/platforms/ubuntu-vps.ts:1289-1290`). This setup is a
  root script on a fresh box.
- Under `--yes`, the password prompt answers with an empty string (`server-install/ui.ts:173-174`),
  and the install then aborts on purpose (`ubuntu-vps.ts:490-491`). It has no way to read the
  password from a file. The design here is a root-only env file.
- Under `--yes`, the optional SSL step is skipped (`server-install/engine.ts:250-258`), and run
  interactively it asks for an email. That would leave no TLS, and the app refuses `http://`
  (`ServerOrigin.java:40`).
- The unit it writes runs as the installing user, sets only `CEZ_REMOTE=1`
  (`ubuntu-vps.ts:851`) and says "do not edit by hand". The demo also needs `CEZ_DRY_RUN`,
  `CEZ_TERMINAL=0`, a sandboxed `CEZ_HOME` and a hardened, dedicated user. A drop-in could add the
  variables, but not the rest cleanly.
- `--external-proxy` (`index.ts:125`, `209`) would skip nginx, but it keeps every point above.

So `setup.sh` does the same minimal job itself. It keeps cezar on loopback, puts a TLS and Basic
auth proxy in front and runs cezar as a service with `CEZ_REMOTE=1`. Caddy replaces nginx and
certbot because it gets and renews the certificate, uses HTTP/2, keeps the `Host` header and
streams SSE unbuffered with no extra configuration. Those are the points the installer's nginx vhost
handles by hand (`ubuntu-vps.ts:326-376`).

## The VPS

- **Size:** 1 vCPU and 2 GB RAM is enough. The service is capped at `MemoryMax=1200M` and
  `CPUQuota=80%`. 1 GB works but makes `npm install -g` slow. Disk: 20 GB.
- **Where:** Hetzner, as decided in spec Q10. Their smallest x86 or Arm cloud servers cost a few
  euros a month (check current prices). No other paid service is needed: the TLS certificate comes
  from Let's Encrypt, and the relay is the cezar default.
- **OS:** Ubuntu 24.04 LTS. Allow SSH plus 80/tcp and 443/tcp (and 443/udp for HTTP/3) in the cloud
  firewall. If `ufw` is active, `setup.sh` opens 80/443 itself.
- **Hostname:** the phone shows the server's hostname when it pairs through the relay
  ("Approve this phone on …"). Set it first: `hostnamectl set-hostname cezar-demo`.
- **DNS:** add an `A` record (and an `AAAA` record if the box has IPv6) for the demo domain, for
  example `cezar-demo.example.com`, pointing at the VPS. It must resolve before `setup.sh` runs,
  because Caddy requests the certificate when it starts.

The box must hold nothing else. See [Threat model](#threat-model).

## Install

1. Create the credentials file. It is root-only, and nothing in this directory ever contains the
   password. The generator makes a 24-character alphanumeric password that a reviewer can type:

   ```bash
   sudo install -d -m 0700 /etc/cezar-demo
   sudo sh -c 'umask 077; {
     echo "DEMO_DOMAIN=cezar-demo.example.com"
     echo "DEMO_USER=appreview"
     echo "DEMO_PASSWORD=$(openssl rand -base64 48 | tr -dc A-Za-z0-9 | head -c 24)"
     echo "ACME_EMAIL=ops@example.com"     # optional: Let'"'"'s Encrypt expiry mail
     echo "RELAY_KEEP_DAYS=3"              # optional: see "What a reset keeps"
     echo "DEMO_RELAY=0"                   # optional: 1 opens outbound network for relay pairing
   } > /etc/cezar-demo/demo.env'
   sudo cat /etc/cezar-demo/demo.env       # copy the password into your password manager
   ```

   `setup.sh` refuses to run if the file is not owned by root with mode `600`, if the password is
   shorter than 16 characters or contains whitespace, or if the username is anything but
   `[A-Za-z0-9._-]{3,64}`.

2. Copy this directory to the box and run setup with an exact cezar version:

   ```bash
   scp -r packages/mobile/demo root@<vps>:/root/cezar-demo
   ssh root@<vps> '/root/cezar-demo/setup.sh 0.20.0'
   ```

   The first run creates the repo and seeds it. Later runs keep the data and restart the service.
   Add `--reset` to wipe the demo and seed it again.

## Verify

```bash
# From anywhere: the login covers everything, health included. Expect 401 and a Basic challenge.
curl -s -o /dev/null -w '%{http_code}\n' https://cezar-demo.example.com/api/v1/health
curl -sI https://cezar-demo.example.com/api/v1/health | grep -i '^www-authenticate'   # Basic realm="cezar-demo"

# With the login. curl asks for the password, so it stays out of argv and shell history.
curl -s --user appreview https://cezar-demo.example.com/api/v1/health \
  | jq '{version, managers: .capabilities.managers, localHandoff: .capabilities.localHandoff, terminal: .capabilities.terminal}'
# expect managers true, localHandoff false (hosted), terminal false

# On the box
systemctl status cezar-demo caddy --no-pager
systemctl show cezar-demo -p Environment | tr ' ' '\n' | grep -E 'CEZ_(DRY_RUN|REMOTE|TERMINAL)'
systemctl list-timers cezar-demo-reset.timer
journalctl -u cezar-demo-reset -n 50 --no-pager      # last reset's log
curl -s http://127.0.0.1:4321/api/v1/runs | jq -r '.[] | "\(.status)\t\(.title)"'
```

Then open the app on a phone or simulator, follow the reviewer steps below and check that it opens
the Manager screen.

## What the seed contains

`seed.sh` creates `projects/demo-app`, a tiny Node to-do CLI with one commit. It then starts four
`quick-task` runs. The mock agent settles them like this:

| Task | Ends as | Why |
| --- | --- | --- |
| Add a `--json` flag | `done` | The task text carries the mock's `mock:done` marker (`scripts/mock-claude.mjs`, `doneMarker`, line 309) |
| Fix completing a finished task | `done` | Same marker |
| Write a short CONTRIBUTING.md | `waiting` with a question card | `mock:ask` (`mock-claude.mjs:327`) |
| Add a due date to tasks | `waiting` | The mock's ordinary turn, which parks waiting for a reply |

It also creates one task scheduled two days ahead with "Start later" (`POST /api/v1/deferred-start`).
The nightly reset wipes it before it can run. Last, it creates a manager named "Demo manager"
(projects `all`, 60-minute cadence) and sends it one message. The app opens on `/manager`
(`StartDecision.java:29`), so the Manager screen is not empty either.

A local run of `seed.sh` against a sandboxed dry-run cezar gave: 2 `done`, 2 `waiting`, a manager.
The scheduled task needs `~/.claude` to exist even in a dry run
(`automations/deferred-start.ts:113`), so `seed.sh repo` creates it.

## Reset

`cezar-demo-reset.timer` runs `reset.sh` at 03:00 UTC every day (`Persistent=true`, so a missed run
happens at the next boot). Run it by hand with `sudo /opt/cezar-demo/reset.sh`.

### What a reset keeps

| Kept | Why |
| --- | --- |
| Caddy config, certificates, the reviewer login | A reset must not change what the review notes say |
| The installed cezar version | Only `setup.sh <version>` changes it |
| `CEZ_HOME/relay/` (relay identity + `devices.json`) | See below. `reset.sh --fresh` wipes it too |

Everything else under `/var/lib/cezar-demo` is deleted: the repo, its run history and worktrees,
`CEZ_HOME` config, the project registry, managers, secrets, agent scratch and caches.

**Why the relay identity survives.** A phone paired through the relay is bound to this cezar's
relay identity, a key in `CEZ_HOME/relay` (`relay/service.ts:107-109`, `relay/identity.ts`). Wiping
it every night would silently unpair a reviewer whose review spans two days. The reviewer would
need to understand a "removed" screen and pair again, and that is exactly the kind of help we
cannot give. The direct path needs none of this, because its login lives in Caddy. Keeping the
identity also has a cost: the relay allows 10 phones per cezar (`devices`, RELAY_PROTOCOL.md § 8,
line 357). So before stopping cezar, `reset.sh` removes phones paired more than `RELAY_KEEP_DAYS`
(default 3) days ago, through `DELETE /api/v1/workspace/phones/:deviceId`. That way the relay hears
the removal. Editing `devices.json` by hand would leave the phone on the relay's allowlist.
`reset.sh --fresh` drops the identity and every phone.

## Rotate the credentials

Do it between submissions, never during an open review.

```bash
sudo sh -c 'umask 077; sed -i "s/^DEMO_PASSWORD=.*/DEMO_PASSWORD=$(openssl rand -base64 48 | tr -dc A-Za-z0-9 | head -c 24)/" /etc/cezar-demo/demo.env'
sudo /root/cezar-demo/setup.sh 0.20.0       # same version: re-hashes, reloads Caddy, keeps the data
sudo /opt/cezar-demo/reset.sh --fresh       # also unpair every relay phone (optional)
```

An installed app with the old password lands on its "password rejected" screen and asks again. The
realm stays `cezar-demo`. A changed realm would make every app ask again too (`ShellConnector.java:131`,
`realmChanged`). Update the App Store Connect and Play Console fields afterwards.

To upgrade cezar, run `sudo /root/cezar-demo/setup.sh <new-version>`. The app needs a server whose
health reports `capabilities.managers`. Without it the app opens `/` and shows "Update it with cezar
server-deploy" (`StartDecision.java`, `ShellConnector.oneTimeNote`).

## App Review notes

Replace the domain and the login with the real ones. Paste the password into the dedicated fields
only, never into public metadata.

### What to paste into the consoles

The App Review Information (App Store Connect) and App access (Play Console) text lives in
[`../store/reviewer-notes.md`](../store/reviewer-notes.md). Replace its `cezar-demo.example.com` with
`DEMO_DOMAIN` and its password placeholder with `DEMO_PASSWORD`. Its optional relay-pairing paragraph
works only with `DEMO_RELAY=1`; with the default `0`, delete it. The steps refer to the connect screens
in `connect/connect.js` (v0.1: "Server address", then "Username" and "Password") and, in the relay
build, `connect.js` on `origin/cez/ffb604b4` (lines 180-184: "Connect to cezar", "Scan QR code",
"Enter code", "Advanced").

## Relay pairing

`/demo-pair/` is three static files that Caddy serves behind the same login. The browser calls
cezar's own routes same-origin. It has no backend of its own, and nothing about a pairing is stored
outside cezar.

| Step | Route | Code |
| --- | --- | --- |
| Show a code | `POST /api/v1/workspace/phones/pairing`, then `POST …/pairing/:id/code` | `server.ts:8778`, `:8788` |
| Watch | `GET /api/v1/workspace/phones` (`pairing.status`, `digits`) every 1.5 s | `server.ts:8765` |
| Approve / Deny | `POST …/pairing/:id/approve` / `…/deny` | `server.ts:8799`, `:8801` |

The same flow, with a QR code, is in the cockpit at Settings > Connect a phone. A hosted request
may use these routes, and only a relay-scoped phone is refused (`server.ts:8754-8759`).

The pairing rules the design works around:

| Rule | Where | Effect on the reviewer |
| --- | --- | --- |
| A code lives 2 minutes from Show a code | `relay/pairing.ts:9` (`PAIRING_LIFE_MS`) | The page counts down. After expiry the reviewer presses Show a new code |
| The decision must land within 285 s of the rendezvous opening | `relay/pairing.ts:11` | Approve promptly once the number appears |
| Single use: the first phone to join wins, a second gets `contested` | `relay/pairing.ts:112-123` | A shared code cannot pair two phones |
| A human must approve, after the phone and cezar show the same digits | `relay/pairing.ts:215` | This is why the reviewer needs the page (or the cockpit) on some screen. It can be the same phone's browser |
| One pairing at a time. A new code replaces an unanswered one but not one waiting for approval | `relay/service.ts:532` | Two reviewers at once can collide. Each sees a clear message |
| 5 codes per hour per cezar process (in memory, reset by restart) | `relay/service.ts:19`, `:535` | The page shows the wait from `Retry-After` |
| Relay side: 10 rendezvous per hour per cezar, 10 phones per cezar | RELAY_PROTOCOL.md § 8, lines 357 and 365 | The phone limit is why `reset.sh` prunes phones |

**What is not feasible without changing cezar:** a fixed code printed in the review notes, or a
pairing that needs no approval click. The spec plans exactly that as `CEZ_RELAY_DEMO_CODE`
(dry-run only, auto-approve, reopened every 120 s; relay-qr-pairing spec § How a reviewer pairs,
task R6). It also needs a relay-side `rendezvousPerHour` override. Neither exists yet:
`CEZ_RELAY_DEMO_CODE` appears nowhere in `packages/`, and `.env.example` does not list it. Until
then, relay pairing is the optional path above, and direct mode is the one the notes rely on.

## Threat model

**What is on the box:** nothing worth stealing. It has no model API keys, no `gh` login, no
customer data and no other services. The only secrets are the TLS key (owned by the `caddy` user
under `/var/lib/caddy`), the bcrypt hash in the Caddyfile (`root:caddy 0640`), the plaintext login
in `/etc/cezar-demo/demo.env` (`root 0600`) and the relay identity key in `CEZ_HOME/relay`. Do not
put anything else on this VPS.

**Who holds the credential:** everyone who can read the review notes. That is every reviewer at
Apple and Google and anyone they forward it to. Treat the login as semi-public.

**Agents never execute.** `CEZ_DRY_RUN=1` replaces every agent CLI with a bundled mock
(`core/claude-cli-runner.ts:566-570`, `core/backend-detect.ts:53` and the matching branches for each
backend). Git pushes are no-ops and the GitHub merge panel is faked (`git-worktree.ts:824`, `server.ts:7010`).

**But the credential is still a shell.** Workflow check steps run real `bash -lc <command>` even
under `CEZ_DRY_RUN=1` (`workflows/run.ts:9829`, and landing checks at `workflows/landing.ts:59`).
`POST /api/v1/runs` accepts inline `steps` (`contract/src/runs.ts:1236`), so anyone with the login
can run arbitrary commands as `cezar-demo`. The setup assumes this will happen and contains it:

- A dedicated `cezar-demo` system user with shell `/usr/sbin/nologin`, no sudo and no SUID
  (`NoNewPrivileges`, `RestrictSUIDSGID`, an empty `CapabilityBoundingSet`).
- `ProtectSystem=strict` with `ReadWritePaths=/var/lib/cezar-demo` only, `ProtectHome=yes`,
  `PrivateTmp`, `PrivateDevices`, `ProtectProc=invisible`, kernel and cgroup protections. The
  cezar install in `/usr` is read-only to it.
- Resource caps: `MemoryMax=1200M`, `CPUQuota=80%`, `TasksMax=512`. Everything it writes is wiped
  nightly.
- **Outbound network: loopback only by default.** With `DEMO_RELAY=0` (the default) the unit sets
  `IPAddressDeny=any`, `IPAddressAllow=localhost` and `CEZ_RELAY=0`, so the shell a credential holder
  gets reaches nothing outside the box, and reviewers use the direct path only. `DEMO_RELAY=1` lifts
  that for the optional relay-pairing path, because the relay runs on Cloudflare anycast and no IP
  allowlist fits. Then a credential holder could use the box for outbound abuse: add an nftables rule
  allowing only TCP 443 and DNS for the `cezar-demo` uid (`meta skuid`), watch the provider's abuse
  mail, and rotate the login after each review round.
- **Not contained: disk.** No quota. A full disk breaks cezar until the next reset. Use a provider
  alert, or an XFS/ext4 project quota on `/var/lib/cezar-demo`.

**Also enforced:**

- No terminal: `CEZ_TERMINAL=0` (`server/capabilities.ts:231-235`). Hosted mode already defaults
  it off. The variable makes it explicit.
- Hosted mode (`CEZ_REMOTE=1`, `capabilities.ts:199`) turns off local handoff. It also returns 409
  for every agent-config write, which closes the hooks RCE path (`server.ts:8021-8030`).
- `CEZ_BROWSE_ROOT=/var/lib/cezar-demo/projects` confines the Add project browser and project
  registration (`workspace/config.ts:197`, check at `server.ts:3462-3473`). **It is a default, not
  a boundary:** a credential holder can move it with `PUT /api/v1/workspace/config`
  (`server.ts:3801-3849`). Only a relay-scoped phone is blocked from that (`:3803`). The systemd
  sandbox is the boundary.
- No phoning home: `CEZ_TELEMETRY=0` (`telemetry.ts:68`). Dry run already blocks telemetry
  (`:70`). `CEZ_NO_BANNER=1` turns off the GitHub star-count fetch (`server/star-count.ts:89`).
  `CEZ_SKILLS_AUTO_UPDATE=0` stops background `npx` skill updates (`workspace/config.ts:285`).
  `CEZ_ARTIFACTS_CDN=0` drops CDN sources from artifact pages. The relay socket opens only while a
  phone is paired (`.env.example`, phone relay section).
- TLS only: Caddy redirects HTTP to HTTPS, and the app refuses `http://` (`ServerOrigin.java:40`).
  Basic auth covers `/api/v1/health` too. That is required: the app treats a Basic challenge on
  health as "this server needs a login" (`HealthClassifier.java:19-23`, `ShellConnector.java:93`).
- Abuse of the relay path: a holder can spend the 5 codes per hour (the relay path is then
  unavailable for that hour, while direct mode is unaffected), or pair up to 10 phones (pairing then
  fails with `device-limit` until `RELAY_KEEP_DAYS` passes or you run `reset.sh --fresh`). A
  paired phone gets the relay scope, which cannot pair phones, remove phones or move the browse
  root (`server.ts:8750-8759`, `:3803`).

## Every cezar name used here, with its source

| Name | Source |
| --- | --- |
| `CEZ_DRY_RUN` | `core/backend-detect.ts:53`, `core/claude-cli-runner.ts:566-570`; `.env.example` "testing / internal" |
| `CEZ_REMOTE` | `server/capabilities.ts:199`; `.env.example:11` |
| `CEZ_TERMINAL` | `server/capabilities.ts:231-235`; `.env.example:201` |
| `CEZ_HOME` | `paths.ts:28-31`; `.env.example:116` |
| `CEZ_BROWSE_ROOT`, `CEZ_PROJECTS_DIR` | `workspace/config.ts:197`, `:201`; `.env.example:106-107` |
| `CEZ_SECRETS_KEYCHAIN` | `workspace/secret-keyring.ts:34` (also used by the relay identity, `relay/identity.ts:46`) |
| `CEZ_TELEMETRY` | `telemetry.ts:68`; `.env.example:378` |
| `CEZ_NO_BANNER` | `server/star-count.ts:89`, `skills-banner.ts:30`; `.env.example:187` |
| `CEZ_SKILLS_AUTO_UPDATE` | `workspace/config.ts:285`; `.env.example:131` |
| `CEZ_ARTIFACTS_CDN` | `runs/artifacts.ts:76`; `.env.example:194` |
| `CEZ_RELAY`, `CEZ_RELAY_URL` (not set, listed for completeness) | `relay/wire.ts:74`, `:87`; `.env.example:30-32` |
| `serve --no-open --port` | `index.ts:120`, `:205`, `:241-242` |
| `GET /api/v1/health` | `server/server.ts:2118` |
| `GET`/`POST /api/v1/runs` | `server/server.ts:5108`, `:5192`; body `contract/src/runs.ts:1231-1305` |
| `POST /api/v1/deferred-start/preview`, `POST /api/v1/deferred-start` | `server/server.ts:4458`, `:4462`; `contract/src/deferred-start.ts` |
| `GET`/`POST /api/v1/workspace/managers`, `POST …/:id/messages` | `server/server.ts:8678-8679`, `:8697`; `contract/src/managers.ts:130` |
| `/api/v1/workspace/phones*` | `server/server.ts:8754-8806`; `contract/src/phones.ts` |
| Loopback writes without `Origin` pass the guard | `server/server.ts:1781-1835` |
| Built-in workflow `quick-task` | AGENTS.md, Workflows |

Paths are relative to `packages/cezar/src/` unless they name a package. Line numbers are as of
cezar 0.20.0 (commit `e10015fc8`).
