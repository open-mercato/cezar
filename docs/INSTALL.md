# Installation

Three ways to run Cezar — pick the one that matches how you want to operate.

- [Option 1 — Solo-use CLI](#option-1--solo-use-cli) — no SaaS, no database, local JSON store
- [Option 2 — Self-hosted SaaS](#option-2--self-hosted-saas) — full cockpit + auto-triage
- [Option 3 — Self-hosted runner](#option-3--self-hosted-runner) — keep subscription CLIs on your own login

---

## Option 1 — Solo-use CLI

The original CLI works against a local JSON store. Good for one-off triage of an
issue backlog, or solo use without infrastructure.

```bash
git clone https://github.com/comerito/cezar.git
cd cezar
yarn install
yarn build

export GITHUB_TOKEN=ghp_...
export ANTHROPIC_API_KEY=sk-ant-...

# launch the interactive hub — runs the setup wizard on first launch
node packages/cli/dist/index.js

# or non-interactive
node packages/cli/dist/index.js init -o your-org -r your-repo
node packages/cli/dist/index.js sync
node packages/cli/dist/index.js run bug-detector --apply
```

`yarn link:bins` installs the `cezar` and `cezar-runner` binaries globally
(via `npm link`); `yarn unlink:bins` removes them.

<!-- SCREENSHOT: Terminal screenshot of the `cezar` interactive hub — the
     setup-wizard greeting, then the main menu of analysis actions
     (bug-detector, duplicates, auto-label, …). Save as: docs/images/cli-hub.png -->

![CLI interactive hub](images/cli-hub.png)

---

## Option 2 — Self-hosted SaaS

Run the full Next.js app against Supabase (your own cloud project, or the local
docker stack that ships in `infra/supabase/`).

```bash
# 1a. EITHER: start the local Supabase stack (db + kong + Realtime in Docker)
yarn db:start                       # docker compose up -d, runs migrations
yarn db:logs                        # follow logs · db:reset, db:psql, db:stop

# 1b. OR: provision your own cloud Supabase project
cd packages/gui && npx supabase db push   # applies supabase/migrations/*.sql

# 2. set env vars (see .env.docker.example for the full template)
cat > .env.local <<EOF
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN..."
GITHUB_APP_WEBHOOK_SECRET=...
CRON_SECRET=...
NEXT_PUBLIC_APP_URL=https://app.example.com
EOF

# 3. run
yarn workspace @cezar/gui dev
```

Then install the GitHub App on your repo, walk through the **Workspaces → New**
wizard (project env preset, label-catalog analysis, workflow defaults), and
open `/dashboard`. New issues will start triaging automatically.

See [`github-app-setup.md`](github-app-setup.md) for GitHub App provisioning,
and [`../.env.docker.example`](../.env.docker.example) for the full env-var
template.

---

## Option 3 — Self-hosted runner

Add an optional worker so subscription CLIs (`claude`, `codex`) run under your
own login on your own infra. See [`SELF-HOSTING.md`](SELF-HOSTING.md) for the
full runner setup.
