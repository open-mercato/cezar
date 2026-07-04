'use client';

import { useActionState, useState, useTransition } from 'react';
import { cn } from '@/components/ui/cn';
import { saveAutomationToggles, type SaveAutomationState } from './automation-actions';
import { generateDigestsNow } from '@/app/inbox/sync-action';
import type { DigestMode } from '@/lib/supabase/types';

const SYNC_INTERVAL_OPTIONS = [5, 15, 30, 60, 120, 360] as const;
const DIGEST_INTERVAL_OPTIONS = [15, 30, 60, 120, 360] as const;

function formatInterval(min: number): string {
  if (min < 60) return `Every ${min} minutes`;
  const hours = min / 60;
  return `Every ${hours} hour${hours === 1 ? '' : 's'}`;
}

interface AutomationSectionProps {
  autoTriageEnabled: boolean;
  autofixEnabled: boolean;
  separateCommentPerStep: boolean;
  actionAutoComment: boolean;
  syncMode: 'auto' | 'manual';
  syncIntervalMinutes: number;
  digestMode: DigestMode;
  digestIntervalMinutes: number;
  readOnly: boolean;
}

export function AutomationSection({
  autoTriageEnabled,
  autofixEnabled,
  separateCommentPerStep,
  actionAutoComment,
  syncMode,
  syncIntervalMinutes,
  digestMode,
  digestIntervalMinutes,
  readOnly,
}: AutomationSectionProps) {
  const [state, formAction, pending] = useActionState<SaveAutomationState, FormData>(
    saveAutomationToggles,
    {},
  );
  const [autofix, setAutofix] = useState(autofixEnabled);
  const [syncAuto, setSyncAuto] = useState(syncMode === 'auto');
  const [digest, setDigest] = useState<DigestMode>(digestMode);
  const [genPending, startGen] = useTransition();
  const [genMsg, setGenMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  function onGenerateDigests() {
    setGenMsg(null);
    startGen(async () => {
      const res = await generateDigestsNow();
      setGenMsg(
        res.ok
          ? { tone: 'ok', text: 'Generating digests… watch the sync indicator for progress.' }
          : { tone: 'error', text: res.error ?? 'Failed to start' },
      );
    });
  }

  return (
    <form action={formAction} className="space-y-4">
      {state.ok && <Banner tone="ok">Automation settings saved.</Banner>}
      {state.error && <Banner tone="error">{state.error}</Banner>}

      <Toggle
        name="autoTriageEnabled"
        label="Auto-triage new issues"
        hint="When a GitHub issue is opened (or its title/body edited), Cezar runs the triage workflow — classifies it, sets a priority, applies labels, and posts a summary comment."
        defaultChecked={autoTriageEnabled}
        readOnly={readOnly}
      />

      <Toggle
        name="autofixEnabled"
        label="Auto-fix triaged bugs"
        hint="When on, Cezar opens a draft PR automatically on triaged bugs that clear the confidence threshold (config: autofix.minBugConfidence). PRs are always opened as drafts."
        defaultChecked={autofixEnabled}
        readOnly={readOnly}
        onChange={setAutofix}
      />

      {autofix && !autofixEnabled && (
        <Banner tone="warn">
          With auto-fix on, Cezar will open draft PRs without a human in the loop (only on bugs
          above the confidence threshold). Review the draft before merging.
        </Banner>
      )}

      <Toggle
        name="separateCommentPerStep"
        label="One comment per workflow step"
        hint="Off (default): a single living comment is edited as the run progresses. On: each step posts its own comment."
        defaultChecked={separateCommentPerStep}
        readOnly={readOnly}
      />

      <Toggle
        name="actionAutoComment"
        label="Auto-comment on actions"
        hint="Cezar leaves a short summary comment on the issue or PR after each action runs, explaining what it did and why. Skipped when the action already posted its own comment."
        defaultChecked={actionAutoComment}
        readOnly={readOnly}
      />

      <Toggle
        name="syncAuto"
        label="Automatic sync"
        hint="On (default): Cezar pulls issues and pull requests from GitHub on a schedule. Off (manual): the workspace syncs only when an admin clicks the sync indicator in the header."
        defaultChecked={syncAuto}
        readOnly={readOnly}
        onChange={setSyncAuto}
      />

      {syncAuto && (
        <label
          className={cn(
            'flex items-start gap-3 rounded-md border border-outline-variant bg-surface-container/40 p-4 transition-colors',
            readOnly ? 'opacity-70' : 'hover:border-outline',
          )}
        >
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm font-medium text-on-surface">Sync frequency</span>
            <span className="block text-xs leading-relaxed text-on-surface-variant">
              How often Cezar auto-syncs from GitHub. The minimum gap between automatic syncs — the
              cron checks every 5 minutes, so faster than that has no effect.
            </span>
          </span>
          <select
            name="syncIntervalMinutes"
            defaultValue={String(syncIntervalMinutes)}
            disabled={readOnly}
            className="mt-1 h-9 shrink-0 rounded-md border border-outline-variant bg-surface px-2 text-base text-on-surface focus:border-primary focus:outline-none disabled:opacity-70 lg:text-sm"
          >
            {(SYNC_INTERVAL_OPTIONS.includes(
              syncIntervalMinutes as (typeof SYNC_INTERVAL_OPTIONS)[number],
            )
              ? SYNC_INTERVAL_OPTIONS
              : [syncIntervalMinutes, ...SYNC_INTERVAL_OPTIONS]
            ).map((min) => (
              <option key={min} value={min}>
                {formatInterval(min)}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* ── AI digests (spec §5): a separate cadence from metadata sync, since
          digests are the only LLM spend. Metadata stays on the sync schedule. ── */}
      <div className="space-y-4 rounded-md border border-outline-variant bg-surface-container/40 p-4">
        <div className="space-y-1">
          <span className="block text-sm font-medium text-on-surface">AI digests</span>
          <span className="block text-xs leading-relaxed text-on-surface-variant">
            Digests are AI-generated issue summaries (uses your Anthropic key). They&rsquo;re the
            only LLM spend in a sync, so they have their own cadence — metadata sync (issues, PRs,
            comments) stays on your sync schedule regardless.{' '}
            <span className="font-medium">Auto</span> digests on their own slower schedule,{' '}
            <span className="font-medium">On-demand</span> only when you click below,{' '}
            <span className="font-medium">Off</span> never (the inbox shows raw issue titles).
          </span>
        </div>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-on-surface">Mode</span>
          <select
            name="digestMode"
            value={digest}
            onChange={(e) => setDigest(e.target.value as DigestMode)}
            disabled={readOnly}
            className="h-9 shrink-0 rounded-md border border-outline-variant bg-surface px-2 text-base text-on-surface focus:border-primary focus:outline-none disabled:opacity-70 lg:text-sm"
          >
            <option value="auto">Auto</option>
            <option value="manual">On-demand</option>
            <option value="off">Off</option>
          </select>
        </label>

        {digest === 'auto' && (
          <label className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block text-sm text-on-surface">Digest frequency</span>
              <span className="block text-xs leading-relaxed text-on-surface-variant">
                How often Cezar generates digests during a sync. Metadata still syncs on every sync;
                digests only run once this much time has passed.
              </span>
            </span>
            <select
              name="digestIntervalMinutes"
              defaultValue={String(digestIntervalMinutes)}
              disabled={readOnly}
              className="h-9 shrink-0 rounded-md border border-outline-variant bg-surface px-2 text-base text-on-surface focus:border-primary focus:outline-none disabled:opacity-70 lg:text-sm"
            >
              {(DIGEST_INTERVAL_OPTIONS.includes(
                digestIntervalMinutes as (typeof DIGEST_INTERVAL_OPTIONS)[number],
              )
                ? DIGEST_INTERVAL_OPTIONS
                : [digestIntervalMinutes, ...DIGEST_INTERVAL_OPTIONS]
              ).map((min) => (
                <option key={min} value={min}>
                  {formatInterval(min)}
                </option>
              ))}
            </select>
          </label>
        )}

        {!readOnly && (
          <div className="space-y-2 border-t border-outline-variant pt-3">
            {genMsg && <Banner tone={genMsg.tone}>{genMsg.text}</Banner>}
            <button
              type="button"
              onClick={onGenerateDigests}
              disabled={genPending}
              className="inline-flex h-9 items-center rounded-md border border-outline-variant bg-surface px-4 text-sm font-medium text-on-surface transition-colors hover:border-outline disabled:cursor-not-allowed disabled:opacity-50"
            >
              {genPending ? 'Starting…' : 'Generate digests now'}
            </button>
            <span className="block text-xs text-on-surface-variant">
              Runs a digest pass immediately, regardless of mode. Useful for On-demand / Off
              workspaces.
            </span>
          </div>
        )}
      </div>

      {!readOnly && (
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save automation settings'}
          </button>
        </div>
      )}
    </form>
  );
}

function Toggle({
  name,
  label,
  hint,
  defaultChecked,
  readOnly,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked: boolean;
  readOnly: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-md border border-outline-variant bg-surface-container/40 p-4 transition-colors',
        readOnly ? 'opacity-70' : 'hover:border-outline',
      )}
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        disabled={readOnly}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-1 h-4 w-4 accent-primary"
      />
      <span className="min-w-0 space-y-1">
        <span className="block text-sm font-medium text-on-surface">{label}</span>
        <span className="block text-xs leading-relaxed text-on-surface-variant">{hint}</span>
      </span>
    </label>
  );
}

function Banner({ tone, children }: { tone: 'ok' | 'error' | 'warn'; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : tone === 'warn'
        ? 'border-tertiary/40 bg-tertiary/10 text-tertiary'
        : 'border-error/40 bg-error/10 text-error';
  return (
    <div className={cn('rounded-md border px-3 py-2 text-sm', cls)} role="status">
      {children}
    </div>
  );
}
