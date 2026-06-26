'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { RefreshIcon } from '@/components/icons';
import { refreshSkillsShSkill, removeSkillsShSkill } from './skills-sh-actions';

export interface SkillsShImportRow {
  id: string;
  name: string;
  sourceSlug: string;
  installUrl: string | null;
  lastSyncedAt: string;
  lastSyncError: string | null;
}

interface Props {
  imports: SkillsShImportRow[];
  readOnly: boolean;
  configured: boolean;
  onOpenInstall: () => void;
}

/**
 * Issue #262 (PR 4) — list of skills.sh imports. Mirrors the layout of the
 * external sources panel (PR 2) and uploaded skills panel (PR 3).
 */
export function SkillsShSection({ imports, readOnly, configured, onOpenInstall }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleRefresh(id: string) {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      const res = await refreshSkillsShSkill(id);
      setBusyId(null);
      if (!res.ok) setError(res.error);
    });
  }

  function handleRemove(id: string, name: string) {
    if (!confirm(`Remove the skills.sh import "${name}"?`)) return;
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      const res = await removeSkillsShSkill(id);
      setBusyId(null);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <section className="mb-6 rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">skills.sh imports</h2>
          <p className="mt-0.5 text-xs text-on-surface-variant">
            Skills installed from the public registry. Refresh pulls a new snapshot when the
            API&apos;s content hash changes.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenInstall}
          disabled={readOnly || !configured}
          className="inline-flex h-8 items-center rounded-md border border-outline-variant bg-surface-container px-2 text-xs font-medium text-on-surface transition-colors hover:border-primary disabled:opacity-50"
          title={!configured ? 'skills.sh requires SKILLS_SH_TOKEN' : undefined}
        >
          Install
        </button>
      </header>

      {!configured && (
        <div className="mb-3 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
          ⚠ Set <code className="font-mono">SKILLS_SH_TOKEN</code> in env to install or refresh
          skills from skills.sh.
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-md border border-error/30 bg-error-container/30 px-3 py-2 text-xs text-error">
          {error}
        </div>
      )}

      {imports.length === 0 ? (
        <div className="rounded-md border border-dashed border-outline-variant px-3 py-6 text-center text-xs text-on-surface-variant">
          No skills.sh imports yet. Use{' '}
          <span className="font-mono text-on-surface">Add skill source → skills.sh registry</span>{' '}
          or the Install button above.
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant/50 rounded-md border border-outline-variant">
          {imports.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-on-surface">
                  <Link
                    href={`/skills/${encodeURIComponent(row.name)}`}
                    className="font-medium hover:text-primary"
                  >
                    {row.name}
                  </Link>
                  <span className="font-mono text-[11px] text-on-surface-variant">
                    {row.sourceSlug}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-on-surface-variant">
                  last synced {formatTimestamp(row.lastSyncedAt)}
                  {row.installUrl && (
                    <>
                      {' · '}
                      <a
                        href={row.installUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-on-surface"
                      >
                        View on skills.sh
                      </a>
                    </>
                  )}
                  {row.lastSyncError && (
                    <span className="ml-2 text-amber-300/90">⚠ {row.lastSyncError}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleRefresh(row.id)}
                  disabled={readOnly || !configured || busyId === row.id}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-outline-variant bg-surface-container px-2 text-[11px] font-medium text-on-surface transition-colors hover:border-primary disabled:opacity-50"
                >
                  <RefreshIcon className="h-3 w-3" />
                  {busyId === row.id ? 'Syncing…' : 'Refresh'}
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(row.id, row.name)}
                  disabled={readOnly || busyId === row.id}
                  className="inline-flex h-7 items-center rounded-md border border-error/40 bg-surface-container px-2 text-[11px] font-medium text-error transition-colors hover:bg-error-container/40 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
