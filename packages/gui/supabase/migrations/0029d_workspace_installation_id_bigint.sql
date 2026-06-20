-- 0029_workspace_installation_id_bigint.sql
-- Aligns `workspaces.installation_id` with `runners.github_installation_id`.
--
-- Both columns hold the same identifier — the GitHub App installation id —
-- but 0001 declared `workspaces.installation_id` as `text` while 0026
-- (correctly) declared `runners.github_installation_id` as `bigint`, noting
-- that GitHub install ids can exceed 2^31. The `text` column was the outlier:
--
--   * the webhook handler stored/queried it via `String(installationId)`,
--     with nothing rejecting a blank or non-numeric value;
--   * joining the two columns required a cast on every query;
--   * no UNIQUE meant two workspaces provisioned against the same install
--     would both silently "work", then collide at token-mint time (the wrong
--     workspace's install token minted for the wrong repo).
--
-- This migration converts the column to `bigint` and adds a partial UNIQUE
-- index so a duplicated install id fails at insert time instead of at the
-- GitHub API call. Blank strings are normalised to NULL during the cast.

-- ─── normalise legacy blanks, then convert text → bigint ────────────────────
alter table workspaces
  alter column installation_id type bigint
  using nullif(installation_id, '')::bigint;

-- ─── catch duplicate installs at insert time ────────────────────────────────
-- Partial index: many workspaces legitimately have no install configured yet
-- (NULL), so uniqueness only applies to rows that actually carry an id.
create unique index if not exists workspaces_installation_id_unique
  on workspaces (installation_id)
  where installation_id is not null;
