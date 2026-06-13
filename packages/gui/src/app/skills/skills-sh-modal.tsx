'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/components/ui/cn';
import { addSkillsShSkill } from './skills-sh-actions';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Surfaced from the server so we can disable submit when the env-var is missing. */
  configured: boolean;
}

interface SuccessSummary {
  slug: string;
  name: string;
  replaced: boolean;
}

/**
 * Issue #262 (PR 4) — install a skill from skills.sh by pasting its identifier
 * (`source/slug`) or its skills.sh URL. The server action fetches metadata +
 * body in one call and writes them to `skills_sh_skills` with the body inline.
 */
export function SkillsShModal({ open, onClose, configured }: Props) {
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessSummary | null>(null);
  const [submitting, startSubmit] = useTransition();

  if (!open) return null;

  function reset() {
    setIdentifier('');
    setError(null);
    setSuccess(null);
  }

  function closeAndReset() {
    reset();
    onClose();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!configured) {
      setError('skills.sh requires SKILLS_SH_TOKEN in env — ask an admin to configure it.');
      return;
    }
    setError(null);
    setSuccess(null);
    startSubmit(async () => {
      const res = await addSkillsShSkill({ identifier });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSuccess({ slug: res.slug, name: res.name, replaced: res.replaced });
      setIdentifier('');
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Install skill from skills.sh"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAndReset();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg border border-outline-variant bg-surface-container p-5 shadow-xl"
      >
        <header className="mb-4">
          <h2 className="text-base font-semibold text-on-surface">Install from skills.sh</h2>
          <p className="mt-1 text-xs text-on-surface-variant">
            Paste a <code className="font-mono">source/slug</code> identifier (e.g.{' '}
            <code className="font-mono">vercel-labs/skills/find-skills</code>) or the full
            skills.sh URL.
          </p>
        </header>

        {!configured && (
          <div className="mb-3 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
            ⚠ Skills.sh integration is disabled — set <code className="font-mono">SKILLS_SH_TOKEN</code>{' '}
            in the deployment environment.
          </div>
        )}

        {error && (
          <div className="mb-3 rounded-md border border-error/30 bg-error-container/30 px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-3 rounded-md border border-primary/30 bg-primary-container/20 px-3 py-2 text-xs text-primary">
            {success.replaced ? 'Replaced' : 'Installed'}{' '}
            <span className="font-mono">{success.name}</span>{' '}
            <span className="text-on-surface-variant">({success.slug})</span>.
          </div>
        )}

        <label className="block">
          <div className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
            Skill ID or URL
          </div>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="vercel-labs/skills/find-skills"
            disabled={!configured || submitting}
            className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-2 font-mono text-xs text-on-surface focus:border-primary focus:outline-none disabled:opacity-60"
          />
        </label>

        <footer className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={closeAndReset}
            className="h-9 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface hover:border-primary"
          >
            {success ? 'Close' : 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={!configured || submitting || !identifier.trim()}
            className={cn(
              'h-9 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface',
              (!configured || submitting || !identifier.trim()) && 'opacity-60',
            )}
          >
            {submitting ? 'Installing…' : 'Fetch & install'}
          </button>
        </footer>
      </form>
    </div>
  );
}
