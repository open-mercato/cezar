import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  harnessCheckUnavailable,
  harnessCouncilRecordSchema,
  harnessFindingHistory,
  type HarnessEnvironment,
  type HarnessFindingHistoryRecord,
} from '@open-mercato/cezar-contract';
import { readHarnessFsEntry } from '../fs-read.ts';
import type { HarnessLedger } from './types.ts';

/** Package manager choices come from the project, never a command supplied by a model. */
export function inspectHarnessEnvironment(cwd: string): HarnessEnvironment {
  const ready: HarnessEnvironment = { status: 'ready', detail: 'Project dependencies are available.' };
  if (!existsSync(join(cwd, 'package.json'))) return ready;
  try {
    const file = readHarnessFsEntry(join(cwd, 'package.json'), 1 << 20);
    if (file.kind !== 'file' || !file.content) return { status: 'needs-setup', detail: 'Project package metadata could not be read. Repair it in the task terminal, then retry verification.' };
    const pkg = JSON.parse(file.content.toString('utf8')) as Record<string, unknown>;
    const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
    const manager = /^(npm|yarn|pnpm|bun)@/.exec(declared)?.[1] as HarnessEnvironment['manager']
      ?? (existsSync(join(cwd, 'yarn.lock')) ? 'yarn'
        : existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
          : existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb')) ? 'bun' : 'npm');
    const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces
      : pkg.workspaces && typeof pkg.workspaces === 'object' ? (pkg.workspaces as Record<string, unknown>).packages : undefined;
    const hasDependencies = ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) =>
      pkg[key] && typeof pkg[key] === 'object' && Object.keys(pkg[key] as object).length > 0) || (Array.isArray(workspaces) && workspaces.length > 0);
    if (!hasDependencies) return ready;
    const modernYarn = manager === 'yarn' && (/^yarn@(?:[2-9]|\d{2,})\./.test(declared) || existsSync(join(cwd, '.yarnrc.yml')));
    const installed = modernYarn
      ? ['.pnp.cjs', '.pnp.js', 'node_modules/.yarn-state.yml'].some((path) => existsSync(join(cwd, path)))
      : existsSync(join(cwd, 'node_modules'));
    const installCommand = manager === 'yarn'
      ? `yarn install ${modernYarn ? '--immutable' : '--frozen-lockfile'}`
      : manager === 'pnpm' ? 'pnpm install --frozen-lockfile'
        : manager === 'bun' ? 'bun install --frozen-lockfile'
          : existsSync(join(cwd, 'package-lock.json')) || existsSync(join(cwd, 'npm-shrinkwrap.json')) ? 'npm ci' : 'npm install';
    return {
      status: installed ? 'ready' : 'needs-setup', manager, installCommand,
      detail: installed ? ready.detail : 'Project dependencies are not installed in this task worktree. Checks cannot run yet.',
    };
  } catch {
    return { status: 'needs-setup', detail: 'Project package metadata could not be read. Repair it in the task terminal, then retry verification.' };
  }
}

export function projectedHarnessFindings(ledger: HarnessLedger): HarnessFindingHistoryRecord[] {
  return harnessFindingHistory({
    ...ledger,
    councils: ledger.councils.flatMap((row) => {
      const parsed = harnessCouncilRecordSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }),
  });
}

export function harnessActionRevision(ledger: HarnessLedger): string {
  return createHash('sha256').update(JSON.stringify([
    ledger.outcome, ledger.stage, ledger.councils, ledger.validation,
    ledger.reviewAction, ledger.environment, ledger.pendingMessages,
  ], (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');
}

export function harnessReviewProjection(ledger: HarnessLedger, cwd: string) {
  const current = inspectHarnessEnvironment(cwd);
  const unavailable = ledger.validation.some(harnessCheckUnavailable);
  const environment = ledger.environment && ledger.environment.status !== 'ready' ? ledger.environment
    : unavailable && current.status === 'ready' ? { ...current, status: 'needs-setup' as const, detail: 'Saved project checks could not run. Retry project setup and verification.' }
      : current.status !== 'ready' || ledger.environment ? current : undefined;
  return {
    ...ledger,
    ...(environment ? { environment } : {}),
    findingHistory: projectedHarnessFindings(ledger),
    actionRevision: harnessActionRevision(ledger),
  };
}
