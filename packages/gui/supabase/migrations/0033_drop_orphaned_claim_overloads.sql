-- 0029_drop_orphaned_claim_overloads.sql
-- Fix the silent lease-arg drop on the runner hot path.
--
-- 0025 added a p_lease_seconds arg to claim_next_job / claim_next_job_for_runner
-- via `create or replace function`. Because the new arg changed the signature,
-- Postgres registered these as *new overloads* rather than replacing the older
-- bodies:
--   * claim_next_job_for_runner(uuid, text[], int)        — from 0010/0023
--   * claim_next_job(int)                                  — from 0010
-- still exist in pg_proc alongside the 4-arg / 2-arg lease-aware versions.
--
-- PostgREST resolves the runner API's call
--   admin.rpc('claim_next_job_for_runner', { p_runner_id, p_backends, p_limit })
-- (api/runner/jobs/route.ts) to the 3-arg overload — the pre-lease 0023 body —
-- so claim_expires_at is never stamped and lease-based reclaim (0025/0026) is
-- never engaged on the runner path. Crashed-runner jobs then stay stranded
-- until the 15-minute requeue_stalled_jobs fallback instead of the 60s lease.
--
-- Fix: drop the orphaned overloads so only one signature of each function
-- remains, then re-state the canonical lease-aware bodies verbatim (DROP
-- FUNCTION also drops the grants, so the re-create restores them).

-- ─── drop the orphaned pre-lease overloads ──────────────────────────────
drop function if exists public.claim_next_job_for_runner(uuid, text[], int);
drop function if exists public.claim_next_job(int);

-- ─── claim_next_job (cron side) — restate the 0025 2-arg body ────────────
create or replace function claim_next_job(
  p_limit int default 1,
  p_lease_seconds int default 60
)
returns setof jobs
language sql
as $$
  update jobs
     set status = 'claimed',
         claimed_by_runner = null,
         claim_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = attempts + 1,
         updated_at = now()
   where id in (
     select id
       from jobs
      where status = 'queued'
        and scheduled_at <= now()
        and (required_backend is null or required_backend = 'anthropic-api')
      order by priority desc, scheduled_at asc
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

-- ─── claim_next_job_for_runner — restate the 0026 4-arg body ─────────────
-- Lease-aware (0025) + soft affinity (0026). Identical to the 0026 definition.
create or replace function claim_next_job_for_runner(
  p_runner_id uuid,
  p_backends  text[],
  p_limit     int default 1,
  p_lease_seconds int default 60
)
returns setof jobs
language plpgsql
as $$
declare
  v_now timestamptz := now();
begin
  return query
  update jobs
     set status            = 'claimed',
         claimed_by_runner = p_runner_id,
         claim_expires_at  = v_now + make_interval(secs => p_lease_seconds),
         attempts          = attempts + 1,
         updated_at        = v_now
   where id in (
     select id
       from jobs
      where status = 'queued'
        and scheduled_at <= v_now
        and kind <> 'label-analysis'
        and (required_backend is null or required_backend = any(p_backends))
        and (
          -- this runner is the preferred one (affinity match)
          preferred_runner_id = p_runner_id
          -- or no preference set
          or preferred_runner_id is null
          -- or the soft-affinity window has expired (fallback)
          or preferred_until is null
          or preferred_until <= v_now
        )
      order by
        -- prioritize affinity matches over fallback matches
        case when preferred_runner_id = p_runner_id then 0 else 1 end,
        priority desc,
        scheduled_at asc
      limit p_limit
      for update skip locked
   )
  returning *;
end;
$$;

-- ─── grants (DROP FUNCTION cleared the old ones) ────────────────────────
grant execute on function claim_next_job(int, int)                          to anon, authenticated, service_role;
grant execute on function claim_next_job_for_runner(uuid, text[], int, int) to anon, authenticated, service_role;
