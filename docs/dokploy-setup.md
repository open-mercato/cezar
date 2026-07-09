# Cezar on Hetzner + Dokploy — manual deployment guide

End-to-end guide for running Cezar on a Hetzner VPS managed by [Dokploy](https://dokploy.com),
using the Docker Compose stack defined at the repo root (`Dockerfile`,
`Dockerfile.runner`, `compose.yaml`). The Supabase database lives in Supabase's
cloud — Cezar just needs the project URL and keys.

> **Companion docs:** [`.env.docker.example`](../.env.docker.example) (full
> env-var template), [SELF-HOSTING.md](SELF-HOSTING.md) (env-var reference +
> self-hosted runner config), [github-app-setup.md](github-app-setup.md)
> (GitHub App + webhooks), [runner-setup.md](runner-setup.md) (self-hosted
> runner deep-dive).

---

## 0 · What you'll end up with

- A Hetzner VPS running Dokploy with two containers:
  - `gui` — the Next.js cockpit on `https://<your-domain>`. The in-process
    scheduler fires `/api/cron/{dispatch,triage-sweep,sync}` (dispatch every
    1 min, triage-sweep every 10 min, sync every 5 min).
  - `runner` — `@cezar/runner` daemon long-polling the GUI, ready to run
    jobs whose backend is `claude-cli` or `codex-cli`.
- Traefik (managed by Dokploy) terminating TLS via Let's Encrypt.
- The GitHub App webhook pointed at `https://<your-domain>/api/github/webhook`.

---

## 1 · Provision the Hetzner VPS

1. Create a **Cloud Server** (CX22 / CPX21 or larger — the runner clones repos
   and runs agents, so plan for ≥ 4 GB RAM if you'll use it heavily).
2. **Image**: Ubuntu 22.04 or 24.04 LTS.
3. **SSH key**: add yours.
4. **Networking**: open ports `22`, `80`, `443` in the Hetzner firewall.
   Do **not** open `3333` or `3000` — Traefik is the only public entry.
5. **(Recommended) DNS**: point an `A` record `cezar.yourdomain.com` at the
   VPS IP before installing Dokploy, so Let's Encrypt works on first boot.

---

## 2 · Install Dokploy

SSH in as root and run:

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

The installer brings up Dokploy itself (Traefik + the Dokploy control plane)
on port `3000` (web UI) and `:80/:443` (Traefik). Open the printed URL
(`http://<vps-ip>:3000`) and create the admin account.

> If Dokploy's own UI port `3000` collides with anything, the install script
> lets you remap it. Cezar's GUI binds host-side on `127.0.0.1:3333` (see
> `compose.yaml`) so there's no conflict with Dokploy's `:3000`.

---

## 3 · Prepare Supabase

If you haven't already (per [`packages/gui/SETUP.md`](../packages/gui/SETUP.md)):

1. Create a Supabase project — note the **Project URL**, **anon public key**,
   and **service\_role secret key**.
2. Apply migrations from `packages/gui/supabase/migrations/` in the Supabase
   SQL editor, oldest to newest.
3. Configure GitHub OAuth (for human login):
   - GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
   - **Homepage URL**: `https://cezar.yourdomain.com`
   - **Callback URL**: `https://<project-ref>.supabase.co/auth/v1/callback`
   - Paste the Client ID + Secret into Supabase → Authentication → Providers
     → GitHub.
4. **Supabase → Authentication → URL Configuration**:
   - **Site URL**: `https://cezar.yourdomain.com`
   - **Redirect URLs**: `https://cezar.yourdomain.com/**` and
     `https://cezar.yourdomain.com/auth/callback`
5. **Supabase → Database → Replication**: enable Realtime on `workflow_runs`,
   `agent_runs`, `agent_run_events`, `jobs` (and any others the cockpit
   subscribes to).

---

## 4 · Create the GitHub App

Follow [`docs/github-app-setup.md`](github-app-setup.md). The values you'll
need to paste into Dokploy:

| Field | Value |
|---|---|
| Webhook URL | `https://cezar.yourdomain.com/api/github/webhook` |
| Webhook secret | a random hex string — keep it; goes into `GITHUB_APP_WEBHOOK_SECRET` |
| App ID | numeric — `GITHUB_APP_ID` |
| Private key | the downloaded `.pem` contents — `GITHUB_APP_PRIVATE_KEY` |

Don't install the App on a repo yet — wait until step 7.

---

## 5 · Create the Dokploy Compose application

In the Dokploy UI:

1. **Create Project** → "Cezar" (or any name).
2. Inside the project, **Create Application → Compose**.
3. **Source provider**: GitHub. Connect your account if you haven't, then
   pick the `open-mercato/cezar` (or your fork) repository and the branch
   you want to deploy (`main` once this PR is merged, otherwise the feature
   branch).
4. **Compose path**: `compose.yaml` (root of repo).
5. **Build context**: `.` (default).

Don't deploy yet — env vars first.

---

## 6 · Env vars in Dokploy

Open the application's **Environment** tab and paste these. Don't commit
secrets to git; Dokploy stores them encrypted.

```env
# Public URL
NEXT_PUBLIC_APP_URL=https://cezar.yourdomain.com

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# Anthropic API (managed agent path)
ANTHROPIC_API_KEY=sk-ant-...

# Cron bearer (openssl rand -hex 32)
CRON_SECRET=replace-me-with-a-long-random-string

# GitHub App
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
GITHUB_APP_WEBHOOK_SECRET=replace-me

# Engine
CEZAR_USE_WORKFLOW_ENGINE=true

# Runner join token (placeholder — replaced after step 9)
CEZAR_RUNNER_JOIN_TOKEN=placeholder
# DEPRECATED — removed in v0.3.0; pre-issued runner token, superseded by
# CEZAR_RUNNER_JOIN_TOKEN. Leave unset.
# CEZAR_RUNNER_TOKEN=
```

The full reference (optional tuning vars: `CEZAR_DISPATCH_BATCH`,
`CEZAR_*_INTERVAL_MS`, `CEZAR_INPROCESS_CRON_DISABLED`, …) lives in
`.env.docker.example` and [SELF-HOSTING.md](SELF-HOSTING.md#environment-variables).

> **`GITHUB_APP_PRIVATE_KEY` format:** single-line with literal `\n` between
> the PEM lines is easiest in env-var UIs. Cezar normalizes `\n` → newlines
> at read time.

---

## 7 · Configure the domain in Dokploy

Still in the application:

1. **Domains** → **Add domain**.
2. **Host**: `cezar.yourdomain.com`.
3. **Path**: `/`
4. **Container port**: `3000` (the GUI's internal port — Traefik routes via
   the Docker network, so the `127.0.0.1:3333` host-side mapping in
   `compose.yaml` is irrelevant here).
5. **Service**: `gui`.
6. **HTTPS**: on. **Certificate provider**: Let's Encrypt.

Save. Dokploy will request the cert once the container is up.

---

## 8 · First deploy

Click **Deploy**. Dokploy will:

1. Clone the repo at the configured branch.
2. Run `docker compose build` (≈ 3–5 min on first build; Yarn cache and
   subsequent layers are reused on redeploys).
3. Bring up `gui` and `runner` services.
4. Hand traffic to Traefik once the container is healthy.

Watch the **Logs** tab for both services. You're looking for:

```
gui     |  ✓ Starting...
gui     | [scheduler] starting — base http://127.0.0.1:3000; 3 job(s): ...
gui     |  ✓ Ready in ...ms
runner  | [runner] starting — kind=self-hosted backends=claude-cli,codex-cli concurrency=1
runner  | [runner] heartbeat failed: ... → 500     ← expected until step 9
```

The runner's `500`s are expected at this stage — the token in step 6 is a
placeholder. Open `https://cezar.yourdomain.com` in a browser, log in via
GitHub OAuth, and confirm the cockpit loads.

---

## 9 · Register the runner and finish the auth dance

1. In the GUI, **Settings → Runners → Mint join token**. Copy the **join
   token** that's shown — it's only displayed once. (The runner registers
   itself with it and belongs to you; jobs you trigger route to your
   runners.)
2. Back in Dokploy → **Environment** → set `CEZAR_RUNNER_JOIN_TOKEN` to that
   token. Save. (`CEZAR_RUNNER_TOKEN` is deprecated — removed in v0.3.0.)
3. Dokploy will offer to redeploy — accept (or use **Redeploy** manually).
   Only the `runner` container needs the new value, but a stack redeploy is
   the simplest path.
4. Once `runner` is back up, run the one-time interactive logins so it can
   call Claude / Codex under your subscription. SSH into the VPS, then:

   ```bash
   # Find the runner container name
   docker ps --filter name=runner

   # Log into Claude (opens an OAuth code — paste it back in the terminal)
   docker exec -it <runner-container-name> claude login

   # Optional: Codex login if you'll use it
   docker exec -it <runner-container-name> codex login
   ```

   Credentials are written to `/home/node/.claude` and `/home/node/.codex`
   inside the container — the `runner-home` named volume keeps them across
   restarts and redeploys.

5. Tail the runner logs and confirm the 500s become successful long-polls:

   ```bash
   docker logs -f <runner-container-name>
   ```

   Expected: regular `[runner] heartbeat ok` and `[runner] no jobs` lines
   between claims. In the GUI, the runner's "Last seen" timestamp on
   **Settings → Runners** should update every few seconds.

---

## 10 · Point GitHub at the webhook + install the App

1. GitHub App settings → **Webhook URL**: confirm it's
   `https://cezar.yourdomain.com/api/github/webhook`.
2. Send a test delivery from the GitHub App's **Recent Deliveries** tab —
   expect a `2xx` response.
3. **Install** the App on the org or repos you want Cezar to manage. The
   `installation` webhook will populate `workspaces.installation_id`
   automatically, or you can set it manually in the workspace settings.
4. Trigger something — create a test issue. The GitHub webhook will fire,
   the dispatcher will pick up the triage job, and you should see a new
   row appear on `/cockpit`.

---

## 11 · Day-2 operations

### Updating Cezar

Push to the deployed branch (or merge to `main` if that's the tracked
branch). Dokploy's GitHub webhook triggers a rebuild + redeploy. The
runner volume (`runner-home`) survives, so `claude` / `codex` stay
logged in.

### Watching logs

Dokploy UI → application → **Logs** tab (filter by service). For tail-style
streaming, SSH to the VPS:

```bash
docker logs -f <gui-container-name>
docker logs -f <runner-container-name>
```

### Backups

- **Database**: rely on Supabase's automatic backups + take a manual
  snapshot before risky migrations.
- **Runner credentials**: the `runner-home` volume holds `~/.claude` and
  `~/.codex`. Snapshot the volume if you want to avoid re-running the
  interactive logins after a host rebuild:

  ```bash
  docker run --rm -v cezar_runner-home:/data -v $PWD:/backup \
    alpine tar czf /backup/runner-home.tgz -C /data .
  ```

### Scaling

The GUI is stateless — you can scale it horizontally if a single replica
isn't keeping up. Every replica's in-process scheduler ticks independently;
that's safe (`claim_next_job` uses `FOR UPDATE SKIP LOCKED`, the sweeps
upsert idempotently) just wasteful, so prefer scaling only when needed.
For the runner, register additional runners with their own tokens — each
claims jobs independently.

### Disabling cron routes per-replica

If you scale and want only one replica to drive `sync`, set
`CEZAR_INPROCESS_CRON_DISABLED=/api/cron/sync` on the others.

---

## 12 · Troubleshooting

| Symptom | Probable cause | Fix |
|---|---|---|
| Browser shows Dokploy's default page, not Cezar | Domain not yet routed | Check **Domains** tab, container port `3000`, service `gui`. Wait for Let's Encrypt. |
| `502 Bad Gateway` from Traefik | GUI container crashed | `docker logs <gui>`. Usually a missing/wrong Supabase env var. |
| GUI loads but login redirects to localhost | Supabase auth URL config | Re-check Site URL + Redirect URLs in Supabase (step 3.4). |
| Runner stuck on `unknown or revoked join token` | Token still placeholder | Repeat step 9; redeploy after setting `CEZAR_RUNNER_JOIN_TOKEN`. |
| `claude login` errors with "command not found" | Wrong container | Confirm you're `exec`-ing into the **runner** container, not `gui`. |
| Webhook deliveries show `503` | `GITHUB_APP_WEBHOOK_SECRET` unset | Set it, redeploy. Until then `triage-sweep` polls as a fallback. |
| Jobs stay queued forever | Dispatcher not running, or no runner for the required backend | Check `/api/cron/dispatch` logs (in-process scheduler tail). For CLI backends, confirm a runner is registered + online. |
| `:3000` collision on the host | Dokploy's UI also uses `3000` | Already handled — Cezar binds host-side on `127.0.0.1:3333`. If you removed that bind, restore it. |

---

## Quick reference: file locations

| File | Purpose |
|---|---|
| `Dockerfile` | GUI multi-stage build (standalone Next output) |
| `Dockerfile.runner` | `@cezar/runner` + `claude` + `codex` CLI image |
| `compose.yaml` | `gui` + `runner` services + `cezar` bridge net + `runner-home` volume |
| `.env.docker.example` | Full env-var template (copy values into Dokploy's UI) |
| `packages/gui/next.config.mjs` | `output: 'standalone'` for the slim runtime image |
| `docs/SELF-HOSTING.md` | Env-var reference + cron-source explanation |
| `docs/github-app-setup.md` | GitHub App creation (permissions, events, install) |
| `docs/runner-setup.md` | Runner registration + backend specifics |
