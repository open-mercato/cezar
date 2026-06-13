'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/components/ui/cn';
import { RefreshIcon, PlusIcon } from '@/components/icons';
import {
  addExternalRepoSource,
  refreshExternalRepoSource,
  removeExternalRepoSource,
  updateExternalRepoSource,
  type ActionResult,
} from './external-actions';

/** Issue #262 (PR 2) — props mirror `skill_sources` + `external_repo_skills`. */
export interface ExternalRepoSourceRow {
  id: string;
  name: string;
  owner: string;
  repo: string;
  branch: string;
  folder: string;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  skillCount: number;
}

interface Props {
  sources: ExternalRepoSourceRow[];
  readOnly: boolean;
  /** Externally-controlled open state for the Add modal (drives the
   *  "Add skill source ▾ → Another repo" entry from the page header). */
  addModalOpen: boolean;
  onCloseAddModal: () => void;
}

interface FormValues {
  name: string;
  owner: string;
  repo: string;
  branch: string;
  folder: string;
}

const EMPTY_FORM: FormValues = {
  name: '',
  owner: '',
  repo: '',
  branch: 'main',
  folder: '.ai/skills',
};

export function ExternalSourcesSection({ sources, readOnly, addModalOpen, onCloseAddModal }: Props) {
  const [editing, setEditing] = useState<ExternalRepoSourceRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleSync(id: string) {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      const res = await refreshExternalRepoSource(id);
      setBusyId(null);
      if (!res.ok) setError(res.error);
    });
  }

  function handleRemove(id: string) {
    if (!confirm('Remove this skill source? Cached skills will be discarded.')) return;
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      const res = await removeExternalRepoSource(id);
      setBusyId(null);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <section className="mb-6 rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">External skill sources</h2>
          <p className="mt-0.5 text-xs text-on-surface-variant">
            Pull skills from any GitHub repo. Synced manually — bodies are cached so dispatch
            works without a local clone.
          </p>
        </div>
      </header>

      {error && (
        <div className="mb-3 rounded-md border border-error/30 bg-error-container/30 px-3 py-2 text-xs text-error">
          {error}
        </div>
      )}

      {sources.length === 0 ? (
        <div className="rounded-md border border-dashed border-outline-variant px-3 py-6 text-center text-xs text-on-surface-variant">
          No external sources yet. Use{' '}
          <span className="font-mono text-on-surface">Add skill source → Another repo</span> to add one.
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant/50 rounded-md border border-outline-variant">
          {sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-on-surface">
                  <span className="font-medium">{s.name}</span>
                  <span className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[11px] text-on-surface-variant">
                    {s.owner}/{s.repo}:{s.branch}
                  </span>
                  <span className="font-mono text-[11px] text-on-surface-variant">{s.folder}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-on-surface-variant">
                  {s.skillCount} skill{s.skillCount === 1 ? '' : 's'}
                  {' · '}
                  {s.lastSyncedAt ? `last synced ${formatTimestamp(s.lastSyncedAt)}` : 'never synced'}
                  {s.lastSyncError && (
                    <span className="ml-2 text-amber-300/90">⚠ {s.lastSyncError}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleSync(s.id)}
                  disabled={readOnly || busyId === s.id}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-outline-variant bg-surface-container px-2 text-[11px] font-medium text-on-surface transition-colors hover:border-primary disabled:opacity-50"
                >
                  <RefreshIcon className="h-3 w-3" />
                  {busyId === s.id ? 'Syncing…' : 'Sync'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(s)}
                  disabled={readOnly}
                  className="inline-flex h-7 items-center rounded-md border border-outline-variant bg-surface-container px-2 text-[11px] font-medium text-on-surface transition-colors hover:border-primary disabled:opacity-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(s.id)}
                  disabled={readOnly || busyId === s.id}
                  className="inline-flex h-7 items-center rounded-md border border-error/40 bg-surface-container px-2 text-[11px] font-medium text-error transition-colors hover:bg-error-container/40 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {addModalOpen && (
        <SourceFormModal
          mode="create"
          initial={EMPTY_FORM}
          onClose={onCloseAddModal}
          onSubmit={async (values) => addExternalRepoSource({ name: values.name, config: values })}
          onSuccess={() => {
            onCloseAddModal();
          }}
          onError={setError}
        />
      )}

      {editing && (
        <SourceFormModal
          mode="edit"
          initial={{
            name: editing.name,
            owner: editing.owner,
            repo: editing.repo,
            branch: editing.branch,
            folder: editing.folder,
          }}
          onClose={() => setEditing(null)}
          onSubmit={async (values) =>
            updateExternalRepoSource({
              id: editing.id,
              name: values.name,
              config: values,
            })
          }
          onSuccess={() => setEditing(null)}
          onError={setError}
        />
      )}
    </section>
  );
}

interface ModalProps {
  mode: 'create' | 'edit';
  initial: FormValues;
  onClose: () => void;
  onSubmit: (values: FormValues) => Promise<ActionResult<{ id?: string }>>;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

function SourceFormModal({ mode, initial, onClose, onSubmit, onSuccess, onError }: ModalProps) {
  const [values, setValues] = useState<FormValues>(initial);
  const [submitting, startSubmit] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startSubmit(async () => {
      const res = await onSubmit(values);
      if (res.ok) {
        onSuccess();
      } else {
        onError(res.error);
      }
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'create' ? 'Add external skill source' : 'Edit external skill source'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg border border-outline-variant bg-surface-container p-5 shadow-xl"
      >
        <h2 className="mb-4 text-base font-semibold text-on-surface">
          {mode === 'create' ? 'Add external skill source' : 'Edit external skill source'}
        </h2>
        <div className="grid gap-3">
          <ModalField
            label="Name"
            hint="Friendly slug — letters, digits, `-`, `_`."
            value={values.name}
            onChange={(v) => setValues((p) => ({ ...p, name: v }))}
            placeholder="team-skills"
            disabled={mode === 'edit'} // unique constraint; rename via a follow-up
          />
          <div className="grid grid-cols-2 gap-3">
            <ModalField
              label="Owner"
              value={values.owner}
              onChange={(v) => setValues((p) => ({ ...p, owner: v }))}
              placeholder="open-mercato"
            />
            <ModalField
              label="Repo"
              value={values.repo}
              onChange={(v) => setValues((p) => ({ ...p, repo: v }))}
              placeholder="shared-skills"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ModalField
              label="Branch"
              value={values.branch}
              onChange={(v) => setValues((p) => ({ ...p, branch: v }))}
              placeholder="main"
            />
            <ModalField
              label="Folder"
              value={values.folder}
              onChange={(v) => setValues((p) => ({ ...p, folder: v }))}
              placeholder=".ai/skills"
            />
          </div>
        </div>
        <footer className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface hover:border-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className={cn(
              'h-9 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface',
              submitting && 'opacity-60',
            )}
          >
            {submitting ? 'Saving…' : mode === 'create' ? 'Add' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ModalField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
        {label}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface focus:border-primary focus:outline-none disabled:opacity-60"
      />
      {hint && <p className="mt-1 text-[11px] text-on-surface-variant/80">{hint}</p>}
    </label>
  );
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
