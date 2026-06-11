# @cezar/gui

Next.js 15 web shell around `@cezar/core`. See `CEZAR-GUI-SPEC.md` at the repo
root for the full architecture. This package is the Phase 0 scaffold — route
shells, Supabase client wiring, and a read-only `SupabaseStoreAdapter` that
materializes a CEZAR `Store` from Postgres.

## Prerequisites

- Node 20+
- A Supabase project (cloud or self-hosted)
- `yarn` at the repo root

## Setup

1. Copy the env template:
   ```bash
   cp packages/gui/.env.example packages/gui/.env.local
   ```

2. Fill in Supabase credentials (Project → Settings → API):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`

3. Apply the initial schema. Either via the Supabase SQL editor, or the CLI:
   ```bash
   # from packages/gui/
   supabase db push          # if you've run `supabase link` first
   # or paste supabase/migrations/0001_init.sql into the dashboard SQL editor
   ```

4. Enable GitHub OAuth in **Supabase → Authentication → Providers → GitHub**
   (this is the Auth path used in Phase 1 — Phase 0 doesn't yet block on auth).
   For the **local docker stack** (`yarn db:start`) the provider lives in
   `infra/supabase/.env` instead — see
   [GitHub login for local dev](../../docs/DEVELOPMENT.md#github-login-for-local-dev).

5. Install and run:
   ```bash
   yarn install            # from repo root
   yarn workspace @cezar/gui dev
   ```

6. Open http://localhost:3000 — the dashboard renders the 19-action grid.

## What's wired in Phase 0

- Next.js 15 App Router (RSC-first), dark-mode Tailwind
- `serverExternalPackages` for `@cezar/core` + its Node-only deps
- Route shells: Dashboard, Issues, My Flows, Cockpit (`/flows/cockpit/[flowId]`), Settings
- Supabase clients: browser (`@/lib/supabase/browser`), server-per-request, admin
- `SupabaseStoreAdapter implements StorePort` — `load()` materializes `Store`
  for a workspace; `save()` upserts workspace meta + issues

## What's next (Phase 1+)

- GitHub OAuth flow + workspace CRUD
- Per-action badges pulled from `actionRegistry` on the server
- Server Actions for triggering action runs
- EventBridge + RunnerService (Phase 2 — cockpit)

## Seeding a workspace manually (dev)

Until workspace CRUD lands, insert a row directly:

```sql
insert into workspaces (slug, name, repo_owner, repo_name)
values ('open-mercato', 'Open Mercato', 'comerito', 'open-mercato');
```

Then add yourself as admin (after first OAuth login so `auth.users` has a row):

```sql
insert into workspace_members (workspace_id, user_id, role)
values ((select id from workspaces where slug = 'open-mercato'),
        (select id from auth.users where email = 'plewczuk513@gmail.com'),
        'admin');
```
