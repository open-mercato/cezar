'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { cn } from '@/components/ui/cn';
import {
  FileIcon,
  PlayIcon,
  CheckIcon,
  RotateLeftIcon,
  PlusIcon,
  SparkleSmallIcon,
  CodeIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
} from '@/components/icons';
import { useRouter } from 'next/navigation';
import {
  saveSkillOverride,
  autosaveSkillOverrideBody,
  setSkillOverrideEnabled,
  deleteSkillOverride,
  type OverridePayload,
} from './override-actions';
import { autosaveUploadedSkillBody, deleteUploadedSkill } from './uploaded-actions';
import { refreshSkillsShSkillByName, removeSkillsShSkillByName } from './skills-sh-actions';

export interface SkillDetail {
  name: string;
  description: string | null;
  path: string;
  body: string | null;
  upstreamBody: string | null;
  source: 'override' | 'repo' | 'built-in' | 'disk' | 'skills-sh';
  enabled: boolean;
  overrideUpdatedAt: string | null;
  metadata: {
    executionMode: string;
    triggers: string[];
    outputs: string[];
    capabilities: string[];
  };
  stages: string[];
  bindings: Array<{
    stepId: string;
    backend: 'anthropic-api' | 'claude-cli' | 'codex-cli' | null;
    model: string | null;
    extraTools: string[];
  }>;
  commitSha: string | null;
  fetchedAt: string | null;
  testIssues: Array<{ number: number; title: string }>;
}

interface Props {
  skill: SkillDetail;
  readOnly: boolean;
}

const EXECUTION_MODES = [
  { value: 'continuous', label: 'Continuous Analysis' },
  { value: 'one-shot', label: 'One-Shot' },
  { value: 'review-loop', label: 'Review Loop' },
];

const TRIGGER_CONDITIONS = [
  { id: 'issue-created', label: 'Issue Created' },
  { id: 'label-added', label: 'Label Added' },
  { id: 'comment-posted', label: 'Comment Posted' },
  { id: 'check-failed', label: 'CI Check Failed' },
];

const CAPABILITIES = [
  { id: 'reasoning', label: 'REASONING', icon: <SparkleSmallIcon className="h-4 w-4" /> },
  { id: 'synthesis', label: 'SYNTHESIS', icon: <CodeIcon className="h-4 w-4" /> },
] as const;

const AUTOSAVE_DEBOUNCE_MS = 800;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function SkillDetailView({ skill, readOnly }: Props) {
  // Issue #262 (PR 3) — disk-uploaded skills edit their body directly in
  // `uploaded_skills`, so they bypass the "fork upstream → override" handshake
  // entirely. `isDisk` toggles those branches throughout the component.
  const isDisk = skill.source === 'disk';
  // Issue #262 (PR 4) — skills.sh imports are read-only mirrors of the
  // remote registry; we expose Refresh + Remove instead of any save handshake.
  const isSkillsSh = skill.source === 'skills-sh';
  // Disk + skills.sh skills have no metadata save path — execution-mode /
  // triggers / outputs / capabilities are derived from upstream (uploaded
  // file's frontmatter or the registry payload). Lock the controls so the
  // user can't dirty state that has nowhere to land.
  const metaReadOnly = readOnly || isDisk || isSkillsSh;
  const router = useRouter();
  const [executionMode, setExecutionMode] = useState(skill.metadata.executionMode);
  const [triggers, setTriggers] = useState<Set<string>>(() => new Set(skill.metadata.triggers));
  const [outputs, setOutputs] = useState<string[]>(skill.metadata.outputs);
  const [newOutput, setNewOutput] = useState('');
  const [capabilities, setCapabilities] = useState<Set<string>>(
    () => new Set(skill.metadata.capabilities),
  );
  const [body, setBody] = useState(skill.body ?? '');
  const [bodyDirty, setBodyDirty] = useState(false);
  const [metaDirty, setMetaDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(skill.enabled);
  const [overrideUpdatedAt, setOverrideUpdatedAt] = useState<string | null>(
    skill.overrideUpdatedAt,
  );
  const [hasOverride, setHasOverride] = useState(skill.source === 'override');
  const [, startTransition] = useTransition();

  // Simulation pane state.
  const [selectedIssue, setSelectedIssue] = useState<number | null>(
    skill.testIssues.length > 0 ? skill.testIssues[0].number : null,
  );
  const [simRunning, setSimRunning] = useState(false);
  const [simOutput, setSimOutput] = useState<string>('');

  // Reset when navigating between skills (server-rendered name/body changes).
  useEffect(() => {
    setExecutionMode(skill.metadata.executionMode);
    setTriggers(new Set(skill.metadata.triggers));
    setOutputs(skill.metadata.outputs);
    setCapabilities(new Set(skill.metadata.capabilities));
    setBody(skill.body ?? '');
    setBodyDirty(false);
    setMetaDirty(false);
    setSaveState('idle');
    setSaveError(null);
    setEnabled(skill.enabled);
    setOverrideUpdatedAt(skill.overrideUpdatedAt);
    setHasOverride(skill.source === 'override');
  }, [
    skill.name,
    skill.body,
    skill.enabled,
    skill.overrideUpdatedAt,
    skill.source,
    skill.metadata.executionMode,
    skill.metadata.triggers,
    skill.metadata.outputs,
    skill.metadata.capabilities,
  ]);

  // Debounced body autosave. For overrides, only runs once an override already
  // exists — editing an upstream (repo/built-in) skill must NOT silently fork
  // it on the first keystroke. For disk uploads, the skill *is* the canonical
  // version, so we autosave from the first keystroke.
  const bodyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!bodyDirty || readOnly) return;
    if (isSkillsSh) return; // skills.sh imports are read-only mirrors.
    if (!isDisk && !hasOverride) return;
    if (bodyTimerRef.current) clearTimeout(bodyTimerRef.current);
    bodyTimerRef.current = setTimeout(async () => {
      setSaveState('saving');
      const result = isDisk
        ? await autosaveUploadedSkillBody(skill.name, body)
        : await autosaveSkillOverrideBody(skill.name, body);
      if (result.ok) {
        setSaveState('saved');
        setSaveError(null);
        setBodyDirty(false);
        if (result.updatedAt) setOverrideUpdatedAt(result.updatedAt);
        if (!isDisk && 'enabled' in result && typeof result.enabled === 'boolean') {
          setEnabled(result.enabled);
        }
      } else {
        setSaveState('error');
        setSaveError(result.error ?? 'Save failed');
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (bodyTimerRef.current) clearTimeout(bodyTimerRef.current);
    };
  }, [body, bodyDirty, readOnly, hasOverride, isDisk, isSkillsSh, skill.name]);

  const buildPayload = useCallback(
    (): OverridePayload => ({
      executionMode,
      triggers: Array.from(triggers),
      outputs,
      capabilities: Array.from(capabilities),
      body,
    }),
    [executionMode, triggers, outputs, capabilities, body],
  );

  async function handleSave(enable: boolean) {
    if (readOnly) return;
    setSaveState('saving');
    const result = await saveSkillOverride(skill.name, buildPayload(), { enable });
    if (result.ok) {
      setSaveState('saved');
      setSaveError(null);
      setBodyDirty(false);
      setMetaDirty(false);
      setHasOverride(true);
      if (typeof result.enabled === 'boolean') setEnabled(result.enabled);
      if (result.updatedAt) setOverrideUpdatedAt(result.updatedAt);
    } else {
      setSaveState('error');
      setSaveError(result.error ?? 'Save failed');
    }
  }

  async function handleDiscard() {
    if (readOnly) return;
    // skills.sh imports — Discard means uninstall. Re-install brings them back.
    if (isSkillsSh) {
      const ok = window.confirm(
        `Remove the skills.sh import "${skill.name}"? Re-install it from /skills to bring it back.`,
      );
      if (!ok) return;
      setSaveState('saving');
      const result = await removeSkillsShSkillByName(skill.name);
      if (result.ok) {
        router.push('/skills');
      } else {
        setSaveState('error');
        setSaveError(result.error ?? 'Could not remove skills.sh import');
      }
      return;
    }
    // Disk uploads have no upstream to fall back to — "Discard" deletes the
    // skill outright (no recovery from this side; user can re-upload).
    if (isDisk) {
      const ok = window.confirm(
        `Delete the uploaded skill "${skill.name}"? You'll need to re-upload it to bring it back.`,
      );
      if (!ok) return;
      setSaveState('saving');
      const result = await deleteUploadedSkill(skill.name);
      if (result.ok) {
        router.push('/skills');
      } else {
        setSaveState('error');
        setSaveError(result.error ?? 'Could not delete uploaded skill');
      }
      return;
    }
    // If we have an override, "Discard" should revert to upstream entirely.
    if (hasOverride) {
      const ok = window.confirm(
        'Delete the override for this skill? The upstream version from the repo will be used again.',
      );
      if (!ok) return;
      setSaveState('saving');
      const result = await deleteSkillOverride(skill.name);
      if (result.ok) {
        setBody(skill.upstreamBody ?? '');
        setExecutionMode('continuous');
        setTriggers(new Set(['issue-created']));
        setOutputs(['stdout.json']);
        setCapabilities(new Set(['reasoning']));
        setHasOverride(false);
        setEnabled(true);
        setOverrideUpdatedAt(null);
        setBodyDirty(false);
        setMetaDirty(false);
        setSaveState('saved');
        setSaveError(null);
      } else {
        setSaveState('error');
        setSaveError(result.error ?? 'Could not delete override');
      }
      return;
    }
    // No override yet — just reset the form.
    setBody(skill.body ?? '');
    setExecutionMode(skill.metadata.executionMode);
    setTriggers(new Set(skill.metadata.triggers));
    setOutputs(skill.metadata.outputs);
    setCapabilities(new Set(skill.metadata.capabilities));
    setBodyDirty(false);
    setMetaDirty(false);
  }

  async function handleToggleEnabled() {
    if (readOnly || !hasOverride) return;
    setSaveState('saving');
    startTransition(async () => {
      const result = await setSkillOverrideEnabled(skill.name, !enabled);
      if (result.ok) {
        setEnabled(result.enabled ?? !enabled);
        setSaveState('saved');
      } else {
        setSaveState('error');
        setSaveError(result.error ?? 'Toggle failed');
      }
    });
  }

  function toggleTrigger(id: string) {
    setTriggers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMetaDirty(true);
  }

  function toggleCapability(id: string) {
    setCapabilities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMetaDirty(true);
  }

  function removeOutput(name: string) {
    setOutputs((prev) => prev.filter((o) => o !== name));
    setMetaDirty(true);
  }

  function addOutput() {
    const v = newOutput.trim();
    if (!v) return;
    if (outputs.includes(v)) {
      setNewOutput('');
      return;
    }
    setOutputs((prev) => [...prev, v]);
    setNewOutput('');
    setMetaDirty(true);
  }

  async function runSimulation() {
    if (selectedIssue === null) return;
    setSimRunning(true);
    setSimOutput('');
    try {
      const resp = await fetch(`/api/skills/${encodeURIComponent(skill.name)}/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issueNumber: selectedIssue, body }),
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        setSimOutput(`Error: ${resp.status} ${text || resp.statusText}`);
        setSimRunning(false);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setSimOutput((prev) => prev + chunk);
      }
    } catch (err) {
      setSimOutput((prev) => prev + `\nError: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSimRunning(false);
    }
  }

  const dirty = bodyDirty || metaDirty;
  const headerBadge: { label: string; tone: 'tertiary' | 'primary' | 'muted' } = isSkillsSh
    ? { label: 'SKILLS.SH · SYNCED', tone: 'tertiary' }
    : isDisk
      ? { label: 'DISK · UPLOADED', tone: 'tertiary' }
      : hasOverride
        ? enabled
          ? { label: 'OVERRIDE · ACTIVE', tone: 'primary' }
          : { label: 'OVERRIDE · DISABLED', tone: 'muted' }
        : { label: 'AI_ASSISTED', tone: 'tertiary' };

  return (
    <div className="flex min-h-[calc(100vh-56px)] flex-col">
      {/* Mobile back affordance (no sidebar on < lg) */}
      <Link
        href="/skills"
        className="flex min-h-11 items-center gap-1 border-b border-outline-variant bg-surface px-4 text-sm text-on-surface-variant hover:text-on-surface lg:hidden"
      >
        <ChevronLeftIcon className="h-4 w-4" />
        Skills
      </Link>
      {/* Page header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant bg-surface px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <nav className="flex items-center gap-2 text-sm text-on-surface-variant">
            <Link href="/skills" className="hover:text-on-surface">
              Skills
            </Link>
            <span aria-hidden>›</span>
            <span className="font-medium text-on-surface">{skill.name}</span>
          </nav>
          <span className="hidden h-5 w-px bg-outline-variant sm:inline-block" aria-hidden />
          <div className="inline-flex items-center gap-2 rounded-md border border-outline-variant bg-surface-container-low px-3 py-1.5 font-mono text-[12px] text-on-surface-variant">
            <FileIcon className="h-4 w-4" />
            <span className="text-on-surface">{skill.path || '(no path)'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasOverride && !readOnly && (
            <button
              type="button"
              onClick={handleToggleEnabled}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors',
                enabled
                  ? 'border-outline-variant bg-surface text-on-surface hover:border-primary'
                  : 'border-tertiary/40 bg-tertiary-container/20 text-tertiary hover:border-tertiary',
              )}
              title={enabled ? 'Disable override (fall back to upstream)' : 'Enable override'}
            >
              {enabled ? 'Disable override' : 'Enable override'}
            </button>
          )}
          <Badge tone={headerBadge.tone}>{headerBadge.label}</Badge>
        </div>
      </header>

      {/* Two-column body */}
      <div className="flex flex-1 flex-col gap-0 lg:grid lg:grid-cols-[360px_1fr]">
        {/* LEFT: Metadata + capabilities */}
        <aside className="border-b border-outline-variant bg-surface-container-low px-5 py-5 lg:border-b-0 lg:border-r">
          <SectionLabel>Metadata Configuration</SectionLabel>

          <Field label="Skill Name">
            <Input value={skill.name} readOnly />
          </Field>

          <Field label="Execution Mode">
            <Select
              value={executionMode}
              onChange={(v) => {
                setExecutionMode(v);
                setMetaDirty(true);
              }}
              disabled={metaReadOnly}
              options={EXECUTION_MODES}
            />
          </Field>

          <Field label="Trigger Condition">
            <div className="rounded-md border border-outline-variant bg-surface">
              {TRIGGER_CONDITIONS.map((t, i) => (
                <label
                  key={t.id}
                  className={cn(
                    'flex cursor-pointer items-center justify-between px-3 py-2 text-sm text-on-surface',
                    i !== 0 && 'border-t border-outline-variant/60',
                    metaReadOnly && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <span>{t.label}</span>
                  <input
                    type="checkbox"
                    checked={triggers.has(t.id)}
                    onChange={() => toggleTrigger(t.id)}
                    disabled={metaReadOnly}
                    className="h-4 w-4 accent-primary"
                  />
                </label>
              ))}
            </div>
          </Field>

          <Field label="Output Configuration">
            <div className="flex flex-col gap-2">
              {outputs.map((o) => (
                <div
                  key={o}
                  className="flex items-center justify-between rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface"
                >
                  <span className="inline-flex items-center gap-2 font-mono text-[13px]">
                    <CodeIcon className="h-4 w-4 text-on-surface-variant" />
                    {o}
                  </span>
                  {!metaReadOnly && (
                    <button
                      type="button"
                      onClick={() => removeOutput(o)}
                      className="text-xs text-on-surface-variant hover:text-error"
                      aria-label={`Remove ${o}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {!metaReadOnly && (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newOutput}
                    onChange={(e) => setNewOutput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addOutput();
                      }
                    }}
                    placeholder="stdout.json, slack:#bugs, …"
                    className="h-9 flex-1 rounded-md border border-dashed border-outline-variant bg-surface px-3 text-base text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none lg:text-sm"
                  />
                  <button
                    type="button"
                    onClick={addOutput}
                    disabled={!newOutput.trim()}
                    className="inline-flex h-9 items-center gap-1 rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <PlusIcon className="h-4 w-4" />
                    Add
                  </button>
                </div>
              )}
            </div>
          </Field>

          <div className="mt-8">
            <SectionLabel>AI Skill Capabilities</SectionLabel>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {CAPABILITIES.map((cap) => {
                const active = capabilities.has(cap.id);
                return (
                  <button
                    key={cap.id}
                    type="button"
                    onClick={() => toggleCapability(cap.id)}
                    disabled={metaReadOnly}
                    className={cn(
                      'flex flex-col items-center justify-center gap-2 rounded-md border bg-surface px-3 py-4 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                      active
                        ? 'border-primary/60 bg-primary-container/15 text-primary'
                        : 'border-outline-variant text-on-surface-variant hover:border-primary hover:text-on-surface',
                    )}
                  >
                    {cap.icon}
                    <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em]">
                      {cap.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {skill.description && (
            <div className="mt-8">
              <SectionLabel>Description</SectionLabel>
              <p className="text-sm leading-relaxed text-on-surface-variant">{skill.description}</p>
            </div>
          )}

          {skill.stages.length > 0 && (
            <div className="mt-6">
              <SectionLabel>Suggested Stages</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {skill.stages.map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center rounded-md border border-outline-variant bg-surface px-2 py-0.5 font-mono text-[11px] text-on-surface-variant"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {overrideUpdatedAt && (
            <p className="mt-6 text-xs text-on-surface-variant">
              Override last saved {new Date(overrideUpdatedAt).toLocaleString()}.
            </p>
          )}
        </aside>

        {/* RIGHT: Instruction workspace */}
        <section className="flex min-h-[420px] flex-col bg-surface">
          <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-5 py-3">
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Instruction Workspace (MD)
            </span>
            <AutosaveBadge state={saveState} dirty={bodyDirty} error={saveError} />
          </div>
          <div className="flex-1 overflow-hidden bg-surface-container-lowest p-0">
            {skill.body === null ? (
              <div className="flex h-full min-h-[300px] items-center justify-center p-6 text-center text-sm text-on-surface-variant">
                <div>
                  <p>
                    No content cached. Run{' '}
                    <Link href="/skills" className="text-primary hover:underline">
                      Sync from repo
                    </Link>{' '}
                    to load this skill&apos;s markdown.
                  </p>
                </div>
              </div>
            ) : (
              <textarea
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setBodyDirty(true);
                  setSaveState('idle');
                }}
                readOnly={readOnly || isSkillsSh}
                spellCheck={false}
                className="block h-full min-h-[240px] w-full resize-none bg-surface-container-lowest p-5 font-mono text-base leading-[20px] text-on-surface focus:outline-none lg:min-h-[420px] lg:text-[13px]"
              />
            )}
          </div>
        </section>
      </div>

      {/* Dry run preview */}
      <section className="border-t border-outline-variant bg-surface-container-low">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant px-6 py-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Dry Run Preview
            </span>
            <IssueSelect
              issues={skill.testIssues}
              value={selectedIssue}
              onChange={setSelectedIssue}
            />
          </div>
          <button
            type="button"
            onClick={runSimulation}
            disabled={simRunning || selectedIssue === null}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlayIcon className="h-4 w-4" />
            {simRunning ? 'Running…' : 'Run Simulation'}
          </button>
        </div>
        <div className="grid gap-0 md:grid-cols-2">
          <div className="border-b border-outline-variant px-6 py-4 md:border-b-0 md:border-r">
            <div className="mb-2 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Resolved System Prompt
            </div>
            <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[18px] text-on-surface-variant">
              {body || '(empty)'}
            </pre>
          </div>
          <div className="px-6 py-4">
            <div className="mb-2 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Simulation Output
            </div>
            <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[18px] text-on-surface-variant">
              {simOutput ||
                (simRunning ? 'Streaming…' : `Select a test issue and click Run Simulation.`)}
            </pre>
          </div>
        </div>
      </section>

      {/* Sticky save footer */}
      <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low px-6 py-3">
        <button
          type="button"
          onClick={handleDiscard}
          disabled={readOnly || (!dirty && !hasOverride && !isDisk && !isSkillsSh)}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSkillsSh
            ? 'Remove import'
            : isDisk
              ? 'Delete uploaded skill'
              : hasOverride
                ? 'Delete override'
                : 'Discard changes'}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {saveError && <span className="text-xs text-error">{saveError}</span>}
          {isSkillsSh && (
            <button
              type="button"
              onClick={async () => {
                setSaveState('saving');
                const result = await refreshSkillsShSkillByName(skill.name);
                if (result.ok) {
                  setSaveState('saved');
                  setSaveError(null);
                  // `revalidatePath` invalidates the server cache, but our
                  // local `body`/`description` state lives in client useState
                  // and won't re-hydrate without an explicit router refresh.
                  // Without this the textarea keeps showing the pre-refresh
                  // snapshot even though the badge says 'saved'.
                  router.refresh();
                } else {
                  setSaveState('error');
                  setSaveError(result.error ?? 'Refresh failed');
                }
              }}
              disabled={readOnly || saveState === 'saving'}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm font-medium text-on-surface transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateLeftIcon className="h-4 w-4" />
              Refresh from skills.sh
            </button>
          )}
          {/* Save handshake only makes sense for repo/built-in skills — disk
              uploads autosave directly into their own table; skills.sh imports
              are read-only mirrors. */}
          {!isDisk && !isSkillsSh && (
            <>
              <button
                type="button"
                onClick={() => handleSave(false)}
                disabled={readOnly || saveState === 'saving'}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm font-medium text-on-surface transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateLeftIcon className="h-4 w-4" />
                Save as override
              </button>
              <button
                type="button"
                onClick={() => handleSave(true)}
                disabled={readOnly || saveState === 'saving'}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckIcon className="h-4 w-4" />
                Save &amp; Enable Skill
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}

function AutosaveBadge({
  state,
  dirty,
  error,
}: {
  state: SaveState;
  dirty: boolean;
  error: string | null;
}) {
  if (state === 'error') return <Badge tone="error">{error ?? 'Save failed'}</Badge>;
  if (state === 'saving') return <Badge tone="muted">Saving…</Badge>;
  if (dirty) return <Badge tone="tertiary">Unsaved</Badge>;
  if (state === 'saved') return <Badge tone="primary">Saved</Badge>;
  return <Badge tone="muted">Auto-saved</Badge>;
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'tertiary' | 'primary' | 'muted' | 'error';
}) {
  const cls =
    tone === 'tertiary'
      ? 'border-tertiary-container/60 bg-tertiary-container/30 text-tertiary'
      : tone === 'primary'
        ? 'border-primary/40 bg-primary-container/20 text-primary'
        : tone === 'error'
          ? 'border-error/40 bg-error-container/30 text-error'
          : 'border-outline-variant bg-surface-container text-on-surface-variant';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2.5 py-1 font-display text-[11px] font-semibold uppercase tracking-[0.05em]',
        cls,
      )}
    >
      {children}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-xs text-on-surface-variant">{label}</div>
      {children}
    </div>
  );
}

function Input({ value, readOnly }: { value: string; readOnly?: boolean }) {
  return (
    <input
      value={value}
      readOnly={readOnly}
      className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-base text-on-surface read-only:opacity-80 focus:border-primary focus:outline-none lg:text-sm"
    />
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 w-full appearance-none rounded-md border border-outline-variant bg-surface px-3 pr-9 text-base text-on-surface focus:border-primary focus:outline-none disabled:opacity-60 lg:text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant" />
    </div>
  );
}

function IssueSelect({
  issues,
  value,
  onChange,
}: {
  issues: Array<{ number: number; title: string }>;
  value: number | null;
  onChange: (n: number | null) => void;
}) {
  if (issues.length === 0) {
    return (
      <span className="inline-flex h-9 items-center rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant">
        No issues to test against
      </span>
    );
  }
  return (
    <div className="relative">
      <select
        value={value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="h-9 appearance-none rounded-md border border-outline-variant bg-surface pl-3 pr-9 text-sm text-on-surface focus:border-primary focus:outline-none"
      >
        {issues.map((i) => (
          <option key={i.number} value={i.number}>
            #{i.number} — {i.title.length > 60 ? i.title.slice(0, 60) + '…' : i.title}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant" />
    </div>
  );
}
