'use client';

import { useActionState, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { saveWorkspaceConfig, type SaveConfigState } from './actions';
import { SettingsSubsection } from './settings-tabs';
import { PROJECT_ENV_PRESETS, type ProjectEnvPreset } from './project-env-presets';

interface SettingsFormProps {
  config: Record<string, unknown>;
  readOnly: boolean;
}

export function SettingsForm({ config, readOnly }: SettingsFormProps) {
  const [state, formAction, pending] = useActionState<SaveConfigState, FormData>(
    saveWorkspaceConfig,
    {},
  );

  const sync = (config.sync ?? {}) as Record<string, unknown>;
  const autofix = (config.autofix ?? {}) as Record<string, unknown>;
  const models = (autofix.models ?? {}) as Record<string, unknown>;
  const maxTurns = (autofix.maxTurns ?? {}) as Record<string, unknown>;

  return (
    <form action={formAction} className="space-y-8">
      {state.ok && <Banner tone="ok">Settings saved.</Banner>}
      {state.error && <Banner tone="error">{state.error}</Banner>}

      <SettingsSubsection title="Sync">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            name="sync.digestBatchSize"
            label="Digest batch size"
            value={val(sync.digestBatchSize, 20)}
            readOnly={readOnly}
          />
          <NumberField
            name="sync.duplicateBatchSize"
            label="Duplicate batch size"
            value={val(sync.duplicateBatchSize, 30)}
            readOnly={readOnly}
          />
          <RangeField
            name="sync.minDuplicateConfidence"
            label="Min duplicate confidence"
            value={val(sync.minDuplicateConfidence, 0.8)}
            readOnly={readOnly}
          />
          <NumberField
            name="sync.staleDaysThreshold"
            label="Stale days threshold"
            value={val(sync.staleDaysThreshold, 90)}
            readOnly={readOnly}
          />
          <NumberField
            name="sync.staleCloseDays"
            label="Stale close days"
            value={val(sync.staleCloseDays, 14)}
            readOnly={readOnly}
          />
          <Toggle
            name="sync.includeClosed"
            label="Include closed issues"
            checked={!!sync.includeClosed}
            readOnly={readOnly}
          />
        </div>
      </SettingsSubsection>

      <SettingsSubsection title="Autofix">
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle
            name="autofix.enabled"
            label="Autofix enabled"
            checked={!!autofix.enabled}
            readOnly={readOnly}
          />
          <Toggle
            name="autofix.draftPr"
            label="Draft PR"
            checked={autofix.draftPr !== false}
            readOnly={readOnly}
          />
          <TextField
            name="autofix.baseBranch"
            label="Base branch"
            value={str(autofix.baseBranch, 'main')}
            readOnly={readOnly}
          />
          <TextField
            name="autofix.branchPrefix"
            label="Branch prefix"
            value={str(autofix.branchPrefix, 'autofix/cezar-issue-')}
            readOnly={readOnly}
          />
          <NumberField
            name="autofix.maxAttemptsPerIssue"
            label="Max attempts per issue"
            value={val(autofix.maxAttemptsPerIssue, 2)}
            readOnly={readOnly}
          />
          <NumberField
            name="autofix.tokenBudgetPerAttempt"
            label="Token budget per attempt"
            value={val(autofix.tokenBudgetPerAttempt, 250000)}
            readOnly={readOnly}
          />
          <RangeField
            name="autofix.minBugConfidence"
            label="Min bug confidence"
            value={val(autofix.minBugConfidence, 0.7)}
            readOnly={readOnly}
          />
          <RangeField
            name="autofix.minAnalyzerConfidence"
            label="Min analyzer confidence"
            value={val(autofix.minAnalyzerConfidence, 0.5)}
            readOnly={readOnly}
          />
          <RangeField
            name="autofix.autoProceedConfidence"
            label="Auto-proceed at confidence ≥"
            hint="0 = always ask"
            value={val(autofix.autoProceedConfidence, 0)}
            readOnly={readOnly}
          />
          <Toggle
            name="autofix.requireReviewPass"
            label="Require review pass"
            checked={autofix.requireReviewPass !== false}
            readOnly={readOnly}
          />
          <Toggle
            name="autofix.retryOnReviewFailure"
            label="Retry on review failure"
            checked={autofix.retryOnReviewFailure !== false}
            readOnly={readOnly}
          />
          <TextField
            name="autofix.prLabels"
            label="PR labels (comma-separated)"
            value={str((autofix.prLabels as string[] | undefined)?.join(', '), 'cezar-autofix')}
            readOnly={readOnly}
          />
          <TextareaField
            name="autofix.setupCommands"
            label="Setup commands"
            hint="One per line — runs at the start of each attempt before the analyzer."
            value={(autofix.setupCommands as string[] | undefined)?.join('\n') ?? ''}
            readOnly={readOnly}
            placeholder={'yarn install\nyarn migrate'}
          />
        </div>
      </SettingsSubsection>

      <ProjectEnvSection autofix={autofix} readOnly={readOnly} />

      <SettingsSubsection title="Models">
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            name="autofix.models.analyzer"
            label="Analyzer"
            value={str(models.analyzer, 'claude-sonnet-4-6')}
            readOnly={readOnly}
          />
          <TextField
            name="autofix.models.fixer"
            label="Fixer"
            value={str(models.fixer, 'claude-sonnet-4-6')}
            readOnly={readOnly}
          />
          <TextField
            name="autofix.models.reviewer"
            label="Reviewer"
            value={str(models.reviewer, 'claude-haiku-4-5-20251001')}
            readOnly={readOnly}
          />
        </div>
      </SettingsSubsection>

      <SettingsSubsection title="Max turns">
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            name="autofix.maxTurns.analyzer"
            label="Analyzer"
            value={val(maxTurns.analyzer, 15)}
            readOnly={readOnly}
          />
          <NumberField
            name="autofix.maxTurns.fixer"
            label="Fixer"
            value={val(maxTurns.fixer, 30)}
            readOnly={readOnly}
          />
          <NumberField
            name="autofix.maxTurns.reviewer"
            label="Reviewer"
            value={val(maxTurns.reviewer, 10)}
            readOnly={readOnly}
          />
        </div>
      </SettingsSubsection>

      {!readOnly && (
        <div className="flex items-center justify-end gap-3 border-t border-outline-variant/60 pt-5">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </form>
  );
}

// ─── Project environment section (preset-aware) ─────────────────────────

interface ProjectEnvFieldValues {
  kind: string;
  install: string;
  build: string;
  test: string;
  gateOnInstall: boolean;
  gateOnBuild: boolean;
  gateOnTest: boolean;
  composeFile: string;
  composeService: string;
  composeWorkdir: string;
  envVarsText: string;
  devEnabled: boolean;
  devCommand: string;
  devPort: number;
  devReadyPath: string;
  devReadyTimeoutSec: number;
}

function initialProjectEnvValues(autofix: Record<string, unknown>): ProjectEnvFieldValues {
  const projectEnv = (autofix.projectEnv ?? {}) as Record<string, unknown>;
  const compose = (projectEnv.compose ?? {}) as Record<string, unknown>;
  const devServer = (projectEnv.devServer ?? {}) as Record<string, unknown>;
  const envVarsText = Object.entries((projectEnv.envVars ?? {}) as Record<string, string>)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return {
    kind: str(projectEnv.kind, 'auto'),
    install: str(projectEnv.install, ''),
    build: str(projectEnv.build, ''),
    test: str(projectEnv.test, ''),
    gateOnInstall: projectEnv.gateOnInstall !== false,
    gateOnBuild: !!projectEnv.gateOnBuild,
    gateOnTest: projectEnv.gateOnTest !== false,
    composeFile: str(compose.file, ''),
    composeService: str(compose.service, ''),
    composeWorkdir: str(compose.workdir, '/app'),
    envVarsText,
    devEnabled: !!devServer.enabled,
    devCommand: str(devServer.command, ''),
    devPort: val(devServer.port, 0),
    devReadyPath: str(devServer.readyPath, '/'),
    devReadyTimeoutSec: val(devServer.readyTimeoutSec, 60),
  };
}

function presetToFieldValues(preset: ProjectEnvPreset): ProjectEnvFieldValues {
  const v = preset.values;
  return {
    kind: v.kind,
    install: v.install,
    build: v.build,
    test: v.test,
    gateOnInstall: v.gateOnInstall,
    gateOnBuild: v.gateOnBuild,
    gateOnTest: v.gateOnTest,
    composeFile: v.compose.file,
    composeService: v.compose.service,
    composeWorkdir: v.compose.workdir,
    envVarsText: Object.entries(v.envVars)
      .map(([k, val]) => `${k}=${val}`)
      .join('\n'),
    devEnabled: v.devServer.enabled,
    devCommand: v.devServer.command,
    devPort: v.devServer.port,
    devReadyPath: v.devServer.readyPath,
    devReadyTimeoutSec: v.devServer.readyTimeoutSec,
  };
}

function ProjectEnvSection({
  autofix,
  readOnly,
}: {
  autofix: Record<string, unknown>;
  readOnly: boolean;
}) {
  const [values, setValues] = useState<ProjectEnvFieldValues>(() =>
    initialProjectEnvValues(autofix),
  );
  // Remount the field tree on preset apply so uncontrolled inputs pick up the new defaultValue.
  const [resetKey, setResetKey] = useState(0);
  const [selectedPresetId, setSelectedPresetId] = useState('');

  const selectedPreset = PROJECT_ENV_PRESETS.find((p) => p.id === selectedPresetId) ?? null;

  const applyPreset = () => {
    if (!selectedPreset) return;
    setValues(presetToFieldValues(selectedPreset));
    setResetKey((k) => k + 1);
  };

  return (
    <SettingsSubsection title="Project environment">
      <p className="mb-4 text-xs leading-relaxed text-on-surface-variant">
        How Cezar installs deps, builds, and runs tests on the checked-out worktree so the autofix
        loop gets real build/test feedback before opening a PR. <strong>Compose</strong> runs each
        command inside a per-run <code>docker compose</code> project (worktree bind-mounted) and
        requires a self-hosted runner with Docker. <strong>Auto</strong> uses compose when a compose
        file is present, else the host shell. Leave commands blank to skip that check.
      </p>

      {!readOnly && (
        <div className="mb-5 rounded-md border border-outline-variant/60 bg-surface-container-lowest p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full grow sm:min-w-[18rem]">
              <FieldLabel
                htmlFor="projectEnvPreset"
                label="Load preset"
                hint="prefills the fields below — Save to persist"
              />
              <select
                id="projectEnvPreset"
                value={selectedPresetId}
                onChange={(e) => setSelectedPresetId(e.target.value)}
                className={INPUT_BASE}
              >
                <option value="">— none —</option>
                {PROJECT_ENV_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={applyPreset}
              disabled={!selectedPreset}
              className="inline-flex h-9 w-full items-center justify-center rounded-md border border-outline-variant px-4 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:justify-start"
            >
              Apply preset
            </button>
          </div>
          {selectedPreset && (
            <p className="mt-2 text-[11px] leading-relaxed text-on-surface-variant">
              {selectedPreset.description}
            </p>
          )}
        </div>
      )}

      <div key={resetKey}>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            name="autofix.projectEnv.kind"
            label="Environment"
            value={values.kind}
            readOnly={readOnly}
            options={[
              { value: 'auto', label: 'Auto — compose if a compose file exists, else native' },
              { value: 'native', label: 'Native — run commands on the host shell' },
              { value: 'compose', label: 'Compose — run inside docker compose (runner only)' },
            ]}
          />
          <div className="hidden sm:block" />
          <TextField
            name="autofix.projectEnv.install"
            label="Install command"
            value={values.install}
            readOnly={readOnly}
            hint="e.g. yarn install --immutable"
          />
          <TextField
            name="autofix.projectEnv.build"
            label="Build command"
            value={values.build}
            readOnly={readOnly}
            hint="e.g. yarn build"
          />
          <TextField
            name="autofix.projectEnv.test"
            label="Test command"
            value={values.test}
            readOnly={readOnly}
            hint="e.g. yarn test"
          />
          <div className="hidden sm:block" />
          <Toggle
            name="autofix.projectEnv.gateOnInstall"
            label="Gate on install"
            checked={values.gateOnInstall}
            readOnly={readOnly}
          />
          <Toggle
            name="autofix.projectEnv.gateOnBuild"
            label="Gate on build"
            checked={values.gateOnBuild}
            readOnly={readOnly}
          />
          <Toggle
            name="autofix.projectEnv.gateOnTest"
            label="Gate on test"
            checked={values.gateOnTest}
            readOnly={readOnly}
          />
          <div className="hidden sm:block" />
          <TextField
            name="autofix.projectEnv.compose.file"
            label="Compose file"
            value={values.composeFile}
            readOnly={readOnly}
            hint="blank = auto-detect"
          />
          <TextField
            name="autofix.projectEnv.compose.service"
            label="App service"
            value={values.composeService}
            readOnly={readOnly}
            hint="blank = first service"
          />
          <TextField
            name="autofix.projectEnv.compose.workdir"
            label="Bind-mount path"
            value={values.composeWorkdir}
            readOnly={readOnly}
            hint="worktree mounted here in the container"
          />
          <div className="hidden sm:block" />
          <TextareaField
            name="autofix.projectEnv.envVars"
            label="Environment variables"
            hint="One KEY=VALUE per line — injected into every command."
            value={values.envVarsText}
            readOnly={readOnly}
            placeholder={'DATABASE_URL=postgres://localhost/test\nNODE_ENV=test'}
          />
        </div>

        <p className="mb-3 mt-6 text-xs leading-relaxed text-on-surface-variant">
          <strong>Dev server (optional).</strong> Booted once after install so the agent can probe
          the live app with <code>curl</code> while diagnosing and verifying its fix. Native binds
          the port on the host; compose publishes the container port to an ephemeral host port. Torn
          down when the run ends.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle
            name="autofix.projectEnv.devServer.enabled"
            label="Enable dev server"
            checked={values.devEnabled}
            readOnly={readOnly}
          />
          <div className="hidden sm:block" />
          <TextField
            name="autofix.projectEnv.devServer.command"
            label="Command"
            value={values.devCommand}
            readOnly={readOnly}
            hint="native only — e.g. yarn dev. Compose uses the service's own command."
          />
          <NumberField
            name="autofix.projectEnv.devServer.port"
            label="Port"
            value={values.devPort}
            readOnly={readOnly}
            hint="container port (compose) / host port (native)"
          />
          <TextField
            name="autofix.projectEnv.devServer.readyPath"
            label="Ready path"
            value={values.devReadyPath}
            readOnly={readOnly}
            hint="probed until it responds"
          />
          <NumberField
            name="autofix.projectEnv.devServer.readyTimeoutSec"
            label="Ready timeout (s)"
            value={values.devReadyTimeoutSec}
            readOnly={readOnly}
          />
        </div>
      </div>
    </SettingsSubsection>
  );
}

// ─── Form primitives ──────────────────────────────────────────────────

function FieldLabel({ htmlFor, label, hint }: { htmlFor: string; label: string; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block">
      <span className="text-xs font-medium text-on-surface-variant">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-outline">· {hint}</span>}
    </label>
  );
}

const INPUT_BASE =
  'h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-base lg:text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none read-only:opacity-70 disabled:opacity-60';

function TextField({
  name,
  label,
  value,
  readOnly,
  hint,
}: {
  name: string;
  label: string;
  value: string;
  readOnly: boolean;
  hint?: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={name} label={label} hint={hint} />
      <input
        id={name}
        name={name}
        type="text"
        defaultValue={value}
        readOnly={readOnly}
        className={INPUT_BASE}
      />
    </div>
  );
}

function NumberField({
  name,
  label,
  value,
  readOnly,
  hint,
}: {
  name: string;
  label: string;
  value: number;
  readOnly: boolean;
  hint?: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={name} label={label} hint={hint} />
      <input
        id={name}
        name={name}
        type="number"
        defaultValue={value}
        readOnly={readOnly}
        className={INPUT_BASE}
      />
    </div>
  );
}

function RangeField({
  name,
  label,
  value,
  readOnly,
  hint,
}: {
  name: string;
  label: string;
  value: number;
  readOnly: boolean;
  hint?: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={name} label={`${label} (${value})`} hint={hint} />
      <input
        id={name}
        name={name}
        type="number"
        step="0.05"
        min="0"
        max="1"
        defaultValue={value}
        readOnly={readOnly}
        className={INPUT_BASE}
      />
    </div>
  );
}

function TextareaField({
  name,
  label,
  value,
  readOnly,
  placeholder,
  hint,
}: {
  name: string;
  label: string;
  value: string;
  readOnly: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="sm:col-span-2">
      <FieldLabel htmlFor={name} label={label} hint={hint} />
      <textarea
        id={name}
        name={name}
        defaultValue={value}
        readOnly={readOnly}
        placeholder={placeholder}
        rows={4}
        className="block w-full resize-y rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-base leading-[18px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none read-only:opacity-70 lg:text-[12px]"
      />
    </div>
  );
}

function SelectField({
  name,
  label,
  value,
  readOnly,
  options,
}: {
  name: string;
  label: string;
  value: string;
  readOnly: boolean;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="w-full sm:max-w-md">
      <FieldLabel htmlFor={name} label={label} />
      <select id={name} name={name} defaultValue={value} disabled={readOnly} className={INPUT_BASE}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({
  name,
  label,
  checked,
  readOnly,
}: {
  name: string;
  label: string;
  checked: boolean;
  readOnly: boolean;
}) {
  return (
    <label
      className={cn(
        'flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm',
        readOnly ? 'opacity-70' : 'hover:border-outline',
      )}
    >
      <input
        name={name}
        type="checkbox"
        defaultChecked={checked}
        disabled={readOnly}
        className="h-4 w-4 accent-primary"
      />
      <span className="text-on-surface">{label}</span>
    </label>
  );
}

function Banner({ tone, children }: { tone: 'ok' | 'error'; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : 'border-error/40 bg-error/10 text-error';
  return (
    <div className={cn('rounded-md border px-3 py-2 text-sm', cls)} role="status">
      {children}
    </div>
  );
}

function val(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
