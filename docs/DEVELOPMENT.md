# Development

Local development setup, tech stack, and extension points.

- [Commands](#commands)
- [GitHub login for local dev](#github-login-for-local-dev)
- [Tech stack](#tech-stack)
- [Adding a new Action](#adding-a-new-action)
- [Adding a new effect](#adding-a-new-effect)

---

## Commands

```bash
yarn install
yarn build                                   # topological monorepo build
yarn test                                    # all workspaces
yarn typecheck
yarn lint

# per-workspace
yarn workspace @cezar/core   run test
yarn workspace @cezar/core   run build
yarn workspace cezar         run build
yarn workspace @cezar/runner run build
yarn workspace @cezar/gui    run build
yarn workspace @cezar/gui    run dev         # Next.js dev server

# single test file
cd packages/core && npx vitest run tests/store/store.test.ts

# local Supabase (docker compose stack in infra/supabase/)
yarn db:start                                # up -d (db + kong + Realtime)
yarn db:stop                                 # down
yarn db:reset                                # down -v && up -d (wipes data)
yarn db:logs                                 # follow logs
yarn db:psql                                 # psql -U postgres -d postgres
```

---

## GitHub login for local dev

The local Supabase stack (`infra/supabase/`) ships with the GitHub auth
provider **disabled**. Until you enable it, `Sign in with GitHub` returns
`{"error_code":"validation_failed","msg":"Unsupported provider: provider is
not enabled"}`. Email/password still works out of the box (GoTrue runs with
`MAILER_AUTOCONFIRM=true`, so any address auto-confirms).

> **Two different GitHub integrations — don't mix them up.** Local login uses a
> classic **OAuth App** (`LOCAL_GITHUB_*` below). The webhooks / installation-token
> path uses a **GitHub App** (`GITHUB_APP_*`, see
> [`github-app-setup.md`](./github-app-setup.md)). A GitHub App client id
> (`Iv23li…`) pasted into the OAuth slots fails at the profile fetch with
> `403 Resource not accessible by integration`, because a GitHub App can't read
> `/user/emails` via OAuth scopes. Use a real OAuth App here.

### 1. Register a classic OAuth App

Open GitHub → *Settings* → *Developer settings* → *OAuth Apps* → *New OAuth App*
(<https://github.com/settings/applications/new>) and fill the form:

- **Application name:** anything (e.g. `cezar local`).
- **Homepage URL:** `http://localhost:3000`
- **Authorization callback URL:** `http://127.0.0.1:54321/auth/v1/callback`
  (this is GoTrue's `/callback` on the Supabase gateway, **not** the Next.js
  `/auth/callback` route — the 54321 port, not 3000).
- Leave **Enable Device Flow** unchecked.

Click **Register application**, then **Generate a new client secret** and copy
both the **Client ID** and the **Client secret** (the secret is shown once). A
classic OAuth App client id is a 20-char hex / `Ov23…`-style string — **not** the
`Iv23li…` GitHub App form.

**Permissions / scopes.** A classic OAuth App has no per-permission toggles in
the panel, access is granted through OAuth *scopes* requested at sign-in time.
Cezar requests `read:user user:email repo` (see
[`packages/gui/src/app/auth/actions.ts`](../packages/gui/src/app/auth/actions.ts)):

- `read:user` — read the signed-in user's profile.
- `user:email` — read the account's email addresses (required; without it the
  profile fetch fails).
- `repo` — read/write access to repositories so autofix runs can push branches
  and open PRs.

You approve these on GitHub's consent screen the first time you log in — just
click **Authorize**. Nothing extra to configure in the OAuth App panel.

### 2. Enable it in the stack

Copy the template and fill it in:

```bash
cp infra/supabase/.env.example infra/supabase/.env
```

```dotenv
LOCAL_GITHUB_ENABLED=true
LOCAL_GITHUB_CLIENT_ID=<OAuth App client id>
LOCAL_GITHUB_CLIENT_SECRET=<OAuth App client secret>
```

GoTrue reads these via `GOTRUE_EXTERNAL_GITHUB_*` in the compose file. The flag
defaults to `false`, so `LOCAL_GITHUB_ENABLED=true` is required even with the
id/secret set.

### 3. Restart so compose re-reads `.env`

```bash
yarn db:stop && yarn db:start
```

A bare container restart won't pick up `.env` changes — you need `down` + `up`.

---

## Tech stack

- **TypeScript 5.x** strict, ES2022, NodeNext/ESM (`.js` on relative imports
  in core).
- **Node 20+** — native fetch, ESM, `node:util.parseArgs`.
- **Commander.js** + **@inquirer/prompts** for the CLI.
- **@octokit/rest** + **@octokit/auth-app** for GitHub.
- **@anthropic-ai/sdk** (streaming) + **@anthropic-ai/claude-agent-sdk**.
- **Zod** for config and LLM-response validation.
- **vitest** for tests.
- **Next.js 15** + **Supabase** + **Tailwind** for the GUI.

---

## Adding a new Action

Built-in catalog (ships with `@cezar/core`):

1. Append an entry to [`packages/core/src/actions-v2/default-actions.ts`](../packages/core/src/actions-v2/default-actions.ts).
2. Add the matching skill playbook to [`packages/core/skills/`](../packages/core/skills/).
3. Mirror the row in [`packages/gui/supabase/migrations/0014_seed_default_actions.sql`](../packages/gui/supabase/migrations/0014_seed_default_actions.sql)
   so the SaaS catalog matches. (A future change will seed-from-TS to remove
   the duplication.)

Workspace-scoped Action (no code change):

- Use **Actions → New** in the GUI, or override an existing built-in via
  **Actions → `<name>` → Override**. The clone is fully editable.

---

## Adding a new effect

1. Append an `EffectDef` to [`packages/core/src/actions-v2/effects.ts`](../packages/core/src/actions-v2/effects.ts)
   with a Zod schema for its input and an `execute(args, ctx)` impl.
2. Register it in `EFFECT_REGISTRY`. The runner and the Anthropic-tools
   generator pick it up automatically — no other plumbing.
