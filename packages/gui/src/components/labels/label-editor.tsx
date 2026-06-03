'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LabelAnalysisDraft } from '@/lib/supabase/types';

export interface LabelListEditorProps {
  title: string;
  drafts: LabelAnalysisDraft[];
  onChange: (drafts: LabelAnalysisDraft[]) => void;
  /** Shows under the title; useful for "for issues" / "for PRs" subtext. */
  subtitle?: string;
  /**
   * Called whenever the list's validity changes. `false` means at least one
   * row is blank/whitespace-only or a case-insensitive duplicate of another;
   * parents should disable their Save button while invalid.
   */
  onValidityChange?: (valid: boolean) => void;
}

/** A per-row validation problem, surfaced inline below the name input. */
type RowError = 'blank' | 'duplicate' | null;

/**
 * Validates a list of label drafts row-by-row. Names are NFC-normalised and
 * trimmed before comparison so that visually-identical names (and trailing
 * whitespace) collapse together; duplicate detection is case-insensitive to
 * match GitHub's case-insensitive label semantics. Returns one error slot per
 * input row plus a flag for any mixed-script (Latin + Cyrillic) names, which
 * are a confusable-duplicate hazard but only warned about, not blocked.
 */
function validateDrafts(drafts: LabelAnalysisDraft[]): {
  errors: RowError[];
  mixedScript: boolean[];
} {
  const keys = drafts.map((d) => d.name.normalize('NFC').trim().toLowerCase());
  const seen = new Map<string, number>();
  const errors: RowError[] = drafts.map((_, idx) => {
    const key = keys[idx];
    if (key.length === 0) return 'blank';
    if (seen.has(key)) return 'duplicate';
    seen.set(key, idx);
    return null;
  });
  // A duplicate makes both rows offenders, not just the later one.
  drafts.forEach((_, idx) => {
    if (errors[idx] === null && keys[idx].length > 0) {
      const occurrences = keys.filter((k) => k === keys[idx]).length;
      if (occurrences > 1) errors[idx] = 'duplicate';
    }
  });
  const mixedScript = drafts.map((d) => {
    const n = d.name.normalize('NFC');
    return /\p{Script=Latin}/u.test(n) && /\p{Script=Cyrillic}/u.test(n);
  });
  return { errors, mixedScript };
}

/**
 * Editable list of label drafts. Each row is collapsible; expanded rows
 * expose every field of the draft for editing. The list supports add / remove
 * and validates inline: names are NFC-normalised + trimmed, blank/whitespace-only
 * names and case-insensitive duplicates are flagged per row, and mixed-script
 * names are warned about. `onValidityChange` lets the parent disable Save while
 * any row is invalid, so users don't hit the workspace_labels
 * unique(workspace_id, name, scope) constraint only after submit.
 *
 * Shared between the /workspaces/new wizard and /settings/labels.
 */
export function LabelListEditor({ title, subtitle, drafts, onChange, onValidityChange }: LabelListEditorProps) {
  const { errors, mixedScript } = useMemo(() => validateDrafts(drafts), [drafts]);
  const valid = errors.every((e) => e === null);

  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);

  const update = (idx: number, patch: Partial<LabelAnalysisDraft>): void => {
    onChange(drafts.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };
  const remove = (idx: number): void => {
    onChange(drafts.filter((_, i) => i !== idx));
  };
  const add = (): void => {
    onChange([
      ...drafts,
      {
        name: '',
        color: null,
        description: '',
        when_to_add: '',
        when_to_remove: '',
        add_meaning: '',
        remove_meaning: '',
        exists_on_github: false,
      },
    ]);
  };

  return (
    <section className="rounded-lg border border-outline-variant bg-surface-container-low">
      <header className="flex items-center justify-between border-b border-outline-variant/60 px-5 py-3">
        <div>
          <h3 className="font-display text-[14px] font-semibold text-on-surface">{title}</h3>
          {subtitle && <p className="text-xs text-on-surface-variant">{subtitle}</p>}
        </div>
        <span className="text-xs text-on-surface-variant">{drafts.length} label{drafts.length === 1 ? '' : 's'}</span>
      </header>

      <div className="divide-y divide-outline-variant/60">
        {drafts.length === 0 ? (
          <p className="px-5 py-6 text-sm text-on-surface-variant">No labels in this list yet.</p>
        ) : (
          drafts.map((d, idx) => (
            <LabelRow
              key={`${d.name}-${idx}`}
              draft={d}
              error={errors[idx]}
              mixedScript={mixedScript[idx]}
              onChange={(patch) => update(idx, patch)}
              onRemove={() => remove(idx)}
            />
          ))
        )}
      </div>

      <footer className="border-t border-outline-variant/60 px-5 py-3">
        <button
          type="button"
          onClick={add}
          className="text-xs font-medium text-primary hover:underline"
        >
          + Add label
        </button>
      </footer>
    </section>
  );
}

function LabelRow({
  draft,
  error,
  mixedScript,
  onChange,
  onRemove,
}: {
  draft: LabelAnalysisDraft;
  error: RowError;
  mixedScript: boolean;
  onChange: (patch: Partial<LabelAnalysisDraft>) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState<boolean>(!draft.name);

  return (
    <div className="px-5 py-3">
      <div className="flex items-center gap-3">
        <ColorSwatch hex={draft.color ?? null} />
        <input
          type="text"
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="label-name"
          aria-invalid={error !== null}
          className={`flex-1 rounded-md border bg-bg px-2 py-1 font-mono text-sm text-on-surface focus:outline-none ${
            error !== null
              ? 'border-error focus:border-error'
              : 'border-outline-variant focus:border-primary'
          }`}
        />
        {!draft.exists_on_github && (
          <span className="rounded-md border border-tertiary/40 bg-tertiary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tertiary">
            new
          </span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-on-surface-variant hover:text-on-surface"
        >
          {expanded ? 'Collapse' : 'Edit'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-error hover:underline"
        >
          Remove
        </button>
      </div>

      {error !== null && (
        <p className="ml-7 mt-1 text-xs text-error">
          {error === 'blank'
            ? 'Name is required and cannot be only whitespace.'
            : 'Duplicate name — labels must be unique (case-insensitive).'}
        </p>
      )}

      {error === null && mixedScript && (
        <p className="ml-7 mt-1 text-xs text-tertiary">
          Mixed Latin/Cyrillic characters — this may create a confusable duplicate label on GitHub.
        </p>
      )}

      {!expanded && draft.description && (
        <p className="ml-7 mt-1 line-clamp-1 text-xs text-on-surface-variant">{draft.description}</p>
      )}

      {expanded && (
        <div className="ml-7 mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Color (hex without #)" value={draft.color ?? ''} onChange={(v) => onChange({ color: v || null })} />
          <Field
            label="Description"
            value={draft.description}
            onChange={(v) => onChange({ description: v })}
            placeholder="One-sentence purpose"
          />
          <Field
            label="When to add"
            value={draft.when_to_add}
            onChange={(v) => onChange({ when_to_add: v })}
            placeholder="The concrete trigger conditions"
            multiline
          />
          <Field
            label="When to remove"
            value={draft.when_to_remove}
            onChange={(v) => onChange({ when_to_remove: v })}
            placeholder='e.g. "when the issue is closed" or "never"'
            multiline
          />
          <Field
            label="Add means…"
            value={draft.add_meaning}
            onChange={(v) => onChange({ add_meaning: v })}
            placeholder="Semantic meaning of adding the label"
            multiline
          />
          <Field
            label="Remove means…"
            value={draft.remove_meaning}
            onChange={(v) => onChange({ remove_meaning: v })}
            placeholder="Semantic meaning of removing the label"
            multiline
          />
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-on-surface-variant">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="w-full resize-y rounded-md border border-outline-variant bg-bg px-2 py-1 text-sm text-on-surface focus:border-primary focus:outline-none"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-outline-variant bg-bg px-2 py-1 text-sm text-on-surface focus:border-primary focus:outline-none"
        />
      )}
    </label>
  );
}

function ColorSwatch({ hex }: { hex: string | null }) {
  const valid = hex && /^[0-9a-fA-F]{6}$/.test(hex);
  return (
    <span
      className="h-4 w-4 shrink-0 rounded-sm border border-outline-variant"
      style={valid ? { backgroundColor: `#${hex}` } : { backgroundColor: 'transparent' }}
      title={valid ? `#${hex}` : 'no color'}
    />
  );
}
