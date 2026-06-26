'use client';

import { useTransition, useState } from 'react';
import Link from 'next/link';
import { removeUploadedSkill } from './upload-actions';

export interface UploadedSkillRow {
  name: string;
  description: string | null;
  uploadedAt: string;
  updatedAt: string;
}

interface Props {
  uploaded: UploadedSkillRow[];
  readOnly: boolean;
  onOpenUpload: () => void;
}

/**
 * Issue #262 (PR 3) — list of skills the workspace has uploaded from disk.
 * Sits below the External sources panel on /skills. Mirrors that panel's
 * "list + actions" pattern (`external-sources-section.tsx`).
 */
export function UploadedSkillsSection({ uploaded, readOnly, onOpenUpload }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleRemove(name: string) {
    if (!confirm(`Remove the uploaded skill "${name}"?`)) return;
    setError(null);
    setBusyName(name);
    startTransition(async () => {
      const res = await removeUploadedSkill(name);
      setBusyName(null);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <section className="mb-6 rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">Uploaded skills</h2>
          <p className="mt-0.5 text-xs text-on-surface-variant">
            Skills added by drag-and-drop or pasted markdown. Bodies live in the database — no
            on-disk clone needed.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenUpload}
          disabled={readOnly}
          className="inline-flex h-8 items-center rounded-md border border-outline-variant bg-surface-container px-2 text-xs font-medium text-on-surface transition-colors hover:border-primary disabled:opacity-50"
        >
          Upload
        </button>
      </header>

      {error && (
        <div className="mb-3 rounded-md border border-error/30 bg-error-container/30 px-3 py-2 text-xs text-error">
          {error}
        </div>
      )}

      {uploaded.length === 0 ? (
        <div className="rounded-md border border-dashed border-outline-variant px-3 py-6 text-center text-xs text-on-surface-variant">
          No uploaded skills yet. Use{' '}
          <span className="font-mono text-on-surface">Add skill source → Upload from disk</span> or
          the Upload button above.
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant/50 rounded-md border border-outline-variant">
          {uploaded.map((u) => (
            <li key={u.name} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-on-surface">
                  <Link
                    href={`/skills/${encodeURIComponent(u.name)}`}
                    className="font-medium hover:text-primary"
                  >
                    {u.name}
                  </Link>
                </div>
                {u.description && (
                  <div className="mt-0.5 truncate text-[11px] text-on-surface-variant">
                    {u.description}
                  </div>
                )}
                <div className="mt-0.5 text-[11px] text-on-surface-variant">
                  uploaded {formatTimestamp(u.uploadedAt)}
                  {u.updatedAt !== u.uploadedAt && ` · edited ${formatTimestamp(u.updatedAt)}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(u.name)}
                disabled={readOnly || busyName === u.name}
                className="inline-flex h-7 items-center rounded-md border border-error/40 bg-surface-container px-2 text-[11px] font-medium text-error transition-colors hover:bg-error-container/40 disabled:opacity-50"
              >
                {busyName === u.name ? 'Removing…' : 'Remove'}
              </button>
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
