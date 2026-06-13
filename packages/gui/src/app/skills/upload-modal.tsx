'use client';

import { useRef, useState, useTransition } from 'react';
import { cn } from '@/components/ui/cn';
import {
  uploadSkillsFromFiles,
  uploadSkillFromText,
  type UploadFailure,
  type UploadFilesSummary,
} from './upload-actions';

interface Props {
  open: boolean;
  onClose: () => void;
}

type TabKey = 'files' | 'text';

interface FileSummary {
  added: number;
  replaced: number;
  failed: UploadFailure[];
}

/**
 * Issue #262 (PR 3) — multi-purpose upload modal. Files tab handles
 * drag-and-drop + click-to-browse for `.md`; Paste tab takes raw markdown
 * with an optional name field for skills without frontmatter.
 */
export function UploadModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<TabKey>('files');
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [filesResult, setFilesResult] = useState<FileSummary | null>(null);
  const [textResult, setTextResult] = useState<{ name: string; replaced: boolean } | null>(null);
  const [submitting, startSubmit] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  function reset() {
    setFiles([]);
    setName('');
    setBody('');
    setError(null);
    setFilesResult(null);
    setTextResult(null);
  }

  function closeAndReset() {
    reset();
    onClose();
  }

  function pickFiles(list: FileList | null | undefined) {
    if (!list) return;
    const incoming = Array.from(list).filter((f) => f.name.toLowerCase().endsWith('.md'));
    if (incoming.length === 0) {
      setError('only .md files are accepted');
      return;
    }
    setError(null);
    setFiles((prev) => [...prev, ...incoming]);
  }

  function handleSubmitFiles(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) {
      setError('add at least one file');
      return;
    }
    setError(null);
    setFilesResult(null);
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    startSubmit(async () => {
      const res = await uploadSkillsFromFiles(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setFilesResult({ added: res.added, replaced: res.replaced, failed: res.failed });
      setFiles([]);
    });
  }

  function handleSubmitText(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTextResult(null);
    startSubmit(async () => {
      const res = await uploadSkillFromText({ name: name || undefined, body });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setTextResult({ name: res.name, replaced: res.replaced });
      setName('');
      setBody('');
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upload skills"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAndReset();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-outline-variant bg-surface-container p-5 shadow-xl">
        <header className="mb-4">
          <h2 className="text-base font-semibold text-on-surface">Upload skills from disk</h2>
          <p className="mt-1 text-xs text-on-surface-variant">
            Drop one or more <code className="font-mono">.md</code> files with YAML frontmatter — or
            paste raw markdown.
          </p>
        </header>

        <div className="mb-4 inline-flex items-center rounded-md border border-outline-variant bg-surface-container-low p-0.5 text-sm">
          {(
            [
              { id: 'files', label: 'Files' },
              { id: 'text', label: 'Paste markdown' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
                setError(null);
              }}
              className={cn(
                'inline-flex h-7 items-center rounded-[5px] px-3 font-medium transition-colors',
                tab === t.id
                  ? 'bg-surface text-on-surface shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface',
              )}
              aria-pressed={tab === t.id}
            >
              {t.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-error/30 bg-error-container/30 px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}

        {tab === 'files' ? (
          <form onSubmit={handleSubmitFiles} className="space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                pickFiles(e.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              className={cn(
                'cursor-pointer rounded-md border border-dashed px-4 py-8 text-center text-sm transition-colors',
                dragOver
                  ? 'border-primary bg-primary-container/30 text-primary'
                  : 'border-outline-variant text-on-surface-variant hover:border-primary hover:bg-surface-container/60',
              )}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
            >
              Drop <code className="font-mono">.md</code> files here, or click to browse.
              <input
                ref={inputRef}
                type="file"
                accept=".md,text/markdown"
                multiple
                hidden
                onChange={(e) => {
                  pickFiles(e.target.files);
                  if (inputRef.current) inputRef.current.value = '';
                }}
              />
            </div>

            {files.length > 0 && (
              <ul className="max-h-40 overflow-auto rounded-md border border-outline-variant divide-y divide-outline-variant/50">
                {files.map((file, idx) => (
                  <li key={`${file.name}-${idx}`} className="flex items-center justify-between px-3 py-2 text-xs">
                    <span className="truncate font-mono text-on-surface">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-on-surface-variant hover:text-error"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {filesResult && (
              <ResultSummary summary={filesResult} />
            )}

            <footer className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeAndReset}
                className="h-9 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface hover:border-primary"
              >
                {filesResult ? 'Close' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={submitting || files.length === 0}
                className={cn(
                  'h-9 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface',
                  (submitting || files.length === 0) && 'opacity-60',
                )}
              >
                {submitting ? 'Uploading…' : `Upload ${files.length || ''}`.trim()}
              </button>
            </footer>
          </form>
        ) : (
          <form onSubmit={handleSubmitText} className="space-y-3">
            <label className="block">
              <div className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
                Name (optional if set in frontmatter)
              </div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill"
                className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface focus:border-primary focus:outline-none"
              />
            </label>
            <label className="block">
              <div className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
                Markdown
              </div>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={'---\nname: my-skill\ndescription: …\ncezar-stages: [bug-detector]\n---\n\n# …'}
                className="mt-1 h-48 w-full rounded-md border border-outline-variant bg-surface p-2 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
              />
            </label>

            {textResult && (
              <div className="rounded-md border border-primary/30 bg-primary-container/20 px-3 py-2 text-xs text-primary">
                {textResult.replaced ? 'Replaced' : 'Added'}{' '}
                <span className="font-mono">{textResult.name}</span>.
              </div>
            )}

            <footer className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeAndReset}
                className="h-9 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface hover:border-primary"
              >
                {textResult ? 'Close' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={submitting || !body.trim()}
                className={cn(
                  'h-9 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface',
                  (submitting || !body.trim()) && 'opacity-60',
                )}
              >
                {submitting ? 'Uploading…' : 'Upload'}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}

function ResultSummary({ summary }: { summary: FileSummary }) {
  return (
    <div className="rounded-md border border-primary/30 bg-primary-container/20 px-3 py-2 text-xs text-primary">
      <div>
        Added: <span className="font-mono">{summary.added}</span> · Replaced:{' '}
        <span className="font-mono">{summary.replaced}</span> · Failed:{' '}
        <span className="font-mono">{summary.failed.length}</span>
      </div>
      {summary.failed.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-amber-300/90">
          {summary.failed.map((f, i) => (
            <li key={i}>
              <span className="font-mono">{f.filename}</span> — {f.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
