-- 0029_webhook_deliveries.sql
-- Idempotency / replay protection for the GitHub App webhook receiver
-- (`/api/github/webhook`, docs §3.7).
--
-- The receiver verifies the HMAC signature but never recorded the
-- `X-GitHub-Delivery` id, so a captured (or GitHub-retried) delivery could be
-- replayed indefinitely — re-running issue/PR upserts and re-enqueuing
-- triage/ci-followup/flow jobs (burning Anthropic budget). This table is the
-- idempotency key: the handler inserts the delivery id *after* the signature
-- check and *before* dispatch; a unique-violation (23505) means "already
-- processed" → short-circuit as a no-op replay.
--
-- Rows are tiny and self-GC: a partial index + scheduled prune keeps only a
-- short retention window (GitHub retries within ~hours, not days). We don't
-- store the payload — just the id and when we first saw it.

create table if not exists webhook_deliveries (
  delivery_id text primary key,
  received_at timestamptz not null default now()
);

-- Prune support: scan by age cheaply.
create index if not exists webhook_deliveries_received_at_idx
  on webhook_deliveries (received_at);

-- Prune rows older than p_retention_hours (default 48h). Returns the count
-- removed. Called on a schedule (e.g. the dispatch / triage-sweep cron) so the
-- table never grows unbounded; replay protection only needs to outlive
-- GitHub's retry window.
create or replace function prune_webhook_deliveries(p_retention_hours int default 48)
returns int
language plpgsql
as $$
declare
  n int;
begin
  delete from webhook_deliveries
   where received_at < now() - make_interval(hours => p_retention_hours);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The webhook handler runs with the service-role key (bypasses RLS). Granting
-- to all three roles keeps it callable wherever a Supabase client reaches; the
-- service-role-only webhook path is the real access-control surface.
grant execute on function prune_webhook_deliveries(int) to anon, authenticated, service_role;
