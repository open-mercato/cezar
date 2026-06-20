'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { cn } from '@/components/ui/cn';
import {
  PlayIcon,
  CheckIcon,
  RotateLeftIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  TrashIcon,
  SparkleSmallIcon,
} from '@/components/icons';
import {
  saveAction,
  autosaveActionPrompt,
  setActionEnabled,
  deleteAction,
  setAutoTriage,
  searchSkills,
  type ActionPayload,
  type SkillSuggestion,
} from './action-mutations';
import { AcceptanceSection } from './acceptance-section';
import type { AcceptanceMode, ActionModel, ConfidenceConfig } from './acceptance-types';

export interface ActionDetail {
  id: string;
  name: string;
  kind: 'built-in' | 'user';
  description: string | null;
  systemPrompt: string;
  skillRefs: string[];
  target: 'issue' | 'pr';
  triggers: string[];
  /** null → tool-use mode; array → declared. */
  effects: string[] | null;
  /** JSON-serialized schema (or "" if absent). */
  outputSchema: string;
  enabled: boolean;
  replacesBuiltIn: string | null;
  updatedAt: string | null;
  /** Whether a built-in row with this name still exists (i.e. this is a user override). */
  hasBuiltinShadow: boolean;
  isAutoTriage: boolean;
  testIssues: Array<{ number: number; title: string }>;
  model: ActionModel;
  acceptanceMode: AcceptanceMode;
  confidenceConfig: ConfidenceConfig;
  /** Workflow this action may suggest via the suggest-workflow effect; null = tool not exposed. */
  suggestedFlowId: string | null;
  /** The workspace's workflows (`flows` rows) for the suggested-workflow dropdown. */
  availableFlows: Array<{ id: string; name: string }>;
}

interface Props {
  action: ActionDetail;
  readOnly: boolean;
}

// Only triggers with a real firing path (Phase 4 — trigger honesty). Existing
// rows carrying retired trigger strings keep working; they just never fire.
const ALL_TRIGGERS = ['manual', 'on-issue-opened', 'on-issue-edited', 'on-issue-reopened'] as const;

const ALL_EFFECTS = [
  'label.add',
  'label.remove',
  'label.set',
  'comment',
  'close',
  'assign',
  'link-duplicate',
  'set-priority',
] as const;

const AUTOSAVE_DEBOUNCE_MS = 800;
const SKILL_SEARCH_DEBOUNCE_MS = 200;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function ActionDetailView({ action, readOnly }: Props) {
  const [description, setDescription] = useState(action.description ?? '');
  const [target, setTarget] = useState<'issue' | 'pr'>(action.target);
  const [triggers, setTriggers] = useState<Set<string>>(() => new Set(action.triggers));
  const [skillRefs, setSkillRefs] = useState<string[]>(action.skillRefs);
  const [effectsMode, setEffectsMode] = useState<'declared' | 'tool-use'>(
    action.effects === null ? 'tool-use' : 'declared',
  );
  const [declaredEffects, setDeclaredEffects] = useState<Set<string>>(
    () => new Set(action.effects ?? []),
  );
  const [outputSchema, setOutputSchema] = useState(action.outputSchema);
  const [enabled, setEnabled] = useState(action.enabled);
  const [systemPrompt, setSystemPrompt] = useState(action.systemPrompt);
  const [model, setModel] = useState<ActionModel>(action.model);
  const [acceptanceMode, setAcceptanceMode] = useState<AcceptanceMode>(action.acceptanceMode);
  const [confidenceConfig, setConfidenceConfig] = useState<ConfidenceConfig>(
    action.confidenceConfig,
  );
  const [suggestedFlowId, setSuggestedFlowId] = useState<string | null>(action.suggestedFlowId);
  const [promptDirty, setPromptDirty] = useState(false);
  const [metaDirty, setMetaDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isAutoTriage, setIsAutoTriage] = useState(action.isAutoTriage);
  const [, startTransition] = useTransition();

  const [selectedIssue, setSelectedIssue] = useState<number | null>(
    action.testIssues.length > 0 ? action.testIssues[0].number : null,
  );
  const [simRunning, setSimRunning] = useState(false);
  const [simOutput, setSimOutput] = useState<string>('');

  const [skillQuery, setSkillQuery] = useState('');
  const [skillSuggestions, setSkillSuggestions] = useState<SkillSuggestion[]>([]);
  const [skillBodies, setSkillBodies] = useState<Record<string, string>>({});

  useEffect(() => {
    setDescription(action.description ?? '');
    setTarget(action.target);
    setTriggers(new Set(action.triggers));
    setSkillRefs(action.skillRefs);
    setEffectsMode(action.effects === null ? 'tool-use' : 'declared');
    setDeclaredEffects(new Set(action.effects ?? []));
    setOutputSchema(action.outputSchema);
    setEnabled(action.enabled);
    setSystemPrompt(action.systemPrompt);
    setModel(action.model);
    setAcceptanceMode(action.acceptanceMode);
    setConfidenceConfig(action.confidenceConfig);
    setSuggestedFlowId(action.suggestedFlowId);
    setPromptDirty(false);
    setMetaDirty(false);
    setSaveState('idle');
    setSaveError(null);
    setIsAutoTriage(action.isAutoTriage);
  }, [
    action.id,
    action.description,
    action.target,
    action.triggers,
    action.skillRefs,
    action.effects,
    action.outputSchema,
    action.enabled,
    action.systemPrompt,
    action.isAutoTriage,
    action.model,
    action.acceptanceMode,
    action.confidenceConfig,
    action.suggestedFlowId,
  ]);

  // Lazy skill suggestion fetch — only when the user opens the autocomplete.
  // Debounced so a fast typist doesn't fire one server round-trip per keystroke.
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(async () => {
      const items = await searchSkills(skillQuery);
      if (!cancelled) setSkillSuggestions(items);
    }, SKILL_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [skillQuery]);

  // Debounced prompt autosave. Only active when we can mutate in place — for
  // built-ins, autosave creates a user override on the first edit.
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!promptDirty || readOnly) return;
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    promptTimerRef.current = setTimeout(async () => {
      setSaveState('saving');
      const result = await autosaveActionPrompt(action.name, systemPrompt);
      if (result.ok) {
        setSaveState('saved');
        setSaveError(null);
        setPromptDirty(false);
        if (typeof result.enabled === 'boolean') setEnabled(result.enabled);
      } else {
        setSaveState('error');
        setSaveError(result.error ?? 'Save failed');
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    };
  }, [systemPrompt, promptDirty, readOnly, action.name]);

  const buildPayload = useCallback(
    (): ActionPayload => ({
      description: description.trim() === '' ? null : description.trim(),
      systemPrompt,
      skillRefs,
      target,
      triggers: Array.from(triggers),
      effects: effectsMode === 'declared' ? Array.from(declaredEffects) : null,
      outputSchema: effectsMode === 'declared' ? outputSchema : '',
      model,
      acceptanceMode,
      confidenceConfig,
      suggestedFlowId,
    }),
    [
      description,
      systemPrompt,
      skillRefs,
      target,
      triggers,
      effectsMode,
      declaredEffects,
      outputSchema,
      model,
      acceptanceMode,
      confidenceConfig,
      suggestedFlowId,
    ],
  );

  async function handleSave() {
    if (readOnly) return;
    setSaveState('saving');
    const result = await saveAction(action.name, buildPayload(), { enable: enabled });
    if (result.ok) {
      setSaveState('saved');
      setSaveError(null);
      setPromptDirty(false);
      setMetaDirty(false);
      if (typeof result.enabled === 'boolean') setEnabled(result.enabled);
    } else {
      setSaveState('error');
      setSaveError(result.error ?? 'Save failed');
    }
  }

  async function handleDiscard() {
    setDescription(action.description ?? '');
    setTarget(action.target);
    setTriggers(new Set(action.triggers));
    setSkillRefs(action.skillRefs);
    setEffectsMode(action.effects === null ? 'tool-use' : 'declared');
    setDeclaredEffects(new Set(action.effects ?? []));
    setOutputSchema(action.outputSchema);
    setEnabled(action.enabled);
    setSystemPrompt(action.systemPrompt);
    setModel(action.model);
    setAcceptanceMode(action.acceptanceMode);
    setConfidenceConfig(action.confidenceConfig);
    setSuggestedFlowId(action.suggestedFlowId);
    setPromptDirty(false);
    setMetaDirty(false);
  }

  async function handleToggleEnabled() {
    if (readOnly) return;
    setSaveState('saving');
    startTransition(async () => {
      const result = await setActionEnabled(action.name, !enabled);
      if (result.ok) {
        setEnabled(result.enabled ?? !enabled);
        setSaveState('saved');
      } else {
        setSaveState('error');
        setSaveError(result.error ?? 'Toggle failed');
      }
    });
  }

  async function handleDelete() {
    if (readOnly || action.kind !== 'user') return;
    const ok = window.confirm(
      action.hasBuiltinShadow
        ? 'Delete this override? The original built-in action will be used instead.'
        : 'Delete this action? This cannot be undone.',
    );
    if (!ok) return;
    setSaveState('saving');
    const result = await deleteAction(action.name);
    if (result.ok) {
      window.location.href = '/actions';
    } else {
      setSaveState('error');
      setSaveError(result.error ?? 'Delete failed');
    }
  }

  async function handleSetAutoTriage() {
    if (readOnly || target !== 'issue' || isAutoTriage) return;
    setSaveState('saving');
    const result = await setAutoTriage(action.id);
    if (result.ok) {
      setIsAutoTriage(true);
      setSaveState('saved');
    } else {
      setSaveState('error');
      setSaveError(result.error ?? 'Could not set auto-triage');
    }
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

  function toggleDeclaredEffect(id: string) {
    setDeclaredEffects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMetaDirty(true);
  }

  function addSkillRef(name: string) {
    if (skillRefs.includes(name)) return;
    setSkillRefs((prev) => [...prev, name]);
    setSkillQuery('');
    setMetaDirty(true);
  }

  function removeSkillRef(name: string) {
    setSkillRefs((prev) => prev.filter((s) => s !== name));
    setMetaDirty(true);
  }

  async function runSimulation() {
    if (selectedIssue === null) return;
    setSimRunning(true);
    setSimOutput('');
    try {
      const resp = await fetch(`/api/actions/${encodeURIComponent(action.name)}/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issueNumber: selectedIssue,
          systemPrompt,
          skillRefs,
          effects: effectsMode === 'declared' ? Array.from(declaredEffects) : null,
        }),
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

  const dirty = promptDirty || metaDirty;
  const isBuiltin = action.kind === 'built-in';
  const showOverrideSave = isBuiltin;

  const filteredSuggestions = useMemo(() => {
    const have = new Set(skillRefs);
    return skillSuggestions.filter((s) => !have.has(s.name));
  }, [skillSuggestions, skillRefs]);

  const headerBadge: { label: string; tone: 'tertiary' | 'primary' | 'muted' } = isBuiltin
    ? { label: 'BUILT-IN', tone: 'tertiary' }
    : action.replacesBuiltIn
      ? { label: 'USER OVERRIDE', tone: 'primary' }
      : { label: 'USER', tone: 'primary' };

  return (
    <div className="flex min-h-[calc(100vh-56px)] flex-col">
      <Link
        href="/actions"
        className="flex min-h-11 items-center gap-1 border-b border-outline-variant bg-surface px-4 text-sm text-on-surface-variant hover:text-on-surface lg:hidden"
      >
        <ChevronLeftIcon className="h-4 w-4" />
        Actions
      </Link>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant bg-surface px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <nav className="flex items-center gap-2 text-sm text-on-surface-variant">
            <Link href="/actions" className="hover:text-on-surface">
              Actions
            </Link>
            <span aria-hidden>›</span>
            <span className="font-medium text-on-surface">{action.name}</span>
          </nav>
          <Badge tone={headerBadge.tone}>{headerBadge.label}</Badge>
          {isAutoTriage && <Badge tone="primary">AUTO-TRIAGE</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {target === 'issue' && !readOnly && (
            <button
              type="button"
              onClick={handleSetAutoTriage}
              disabled={isAutoTriage}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors',
                isAutoTriage
                  ? 'cursor-not-allowed border-outline-variant bg-surface-container text-on-surface-variant'
                  : 'border-outline-variant bg-surface text-on-surface hover:border-primary',
              )}
              title={
                isAutoTriage
                  ? 'Already the workspace auto-triage action'
                  : 'Use this as the workspace auto-triage action'
              }
            >
              {isAutoTriage ? 'Auto-triage' : 'Set as auto-triage'}
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={handleToggleEnabled}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors',
                enabled
                  ? 'border-outline-variant bg-surface text-on-surface hover:border-primary'
                  : 'border-tertiary/40 bg-tertiary-container/20 text-tertiary hover:border-tertiary',
              )}
            >
              {enabled ? 'Disable' : 'Enable'}
            </button>
          )}
          {action.kind === 'user' && !readOnly && (
            <button
              type="button"
              onClick={handleDelete}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-outline-variant bg-surface text-on-surface-variant transition-colors hover:border-error hover:text-error"
              title={action.hasBuiltinShadow ? 'Revert to built-in' : 'Delete action'}
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-0 lg:grid lg:grid-cols-[400px_1fr]">
        <aside className="border-b border-outline-variant bg-surface-container-low px-5 py-5 lg:border-b-0 lg:border-r">
          <SectionLabel>Metadata Configuration</SectionLabel>

          <Field label="Name">
            <Input value={action.name} readOnly />
          </Field>

          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setMetaDirty(true);
              }}
              readOnly={readOnly}
              rows={2}
              className="min-h-[60px] w-full resize-y rounded-md border border-outline-variant bg-surface px-3 py-2 text-base text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none lg:text-sm"
              placeholder="One-line description of what this action does."
            />
          </Field>

          <Field label="Target">
            <Select
              value={target}
              onChange={(v) => {
                setTarget(v as 'issue' | 'pr');
                setMetaDirty(true);
              }}
              disabled={readOnly}
              options={[
                { value: 'issue', label: 'Issue' },
                { value: 'pr', label: 'Pull request' },
              ]}
            />
          </Field>

          <Field label="Triggers">
            <div className="rounded-md border border-outline-variant bg-surface">
              {ALL_TRIGGERS.map((t, i) => (
                <label
                  key={t}
                  className={cn(
                    'flex cursor-pointer items-center justify-between px-3 py-2 text-sm text-on-surface',
                    i !== 0 && 'border-t border-outline-variant/60',
                    readOnly && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <span className="font-mono text-[13px]">{t}</span>
                  <input
                    type="checkbox"
                    checked={triggers.has(t)}
                    onChange={() => toggleTrigger(t)}
                    disabled={readOnly}
                    className="h-4 w-4 accent-primary"
                  />
                </label>
              ))}
            </div>
          </Field>

          <Field label="Skill refs">
            <div className="flex flex-col gap-2">
              {skillRefs.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {skillRefs.map((ref) => (
                    <span
                      key={ref}
                      className="inline-flex items-center gap-1 rounded-md border border-outline-variant bg-surface px-2 py-0.5 text-xs text-on-surface"
                    >
                      <SparkleSmallIcon className="h-3 w-3 text-on-surface-variant" />
                      {ref}
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => removeSkillRef(ref)}
                          className="ml-1 text-on-surface-variant hover:text-error"
                          aria-label={`Remove ${ref}`}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {!readOnly && (
                <div className="relative">
                  <input
                    type="text"
                    value={skillQuery}
                    onChange={(e) => setSkillQuery(e.target.value)}
                    placeholder="Search skills to add…"
                    className="h-9 w-full rounded-md border border-dashed border-outline-variant bg-surface px-3 text-base text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none lg:text-sm"
                  />
                  {skillQuery.trim().length > 0 && filteredSuggestions.length > 0 && (
                    <ul className="absolute left-0 right-0 z-10 mt-1 max-h-48 overflow-auto rounded-md border border-outline-variant bg-surface-container shadow-ambient">
                      {filteredSuggestions.slice(0, 8).map((s) => (
                        <li key={s.name}>
                          <button
                            type="button"
                            onClick={() => addSkillRef(s.name)}
                            className="block w-full px-3 py-2 text-left text-sm text-on-surface hover:bg-surface-container-high"
                          >
                            <span className="font-medium">{s.name}</span>
                            {s.description && (
                              <span className="block truncate text-xs text-on-surface-variant">
                                {s.description}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </Field>

          <Field label="Effects mode">
            <div className="flex gap-2">
              <ModeButton
                active={effectsMode === 'declared'}
                onClick={() => {
                  setEffectsMode('declared');
                  setMetaDirty(true);
                }}
                disabled={readOnly}
              >
                Declared
              </ModeButton>
              <ModeButton
                active={effectsMode === 'tool-use'}
                onClick={() => {
                  setEffectsMode('tool-use');
                  setMetaDirty(true);
                }}
                disabled={readOnly}
              >
                Agent tools
              </ModeButton>
            </div>
          </Field>

          {effectsMode === 'declared' ? (
            <>
              <Field label="Declared effects">
                <div className="rounded-md border border-outline-variant bg-surface">
                  {ALL_EFFECTS.map((e, i) => (
                    <label
                      key={e}
                      className={cn(
                        'flex cursor-pointer items-center justify-between px-3 py-2 text-sm text-on-surface',
                        i !== 0 && 'border-t border-outline-variant/60',
                        readOnly && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <span className="font-mono text-[13px]">{e}</span>
                      <input
                        type="checkbox"
                        checked={declaredEffects.has(e)}
                        onChange={() => toggleDeclaredEffect(e)}
                        disabled={readOnly}
                        className="h-4 w-4 accent-primary"
                      />
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="Output schema (JSON)">
                <textarea
                  value={outputSchema}
                  onChange={(e) => {
                    setOutputSchema(e.target.value);
                    setMetaDirty(true);
                  }}
                  readOnly={readOnly}
                  rows={6}
                  spellCheck={false}
                  placeholder='{ "type": "object", "properties": { … } }'
                  className="w-full resize-y rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-base text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none lg:text-[12px]"
                />
              </Field>
            </>
          ) : (
            <p className="mb-4 rounded-md border border-dashed border-outline-variant bg-surface px-3 py-2 text-xs text-on-surface-variant">
              The agent picks effects from the full vocabulary at runtime.
            </p>
          )}

          <Field label="Suggested workflow">
            <Select
              value={suggestedFlowId ?? ''}
              onChange={(v) => {
                setSuggestedFlowId(v === '' ? null : v);
                setMetaDirty(true);
              }}
              disabled={readOnly}
              options={[
                { value: '', label: '— none —' },
                ...action.availableFlows.map((f) => ({ value: f.id, label: f.name })),
              ]}
            />
            <p className="mt-1.5 text-xs text-on-surface-variant">
              When set, the agent can suggest running this workflow on the target (surfaces as a
              &quot;Run workflow&quot; item in the inbox). None = the suggest-workflow tool is not
              exposed.
            </p>
          </Field>

          <Field label="Status">
            <div className="flex gap-2">
              <ModeButton
                active={enabled}
                onClick={() => {
                  setEnabled(true);
                  setMetaDirty(true);
                }}
                disabled={readOnly}
              >
                Enabled
              </ModeButton>
              <ModeButton
                active={!enabled}
                onClick={() => {
                  setEnabled(false);
                  setMetaDirty(true);
                }}
                disabled={readOnly}
              >
                Disabled
              </ModeButton>
            </div>
          </Field>

          {action.replacesBuiltIn && (
            <p className="mt-4 text-xs text-on-surface-variant">
              This user action overrides the built-in{' '}
              <code className="font-mono text-on-surface">{action.replacesBuiltIn}</code>.
            </p>
          )}
          {action.updatedAt && (
            <p className="mt-2 text-xs text-on-surface-variant">
              Last updated {new Date(action.updatedAt).toLocaleString()}.
            </p>
          )}
        </aside>

        <section className="flex min-h-[420px] flex-col bg-surface">
          <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-5 py-3">
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              System Prompt
            </span>
            <AutosaveBadge state={saveState} dirty={promptDirty || metaDirty} error={saveError} />
          </div>
          <div className="flex-1 overflow-hidden bg-surface-container-lowest p-0">
            <textarea
              value={systemPrompt}
              onChange={(e) => {
                setSystemPrompt(e.target.value);
                setPromptDirty(true);
                setSaveState('idle');
              }}
              readOnly={readOnly}
              spellCheck={false}
              className="block h-full min-h-[240px] w-full resize-none bg-surface-container-lowest p-5 font-mono text-base leading-[20px] text-on-surface focus:outline-none lg:min-h-[420px] lg:text-[13px]"
            />
          </div>
        </section>
      </div>

      <AcceptanceSection
        model={model}
        acceptanceMode={acceptanceMode}
        confidenceConfig={confidenceConfig}
        readOnly={readOnly}
        onChange={(next) => {
          setModel(next.model);
          setAcceptanceMode(next.acceptanceMode);
          setConfidenceConfig(next.confidenceConfig);
          setMetaDirty(true);
        }}
      />

      <SkillRefsPreview refs={skillRefs} bodies={skillBodies} setBodies={setSkillBodies} />

      <section className="border-t border-outline-variant bg-surface-container-low">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant px-6 py-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Dry Run Preview
            </span>
            <IssueSelect
              issues={action.testIssues}
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
              {systemPrompt || '(empty)'}
            </pre>
          </div>
          <div className="px-6 py-4">
            <div className="mb-2 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Simulation Output
            </div>
            <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[18px] text-on-surface-variant">
              {simOutput ||
                (simRunning ? 'Streaming…' : 'Select a test issue and click Run Simulation.')}
            </pre>
          </div>
        </div>
      </section>

      <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low px-6 py-3">
        <button
          type="button"
          onClick={handleDiscard}
          disabled={readOnly || !dirty}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          Discard changes
        </button>
        <div className="flex items-center gap-2">
          {saveError && <span className="text-xs text-error">{saveError}</span>}
          <button
            type="button"
            onClick={handleSave}
            disabled={readOnly || saveState === 'saving'}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {showOverrideSave ? (
              <RotateLeftIcon className="h-4 w-4" />
            ) : (
              <CheckIcon className="h-4 w-4" />
            )}
            {showOverrideSave ? 'Save as user override' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

function SkillRefsPreview({
  refs,
  bodies,
  setBodies,
}: {
  refs: string[];
  bodies: Record<string, string>;
  setBodies: (next: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    if (!open && refs.some((r) => bodies[r] === undefined)) {
      setLoading(true);
      try {
        const resp = await fetch(
          `/api/actions/skill-bodies?names=${encodeURIComponent(refs.join(','))}`,
        );
        if (resp.ok) {
          const data = (await resp.json()) as { bodies?: Record<string, string> };
          setBodies({ ...bodies, ...(data.bodies ?? {}) });
        }
      } catch {
        // best-effort; preview is non-critical
      } finally {
        setLoading(false);
      }
    }
    setOpen((v) => !v);
  }

  if (refs.length === 0) return null;

  return (
    <section className="border-t border-outline-variant bg-surface-container-lowest">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center justify-between px-6 py-3 text-left font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant hover:text-on-surface"
      >
        <span>Skill refs preview ({refs.length})</span>
        <ChevronDownIcon className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-outline-variant px-6 py-4">
          {loading && <div className="text-xs text-on-surface-variant">Loading skill bodies…</div>}
          {refs.map((r) => (
            <div key={r} className="rounded-md border border-outline-variant bg-surface p-3">
              <div className="mb-2 font-mono text-[12px] text-on-surface">{r}</div>
              <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[18px] text-on-surface-variant">
                {bodies[r] ?? '(not loaded)'}
              </pre>
            </div>
          ))}
        </div>
      )}
    </section>
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

function ModeButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-9 flex-1 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        active
          ? 'border-primary/60 bg-primary-container/15 text-primary'
          : 'border-outline-variant bg-surface text-on-surface-variant hover:border-primary hover:text-on-surface',
      )}
    >
      {children}
    </button>
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
