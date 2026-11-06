import { describe, expect, it } from 'vitest';
import { harnessCheckUnavailable, harnessFindingHistory, reconcileHarnessFindings } from '@open-mercato/cezar-contract';
import type { HarnessCouncilRecord } from '@open-mercato/cezar-contract';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectHarnessEnvironment } from './review-state.ts';
import { computeGateRegressions } from './runtime.ts';

describe('review finding history', () => {
  const council = (round: number, titles: string[]): HarnessCouncilRecord => ({
    kind: 'implementation', round, verdict: titles.length ? 'request_changes' : 'approve',
    findings: titles.map((title) => ({ title, severity: 'major', by: 'claude' })),
  });
  it('keeps identity across rounds, resolves absent findings, and is replay safe', () => {
    const first = reconcileHarnessFindings([], council(1, ['Missing scoping', 'Missing cache tag']));
    const second = reconcileHarnessFindings(first, council(2, ['Missing cache tag']));
    expect(second[0]?.status).toBe('resolved');
    expect(second[1]).toMatchObject({ id: first[1]?.id, status: 'open', firstRound: 1, lastRound: 2 });
    expect(reconcileHarnessFindings(second, council(2, ['Missing cache tag']))).toEqual(second);
  });
  it('does not resolve evidence when a reviewer failed or the council is incomplete', () => {
    const first = reconcileHarnessFindings([], council(1, ['Missing scoping']));
    expect(reconcileHarnessFindings(first, { ...council(2, []), reviewers: [{ id: 'x', status: 'failed' }] })).toEqual(first);
  });
  it('groups repeated unavailable-check reports without grouping a real isolation test concern', () => {
    const checks = [{ command: 'yarn test', status: 'failed' as const, exitCode: 1, evidence: "Couldn't find the node_modules state file" }];
    const rows = reconcileHarnessFindings([], council(3, ['Configured test gate failed', 'Configured build gate failed', 'Missing isolation test']), checks);
    expect(rows.map((row) => row.status)).toEqual(['environment', 'open']);
    expect(harnessCheckUnavailable(checks[0]!)).toBe(true);
  });
  it('projects closing fixes as awaiting verification instead of claiming they passed', () => {
    const rows = harnessFindingHistory({ councils: [council(3, ['Missing scoping'])], outcome: { status: 'contested' }, phases: [{ id: 'fix-final', status: 'done' }] });
    expect(rows[0]?.status).toBe('fixed-unverified');
  });
  it('keeps a repeated validation command open until every occurrence passes', () => {
    const failed = { command: 'yarn build', status: 'failed' as const, exitCode: 1, evidence: 'Type check failed' };
    const passed = { ...failed, status: 'passed' as const, exitCode: 0, evidence: 'Passed' };
    const first = harnessFindingHistory({ councils: [], outcome: { status: 'blocked' }, validation: [failed, passed] });
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe('open');
    const second = harnessFindingHistory({ findingHistory: first, councils: [], outcome: { status: 'ready' }, validation: [passed, passed] });
    expect(second[0]).toMatchObject({ id: first[0]?.id, status: 'resolved' });
    expect(first[0]?.status).toBe('open');
  });
  it('never tolerates a check that could not execute just because it also failed at baseline', () => {
    const check = { command: 'yarn test', status: 'failed' as const, exitCode: 1, evidence: "Couldn't find the node_modules state file", failureIds: ['same'] };
    expect(computeGateRegressions([check], [{ ...check }])).toMatchObject({ blocking: [{ unavailable: true }], tolerated: [] });
    expect(harnessCheckUnavailable({ status: 'failed', evidence: 'FAIL handles command not found errors correctly' })).toBe(false);
  });
  it('requires a Yarn install state, while non-Node and dependency-free projects keep working', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-readiness-'));
    try {
      expect(inspectHarnessEnvironment(root).status).toBe('ready');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs' } }));
      expect(inspectHarnessEnvironment(root).status).toBe('ready');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.6.0', devDependencies: { vitest: '1' } }));
      mkdirSync(join(root, 'node_modules'));
      expect(inspectHarnessEnvironment(root)).toMatchObject({ status: 'needs-setup', installCommand: 'yarn install --immutable' });
      writeFileSync(join(root, 'node_modules/.yarn-state.yml'), 'state');
      expect(inspectHarnessEnvironment(root).status).toBe('ready');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
