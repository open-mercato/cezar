import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './store.ts';

import type { RunRecord } from './store.ts';

/** A minimal pre-#389 record, exactly as an old runs.json holds it — no
 *  titleSummary, no diffStat. Loading it must keep working (additive proof). */
const LEGACY_RUN = {
  id: 'legacy-1',
  title: 'fix the login bug',
  workflow: 'quick-task',
  task: 'fix the login bug',
  status: 'done',
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
};

describe('RunStore — directional usage persistence', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips step checkpoints and complete run aggregates through runs.json', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({
      title: 'metered task',
      workflow: 'quick-task',
      task: 'metered task',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateStep(run.id, 'task', {
      iterations: 1,
      inputTokens: 120,
      outputTokens: 30,
      usageInvocationsStarted: 1,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
      usageTurnsRecorded: 1,
      usageInvocationEpoch: 1,
    });
    expect(store.getRun(run.id)).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    store.flush();

    const reopened = RunStore.open(dataDir).getRun(run.id);
    expect(reopened).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(reopened?.steps[0]).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      usageInvocationsStarted: 1,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
      usageTurnsRecorded: 1,
      usageInvocationEpoch: 1,
    });
  });

  it('keeps aggregates absent for old records and incomplete invocation or turn checkpoints', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([LEGACY_RUN]), 'utf8');
    expect(RunStore.open(dataDir).getRun(LEGACY_RUN.id)?.inputTokens).toBeUndefined();

    const store = RunStore.open(dataDir);
    const run = store.createRun({
      title: 'partial task',
      workflow: 'quick-task',
      task: 'partial task',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateStep(run.id, 'task', {
      iterations: 1,
      inputTokens: 10,
      outputTokens: 2,
      usageInvocationsStarted: 2,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
      usageTurnsRecorded: 1,
    });
    expect(store.getRun(run.id)?.inputTokens).toBeUndefined();
    store.updateStep(run.id, 'task', { usageInvocationsObserved: 2, usageTurnsStarted: 2 });
    expect(store.getRun(run.id)?.inputTokens).toBeUndefined();
  });
});

describe('RunStore — titleSummary + diffStat (#389)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips the new fields through runs.json', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({
      title: 'fix the login bug',
      workflow: 'quick-task',
      task: 'fix the login bug',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateRun(run.id, {
      titleSummary: 'Catch AuthError in the login handler',
      diffStat: { adds: 10, dels: 2, files: 3 },
    });
    store.flush();

    const reopened = RunStore.open(dataDir);
    const loaded = reopened.getRun(run.id);
    expect(loaded?.titleSummary).toBe('Catch AuthError in the login handler');
    expect(loaded?.diffStat).toEqual({ adds: 10, dels: 2, files: 3 });
  });

  it('round-trips the repointed flag, and keeps it absent when it was never set (#751)', () => {
    const store = RunStore.open(dataDir);
    const narrowed = store.createRun({ title: 'review pr 694', workflow: 'quick-task', task: 'review', steps: [] });
    const normal = store.createRun({ title: 'fix the login bug', workflow: 'quick-task', task: 'fix', steps: [] });
    store.updateRun(narrowed.id, { diffStat: { adds: 1, dels: 0, files: 1, repointed: true } });
    store.updateRun(normal.id, { diffStat: { adds: 10, dels: 2, files: 3 } });
    store.flush();

    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(narrowed.id)?.diffStat).toEqual({ adds: 1, dels: 0, files: 1, repointed: true });
    // The un-narrowed shape must survive byte-identically — no `repointed: false`
    // materialized into the record of every task that behaved.
    expect(reopened.getRun(normal.id)?.diffStat).toEqual({ adds: 10, dels: 2, files: 3 });
    expect(reopened.getRun(normal.id)?.diffStat).not.toHaveProperty('repointed');
  });

  it('still loads a pre-#751 diffStat that has no repointed key', () => {
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([{ ...LEGACY_RUN, diffStat: { adds: 4, dels: 1, files: 2 } }]),
      'utf8',
    );
    const run = RunStore.open(dataDir).getRun('legacy-1');
    expect(run?.diffStat).toEqual({ adds: 4, dels: 1, files: 2 });
    expect(run?.diffStat?.repointed).toBeUndefined();
  });

  it('still loads an old runs.json that predates the fields', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([LEGACY_RUN]), 'utf8');
    const store = RunStore.open(dataDir);
    const run = store.getRun('legacy-1');
    expect(run).toBeDefined();
    expect(run?.title).toBe('fix the login bug');
    expect(run?.titleSummary).toBeUndefined();
    expect(run?.diffStat).toBeUndefined();
    expect(run?.generateFollowups).toBeUndefined();
    // Retention field (#483) is additive: a record without it parses and reads undefined.
    expect(run?.worktreeReclaimedAt).toBeUndefined();
  });

  it('round-trips worktreeReclaimedAt and lets updateRun clear it (retention #483)', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.updateRun(run.id, { worktreeReclaimedAt: '2026-07-18T00:00:00.000Z' });
    store.flush();

    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(run.id)?.worktreeReclaimedAt).toBe('2026-07-18T00:00:00.000Z');
    // Re-materialization clears the stamp so retention sees the run again.
    reopened.updateRun(run.id, { worktreeReclaimedAt: undefined });
    reopened.flush();
    expect(RunStore.open(dataDir).getRun(run.id)?.worktreeReclaimedAt).toBeUndefined();
  });

  it("round-trips activity:'monitoring' and lets updateRun clear it (#490)", () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    // A fresh record has no activity (additive/optional).
    expect(run.activity).toBeUndefined();
    store.updateRun(run.id, { status: 'running', activity: 'monitoring' });
    store.flush();

    const reopened = RunStore.open(dataDir, { keepLive: true });
    expect(reopened.getRun(run.id)?.activity).toBe('monitoring');
    // Resume/terminal transitions clear it back to a plain running/other state.
    reopened.updateRun(run.id, { status: 'running', activity: undefined });
    reopened.flush();
    expect(RunStore.open(dataDir, { keepLive: true }).getRun(run.id)?.activity).toBeUndefined();
  });

  it('round-trips the monitoring deadline and clears monitoring state on terminal writes', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 'monitor', task: 'monitor', workflow: 'quick-task', steps: [] });
    const deadline = '2026-07-25T10:15:00.000Z';
    store.updateRun(run.id, { status: 'running', activity: 'monitoring', monitoringWakeAt: deadline });
    expect(store.getRun(run.id)?.monitoringWakeAt).toBe(deadline);
    store.updateRun(run.id, { status: 'done' });
    expect(store.getRun(run.id)).toMatchObject({ status: 'done' });
    expect(store.getRun(run.id)?.activity).toBeUndefined();
    expect(store.getRun(run.id)?.monitoringWakeAt).toBeUndefined();
  });

  it('clears process-local wake-cap display state when records reopen', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 'monitor', task: 'monitor', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'running', activity: 'monitoring', monitoringWakeCapReached: true });
    store.flush();
    const reopened = RunStore.open(dataDir, { keepLive: true }).getRun(run.id);
    expect(reopened?.activity).toBe('monitoring');
    expect(reopened?.monitoringWakeCapReached).toBeUndefined();
  });

  it('salvages a malformed wake deadline and stale terminal monitoring activity', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([{
      ...LEGACY_RUN,
      activity: 'monitoring',
      monitoringWakeAt: 'not-a-date',
    }]), 'utf8');
    const loaded = RunStore.open(dataDir).getRun(LEGACY_RUN.id);
    expect(loaded?.status).toBe('done');
    expect(loaded?.activity).toBeUndefined();
    expect(loaded?.monitoringWakeAt).toBeUndefined();
  });

  it('still loads an old runs.json that predates activity (#490)', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([LEGACY_RUN]), 'utf8');
    const store = RunStore.open(dataDir);
    expect(store.getRun('legacy-1')?.activity).toBeUndefined();
  });

  it('rejects an unknown activity value at the schema boundary (#490)', () => {
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([{ ...LEGACY_RUN, id: 'bad-activity', status: 'running', activity: 'bogus' }]),
      'utf8',
    );
    // A corrupt/unknown activity must not smuggle a run in with an invalid value:
    // the schema drops the bad record (degrade-to-fresh), so it does not load.
    const store = RunStore.open(dataDir);
    expect(store.getRun('bad-activity')?.activity).not.toBe('bogus');
  });

  it('persists an explicit follow-up opt-out while omission stays compatible', () => {
    const store = RunStore.open(dataDir);
    const disabled = store.createRun({
      title: 'quiet task',
      workflow: 'quick-task',
      task: 'quiet task',
      generateFollowups: false,
      steps: [],
    });
    const defaulted = store.createRun({
      title: 'default task',
      workflow: 'quick-task',
      task: 'default task',
      steps: [],
    });
    store.flush();

    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(disabled.id)?.generateFollowups).toBe(false);
    expect(reopened.getRun(defaulted.id)?.generateFollowups).toBeUndefined();
  });

  it('round-trips the autonomous flag while omission stays compatible (#489)', () => {
    const store = RunStore.open(dataDir);
    const autonomous = store.createRun({
      title: 'autonomous task',
      workflow: 'quick-task',
      task: 'autonomous task',
      autonomous: true,
      steps: [],
    });
    const interactive = store.createRun({
      title: 'interactive task',
      workflow: 'quick-task',
      task: 'interactive task',
      steps: [],
    });
    store.flush();

    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(autonomous.id)?.autonomous).toBe(true);
    // Absent = falsy = "not autonomous" — old records and interactive runs alike.
    expect(reopened.getRun(interactive.id)?.autonomous).toBeUndefined();
  });

  it('updateRun fans the new fields out on the run channel (the SSE feed)', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    const seen: Array<{ titleSummary?: string }> = [];
    store.on('run', (r: { titleSummary?: string }) => seen.push({ titleSummary: r.titleSummary }));
    store.updateRun(run.id, { titleSummary: 'A real summary of the turn' });
    expect(seen.at(-1)?.titleSummary).toBe('A real summary of the turn');
  });
});

describe('RunStore — PR auto-link only on real creation (#fake-pr)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const freshRun = () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    return { store, run };
  };

  it('does NOT adopt a PR URL the agent merely reviewed/referenced', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Reviewed https://github.com/open-mercato/cezar/pull/1 — looks good, no changes needed.',
    } as never);
    expect(store.getRun(run.id)?.pullRequestUrl).toBeUndefined();
  });

  it('adopts a PR URL when the agent actually created one', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Opened a draft pull request: https://github.com/open-mercato/cezar/pull/42',
    } as never);
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/42');
  });

  it('recognizes the raw `gh pr create` output form', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: '$ gh pr create --draft\nhttps://github.com/open-mercato/cezar/pull/7',
    } as never);
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/7');
  });

  it('spots creation reported through a v2 tool item (nested under `item`)', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        toolKind: 'execute',
        title: 'Ran gh pr create',
        status: 'completed',
        input: { command: 'gh pr create --draft --title "fix"' },
        output: 'https://github.com/open-mercato/cezar/pull/9',
      },
    });
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/9');
  });

  it('adopts the CREATED PR, not one referenced earlier in the same event (#495)', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'Read the linked PR https://github.com/open-mercato/cezar/pull/1 for context, then ' +
        'opened a draft pull request: https://github.com/open-mercato/cezar/pull/500',
    } as never);
    // The first URL in the text is the referenced one — the created URL wins.
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/500');
  });

  it('falls back to the URL before the phrase when gh prints it first', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'https://github.com/open-mercato/cezar/pull/321\nDraft pull request created.',
    } as never);
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/321');
  });

  // The claim must come from something that can speak FOR this run. Verbatim from the task that
  // wrote this guard: it dumped ANOTHER run's stored events while investigating them, and the
  // dump contained that run's `"title": "Ran gh pr create …"` next to its PR URL — so this run
  // adopted a PR in a different repository as its own, forever (the first created URL wins).
  it('does not believe a creation phrase that arrives inside tool OUTPUT', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        toolKind: 'execute',
        title: 'Ran python3 - <<PY … PY',
        status: 'completed',
        input: { command: 'python3 - <<PY\nprint(open("other-run.ndjson").read())\nPY' },
        output:
          '{"type":"item.completed","item":{"kind":"tool","title":"Ran gh pr create --repo o/other …",' +
          '"output":"https://github.com/o/other/pull/5366"}}',
      },
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.pullRequestUrl).toBeUndefined();
    // Still a PR URL the conversation mentioned, so the referenced tier keeps it as a candidate —
    // that tier is allowed to be wrong about a subject, never about authorship.
    expect(loaded?.referencedPrCandidates).toEqual(['https://github.com/o/other/pull/5366']);
  });

  it('does not believe a creation phrase the agent merely WROTE into a file', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 't2',
        name: 'Edit',
        toolKind: 'edit',
        title: 'packages/cezar/src/runs/store.test.ts',
        status: 'completed',
        input: {
          new_string: "result: 'Opened a draft pull request: https://github.com/open-mercato/cezar/pull/42'",
        },
      },
    });
    expect(store.getRun(run.id)?.pullRequestUrl).toBeUndefined();
  });

  it('still adopts the PR from a real `gh pr create`, whose URL only appears in the output', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 't3',
        name: 'Bash',
        toolKind: 'execute',
        title: 'Ran gh pr create --repo open-mercato/cezar --base main --head cez/x --title "fix…',
        status: 'completed',
        input: { command: 'gh pr create --repo open-mercato/cezar --base main' },
        output: 'https://github.com/open-mercato/cezar/pull/901',
      },
    });
    expect(store.getRun(run.id)?.pullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/901',
    );
  });
});

describe('RunStore — secret redaction before persistence (#427)', () => {
  let dataDir: string;
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, CEZ_REDACT_SECRETS: process.env.CEZ_REDACT_SECRETS };
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const eventsFile = (dir: string, id: string) => readFileSync(join(dir, 'runs', `${id}.ndjson`), 'utf8');

  it('scrubs a host secret value from the NDJSON transcript', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, {
      type: 'tool-result',
      result: 'printenv output: GITHUB_TOKEN=gho_thisisarealsecrettoken123456',
    } as never);
    const raw = eventsFile(dataDir, run.id);
    expect(raw).not.toContain('gho_thisisarealsecrettoken123456');
    expect(raw).toContain('[REDACTED]');
  });

  it('scrubs a token shape even when it never lived in cezar’s env', () => {
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, {
      type: 'tool-result',
      result: 'cat ~/.aws: AKIAIOSFODNN7EXAMPLE and sk-ant-api03-abcdefghijklmnopqrst',
    } as never);
    const raw = eventsFile(dataDir, run.id);
    expect(raw).not.toMatch(/AKIA|sk-ant/);
  });

  it('CEZ_REDACT_SECRETS=0 opts out (escape hatch)', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    process.env.CEZ_REDACT_SECRETS = '0';
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, {
      type: 'tool-result',
      result: 'GITHUB_TOKEN=gho_thisisarealsecrettoken123456',
    } as never);
    expect(eventsFile(dataDir, run.id)).toContain('gho_thisisarealsecrettoken123456');
  });

  /**
   * #427 review: redaction reached the NDJSON but not runs.json. `titleSummary`
   * is derived from the RAW first agent turn and `error` from raw process
   * output, so a token the agent echoed was `[REDACTED]` in the transcript and
   * verbatim in the file the "no secrets in state files" rule names explicitly.
   */
  it('scrubs a host secret from titleSummary and error before runs.json is written', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.updateRun(run.id, {
      titleSummary: 'Set GITHUB_TOKEN=gho_thisisarealsecrettoken123456 in CI',
      error: 'auth failed for gho_thisisarealsecrettoken123456',
    });
    store.flush();

    expect(store.getRun(run.id)?.error).toBe('auth failed for [REDACTED]');
    const raw = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    expect(raw).not.toContain('gho_thisisarealsecrettoken123456');
    expect(raw).toContain('[REDACTED]');
    // …and it survives the round-trip scrubbed (reopening rewrites `error` on
    // an unfinished run — the raw-file assertion above is what covers it).
    expect(RunStore.open(dataDir).getRun(run.id)?.titleSummary).toBe('Set GITHUB_TOKEN=[REDACTED] in CI');
  });

  it('scrubs a token shape from a user-supplied title too', () => {
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.updateRun(run.id, { title: 'rotate ghp_0123456789abcdefghijABCDEFGHIJ0123' });
    expect(store.getRun(run.id)?.title).toBe('rotate [REDACTED]');
  });

  it('leaves ordinary record fields alone', () => {
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.updateRun(run.id, {
      titleSummary: 'Catch AuthError in the login handler',
      status: 'done',
      diffStat: { adds: 1, dels: 2, files: 3 },
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.titleSummary).toBe('Catch AuthError in the login handler');
    expect(loaded?.status).toBe('done');
    expect(loaded?.diffStat).toEqual({ adds: 1, dels: 2, files: 3 });
  });

  /**
   * #456 review: redaction covered the run-level `error` but not the STEP-level
   * one, and `run.ts` feeds the SAME `err.message` string to both — so a token
   * was `[REDACTED]` in `runs.json`'s `error` and verbatim in
   * `steps[].error` one field away. `touch()` fans the record out over SSE too,
   * so it also reached the browser.
   */
  it('scrubs a host secret from steps[].error before runs.json is written', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'task',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    // Exactly what run.ts does on a failed step: raw err.message straight in.
    store.updateStep(run.id, 'task', {
      status: 'failed',
      error: 'auth failed for gho_thisisarealsecrettoken123456',
    });
    store.flush();

    expect(store.getRun(run.id)?.steps[0]?.error).toBe('auth failed for [REDACTED]');
    const raw = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    expect(raw).not.toContain('gho_thisisarealsecrettoken123456');
    expect(raw).toContain('[REDACTED]');
    // Survives a reopen — the scrub happened on the way in, not on read.
    expect(RunStore.open(dataDir).getRun(run.id)?.steps[0]?.error).toBe('auth failed for [REDACTED]');
  });

  it('leaves non-error step fields untouched (no over-redaction)', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'task',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateStep(run.id, 'task', { status: 'done', sessionId: 'sess-123', backend: 'codex', tokensUsed: 42 });
    const step = store.getRun(run.id)?.steps[0];
    expect(step?.status).toBe('done');
    expect(step?.sessionId).toBe('sess-123');
    expect(step?.backend).toBe('codex');
    expect(step?.tokensUsed).toBe(42);
  });

  it('CEZ_REDACT_SECRETS=0 opts steps[].error out too', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    process.env.CEZ_REDACT_SECRETS = '0';
    const store = RunStore.open(dataDir);
    const run = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'task',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateStep(run.id, 'task', { error: 'gho_thisisarealsecrettoken123456' });
    expect(store.getRun(run.id)?.steps[0]?.error).toBe('gho_thisisarealsecrettoken123456');
  });

  /** #456 review: `updateRun` scrubbed `title` but `createRun` stored it raw. */
  it('scrubs a host secret from the title at creation time', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({
      title: 'rotate gho_thisisarealsecrettoken123456',
      workflow: 'w',
      task: 'task',
      steps: [],
    });
    expect(run.title).toBe('rotate [REDACTED]');
    store.flush();
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).not.toContain(
      'gho_thisisarealsecrettoken123456',
    );
  });

  /** `task` is the user's own prompt and is replayed into `{{task}}` when a
   *  queued run is revived (#367) — scrubbing it would corrupt the revived run,
   *  so it stays verbatim by design. Pinning that decision. */
  it('leaves the task prompt unredacted (re-enqueue must replay it verbatim)', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'deploy the thing', steps: [] });
    expect(store.getRun(run.id)?.task).toBe('deploy the thing');
  });

  it('CEZ_REDACT_SECRETS=0 opts runs.json out as well', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    process.env.CEZ_REDACT_SECRETS = '0';
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.updateRun(run.id, { titleSummary: 'gho_thisisarealsecrettoken123456' });
    expect(store.getRun(run.id)?.titleSummary).toBe('gho_thisisarealsecrettoken123456');
  });

  it('does not disturb a PR URL (redaction leaves non-secrets intact)', () => {
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Opened a draft pull request: https://github.com/open-mercato/cezar/pull/42',
    } as never);
    expect(store.getRun(run.id)?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/42');
  });
});

describe('RunStore — referenced-PR discovery (#407, spec 2026-07-16-pr-autodiscovery)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const freshRun = (task = 'task') => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task, steps: [] });
    return { store, run };
  };

  it('adopts the referenced tier for a reviewed PR — without touching the created tier', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Reviewed https://github.com/open-mercato/cezar/pull/1 — looks good.',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.pullRequestUrl).toBeUndefined();
    expect(loaded?.referencedPullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/1');
  });

  it('sees PR URLs nested in v2 message items', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        text: 'Working on https://github.com/open-mercato/cezar/pull/4170 now.',
      },
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/4170',
    );
  });

  it('ignores reasoning items — thinking text speculates about PRs it never touches', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'reasoning',
        id: 'r1',
        text: 'Maybe similar to https://github.com/open-mercato/cezar/pull/99?',
      },
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('clears the referenced tier when a second distinct PR makes the subject ambiguous', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/cezar/pull/1',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/1',
    );
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Also related: https://github.com/open-mercato/cezar/pull/2',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('disambiguates several referenced PRs by the number named in the task prompt', () => {
    const { store, run } = freshRun('om-auto-review-pr 4170');
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'Reviewing https://github.com/open-mercato/cezar/pull/4170; it supersedes https://github.com/open-mercato/cezar/pull/12.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/4170',
    );
  });

  it('disambiguates by a PR number the prompt names as a pasted URL, not just a bare number', () => {
    const { store, run } = freshRun('review https://github.com/open-mercato/cezar/pull/3777 please');
    store.appendEvent(run.id, {
      type: 'result',
      result: 'It supersedes https://github.com/open-mercato/cezar/pull/12.',
    });
    // Two candidates now (3777 seeded from the prompt, 12 from the event); the
    // prompt names 3777 even though it only appears inside the URL path.
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/3777',
    );
  });

  it('does not treat a substring of a longer number as a prompt match', () => {
    const { store, run } = freshRun('om-auto-review-pr 4170');
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'https://github.com/open-mercato/cezar/pull/170 and https://github.com/open-mercato/cezar/pull/70',
    });
    // Neither 170 nor 70 is named (only "4170" is in the prompt) → ambiguous.
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('the created tier still wins and stops discovery', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Opened a draft pull request: https://github.com/open-mercato/cezar/pull/42',
    });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Compare with https://github.com/open-mercato/cezar/pull/50',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/42');
    expect(loaded?.referencedPullRequestUrl).toBeUndefined();
  });

  it('seeds the referenced tier from a PR URL pasted into the task prompt', () => {
    const { store, run } = freshRun('review https://github.com/open-mercato/cezar/pull/3777 please');
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/3777',
    );
  });

  it('round-trips the new fields through runs.json and keeps loading old files', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/cezar/pull/1',
    });
    store.flush();
    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/1',
    );
    expect(reopened.getRun(run.id)?.referencedPrCandidates).toEqual([
      'https://github.com/open-mercato/cezar/pull/1',
    ]);
    // legacy record without the fields still parses (see LEGACY_RUN above)
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([LEGACY_RUN]), 'utf8');
    const legacyStore = RunStore.open(dataDir);
    expect(legacyStore.getRun('legacy-1')?.referencedPullRequestUrl).toBeUndefined();
  });
});

describe('RunStore — agent-declared marker refs (spec 2026-07-18-task-ref-markers)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const freshRun = (task = 'task') => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task, steps: [] });
    return { store, run };
  };

  it('marker numbers land on the record and persist', () => {
    const { store, run } = freshRun();
    store.applyMarkerRefs(run.id, { pr: 442, issue: 433 });
    store.flush();
    const loaded = RunStore.open(dataDir).getRun(run.id);
    expect(loaded?.prNumber).toBe(442);
    expect(loaded?.issueNumber).toBe(433);
    expect(loaded?.markerRefs).toEqual({ pr: 442, issue: 433 });
  });

  it('a declared PR picks the matching candidate among several — where fuzzy resolution gave up', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'Comparing https://github.com/open-mercato/cezar/pull/500 with https://github.com/open-mercato/cezar/pull/777',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined(); // ambiguous
    store.applyMarkerRefs(run.id, { pr: 500 });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/500',
    );
  });

  it('a declared PR clears a fuzzily-adopted chip that contradicts it (the #777 failure)', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Related work: https://github.com/open-mercato/cezar/pull/777',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/777',
    );
    store.applyMarkerRefs(run.id, { pr: 500 });
    const loaded = store.getRun(run.id);
    expect(loaded?.referencedPullRequestUrl).toBeUndefined();
    expect(loaded?.prNumber).toBe(500);
  });

  it('later candidates resolve against the declared number, not the fuzzy rules', () => {
    const { store, run } = freshRun();
    store.applyMarkerRefs(run.id, { pr: 500 });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/cezar/pull/777 for prior art.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Now updating https://github.com/open-mercato/cezar/pull/500.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/500',
    );
  });

  it('an issue-only declaration leaves the referenced tier alone', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/cezar/pull/777',
    });
    store.applyMarkerRefs(run.id, { issue: 500 });
    const loaded = store.getRun(run.id);
    expect(loaded?.referencedPullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/777');
    expect(loaded?.issueNumber).toBe(500);
    expect(loaded?.prNumber).toBeUndefined();
  });

  it('the created tier is untouched by markers', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Opened a draft pull request: https://github.com/open-mercato/cezar/pull/42',
    });
    store.applyMarkerRefs(run.id, { pr: 500 });
    expect(store.getRun(run.id)?.pullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/42',
    );
  });

  it('an empty declaration is a no-op', () => {
    const { store, run } = freshRun();
    store.applyMarkerRefs(run.id, {});
    expect(store.getRun(run.id)?.markerRefs).toBeUndefined();
  });

  // Verbatim from the run that reported it: a task opened on open-mercato#4326 pushed a
  // fix as its own #5366 and re-declared with the new number, as the marker contract asks. Both
  // PRs are true, and the record has a field for each — but feeding the re-declaration to the
  // referenced tier cleared #4326 (no candidate ends in /5366), so the cockpit painted one chip.
  it('a declaration naming the PR the task CREATED keeps the PR it is about', () => {
    const { store, run } = freshRun('Address GitHub pull request #4326');
    store.applyMarkerRefs(run.id, { pr: 4326 });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Reviewing https://github.com/open-mercato/open-mercato/pull/4326.',
    });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Ran gh pr create … → https://github.com/open-mercato/open-mercato/pull/5366',
    });
    store.applyMarkerRefs(run.id, { pr: 5366 });

    const loaded = store.getRun(run.id);
    expect(loaded?.pullRequestUrl).toBe('https://github.com/open-mercato/open-mercato/pull/5366');
    expect(loaded?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/open-mercato/pull/4326',
    );
    // The about-number too: it is what paints a numeric-only chip, and the created PR already
    // has a field of its own.
    expect(loaded?.prNumber).toBe(4326);
    expect(loaded?.markerRefs?.pr).toBe(5366);
  });

  it('restores the about-PR when the declaration arrives BEFORE the creation evidence', () => {
    const { store, run } = freshRun('Address GitHub pull request #4326');
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Reviewing https://github.com/open-mercato/open-mercato/pull/4326.',
    });
    store.applyMarkerRefs(run.id, { pr: 5366 });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined(); // nothing created yet
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Ran gh pr create … → https://github.com/open-mercato/open-mercato/pull/5366',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/open-mercato/pull/4326',
    );
  });

  it('still fills an unknown prNumber from a declaration that names the created PR', () => {
    const { store, run } = freshRun('ship the devices work');
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Created a pull request: https://github.com/open-mercato/cezar/pull/42',
    });
    store.applyMarkerRefs(run.id, { pr: 42 });
    expect(store.getRun(run.id)?.prNumber).toBe(42);
  });

  it('heals a record already written by the bug, on load', () => {
    // Exactly the shape the bug left on disk: the created PR, the declaration that named it, the
    // about-PR still sitting in the working set, and the chip it should have painted gone.
    const { store, run } = freshRun('Address GitHub pull request #4326');
    store.updateRun(run.id, {
      pullRequestUrl: 'https://github.com/open-mercato/open-mercato/pull/5366',
      referencedPullRequestUrl: undefined,
      referencedPrCandidates: ['https://github.com/open-mercato/open-mercato/pull/4326'],
      markerRefs: { pr: 5366 },
      prNumber: 5366,
    });
    store.flush();
    expect(RunStore.open(dataDir).getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/open-mercato/pull/4326',
    );
  });

  it('never resurrects a chip a live declaration deliberately cleared', () => {
    // The other direction of the heal, and the one that would quietly undo "no chip beats a wrong
    // chip": here the declaration names a PR this run did NOT create, so it still owns the
    // referenced tier and its contradiction with the candidate must survive a reload.
    const { store, run } = freshRun('task');
    store.updateRun(run.id, {
      referencedPullRequestUrl: undefined,
      referencedPrCandidates: ['https://github.com/open-mercato/cezar/pull/777'],
      markerRefs: { pr: 500 },
    });
    store.flush();
    expect(RunStore.open(dataDir).getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('never takes a referenced PR away from a record whose candidates no longer explain it', () => {
    const { store, run } = freshRun('task');
    store.updateRun(run.id, {
      referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/777',
      referencedPrCandidates: undefined,
      markerRefs: { pr: 777 },
    });
    store.flush();
    expect(RunStore.open(dataDir).getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/777',
    );
  });

  it('a declaration naming some OTHER PR still overrides the fuzzy tier', () => {
    const { store, run } = freshRun('task');
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Created a pull request: https://github.com/open-mercato/cezar/pull/42',
    });
    store.applyMarkerRefs(run.id, { pr: 500 });
    const loaded = store.getRun(run.id);
    expect(loaded?.prNumber).toBe(500);
    expect(loaded?.referencedPullRequestUrl).toBeUndefined(); // no candidate ends in /500
  });
});

describe('RunStore — referenced-issue discovery (spec 2026-07-21-report-ref-discovery)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const freshRun = (task = 'task') => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task, steps: [] });
    return { store, run };
  };

  it('adopts a single issue link and seeds issueNumber', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Fixing https://github.com/open-mercato/cezar/issues/433 now.',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.referencedIssueUrl).toBe('https://github.com/open-mercato/cezar/issues/433');
    expect(loaded?.issueNumber).toBe(433);
  });

  it('keeps issue links from tool output display-only until the agent names them', () => {
    const { store, run } = freshRun();
    const issueUrl = 'https://github.com/open-mercato/cezar/issues/99';
    store.appendEvent(run.id, {
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        toolKind: 'execute',
        title: 'Ran gh pr view',
        status: 'completed',
        input: { command: 'gh pr view 1' },
        output: `PR body: Fixes ${issueUrl}`,
      },
    });
    expect(store.getRun(run.id)?.referencedIssueUrl).toBe(issueUrl);
    expect(store.getRun(run.id)?.issueNumber).toBeUndefined();

    store.appendEvent(run.id, {
      type: 'result',
      result: `This run is about ${issueUrl}.`,
    });
    expect(store.getRun(run.id)?.issueNumber).toBe(99);
  });

  it('seeds an issue link while the run is still queued', () => {
    const { store, run } = freshRun('Fix https://github.com/open-mercato/cezar/issues/554');
    const loaded = store.getRun(run.id);
    expect(loaded?.status).toBe('queued');
    expect(loaded?.referencedIssueUrl).toBe('https://github.com/open-mercato/cezar/issues/554');
    expect(loaded?.issueNumber).toBe(554);
  });

  it('tracks issues independently of a created PR', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'Opened a draft pull request: https://github.com/open-mercato/cezar/pull/42 closing https://github.com/open-mercato/cezar/issues/7',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.pullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/42');
    expect(loaded?.referencedIssueUrl).toBe('https://github.com/open-mercato/cezar/issues/7');
    expect(loaded?.issueNumber).toBe(7);
  });

  it('ambiguity clears the chip and takes back the number the janitor seeded', () => {
    const { store: firstStore, run } = freshRun();
    firstStore.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/cezar/issues/1',
    });
    expect(firstStore.getRun(run.id)?.issueNumber).toBe(1);
    firstStore.flush();
    const store = RunStore.open(dataDir, { keepLive: true });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Also https://github.com/open-mercato/cezar/issues/2',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.referencedIssueUrl).toBeUndefined();
    expect(loaded?.issueNumber).toBeUndefined();
  });

  it('ambiguity preserves a prompt-derived issueNumber equal to the previous resolution', () => {
    const { store, run } = freshRun('port the fix from issue 12 into issue 433');
    store.updateRun(run.id, { issueNumber: 12 });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/cezar/issues/12',
    });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Also https://github.com/open-mercato/cezar/issues/433',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.referencedIssueUrl).toBeUndefined();
    expect(loaded?.issueNumber).toBe(12);
  });

  it('disambiguates several issue links by the number named in the task prompt', () => {
    const { store, run } = freshRun('om-auto-fix-issue 433');
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'Working https://github.com/open-mercato/cezar/issues/433, related to https://github.com/open-mercato/cezar/issues/12.',
    });
    expect(store.getRun(run.id)?.referencedIssueUrl).toBe(
      'https://github.com/open-mercato/cezar/issues/433',
    );
  });

  it('a declared CEZ:ISSUE filters the candidates and owns issueNumber', () => {
    const { store, run } = freshRun();
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'See https://github.com/open-mercato/cezar/issues/1 and https://github.com/open-mercato/cezar/issues/2',
    });
    store.applyMarkerRefs(run.id, { issue: 2 });
    const loaded = store.getRun(run.id);
    expect(loaded?.referencedIssueUrl).toBe('https://github.com/open-mercato/cezar/issues/2');
    expect(loaded?.issueNumber).toBe(2);
  });

  it('never overwrites a marker-owned issueNumber from a stray link', () => {
    const { store, run } = freshRun();
    store.applyMarkerRefs(run.id, { issue: 500 });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Mentioned in https://github.com/open-mercato/cezar/issues/9',
    });
    expect(store.getRun(run.id)?.issueNumber).toBe(500);
  });
});

describe("RunStore — a task never adopts another repository's ref (#945)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-repo-scope-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const HANDLE = { owner: 'open-mercato', name: 'cezar' };

  /** A store that already knows which repository it is, as the background arming leaves it. */
  const scopedRun = (task = 'task', handle: typeof HANDLE | null = HANDLE) => {
    const store = RunStore.open(dataDir);
    store.setRepoHandle(handle);
    const run = store.createRun({ title: 't', workflow: 'w', task, steps: [] });
    return { store, run };
  };

  it('drops a lone foreign PR the prompt never named — the reported defect', () => {
    // "assessing Phase 0 SQL safety": a research task cites one upstream PR, and the
    // one-distinct-candidate rule made it the task's identity.
    const { store, run } = scopedRun('assessing Phase 0 SQL safety');
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Migration safety is discussed in https://github.com/supabase/cli/pull/6056.',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.referencedPullRequestUrl).toBeUndefined();
    // Collected as evidence all the same — the guard changes what is PROMOTED, never what is
    // recorded (the #526 rule).
    expect(loaded?.referencedPrCandidates).toEqual(['https://github.com/supabase/cli/pull/6056']);
  });

  it('drops a lone foreign issue AND refuses to seed issueNumber from it', () => {
    const { store, run } = scopedRun('assessing Phase 0 SQL safety');
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Tracked upstream as https://github.com/supabase/cli/issues/6056.',
    });
    const loaded = store.getRun(run.id);
    expect(loaded?.referencedIssueUrl).toBeUndefined();
    expect(loaded?.issueNumber).toBeUndefined();
    expect(loaded?.referencedIssueCandidates).toEqual([
      'https://github.com/supabase/cli/issues/6056',
    ]);
  });

  it('keeps a foreign PR the task prompt itself names — the #819 cross-repo case', () => {
    const { store, run } = scopedRun(
      'om-auto-fix-pr https://github.com/open-mercato/open-mercato/pull/1977',
    );
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Working on https://github.com/open-mercato/open-mercato/pull/1977 now.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/open-mercato/pull/1977',
    );
  });

  it('corroboration accepts the bare owner/repo, not only a pasted URL', () => {
    const { store, run } = scopedRun('port the fix over to open-mercato/open-mercato');
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/open-mercato/pull/1977.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/open-mercato/pull/1977',
    );
  });

  it("leaves the project's own PRs alone — the ordinary #407 path", () => {
    const { store, run } = scopedRun();
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Reviewed https://github.com/open-mercato/cezar/pull/407 — looks good.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/407',
    );
  });

  it('matches the handle case-insensitively', () => {
    const { store, run } = scopedRun('task', { owner: 'Open-Mercato', name: 'Cezar' });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/open-mercato/cezar/pull/407.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/open-mercato/cezar/pull/407',
    );
  });

  it('an unknown handle keeps pre-#945 behavior — degrade, never fail', () => {
    // No `gh`, no remote, a non-git root, hosted mode: `resolveRepoHandle` answers null and the
    // foreign URL is adopted exactly as it was before this guard existed.
    const { store, run } = scopedRun('assessing Phase 0 SQL safety', null);
    store.appendEvent(run.id, {
      type: 'result',
      result: 'Migration safety is discussed in https://github.com/supabase/cli/pull/6056.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/supabase/cli/pull/6056',
    );
  });

  it('a store that was never armed keeps pre-#945 behavior too', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/supabase/cli/pull/6056.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBe(
      'https://github.com/supabase/cli/pull/6056',
    );
  });

  it('vetoes a foreign URL a CEZ:PR marker declared', () => {
    // The marker owns the resolution, but it can only ever pick from the candidate list — and a
    // foreign candidate is not adoptable, so the chip stays empty rather than pointing away.
    const { store, run } = scopedRun('task');
    store.appendEvent(run.id, {
      type: 'result',
      result: 'See https://github.com/supabase/cli/pull/6056.',
    });
    store.applyMarkerRefs(run.id, { pr: 6056 });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
  });

  describe('healing records the un-scoped rule already poisoned', () => {
    /** Persist one record, then reopen and arm — what a cockpit restart does. */
    const reopenArmed = (
      record: Partial<RunRecord> & { task: string },
      handle: typeof HANDLE | null = HANDLE,
    ) => {
      const seed = RunStore.open(dataDir);
      const run = seed.createRun({ title: 't', workflow: 'w', task: record.task, steps: [] });
      seed.updateRun(run.id, record);
      seed.flush();

      const reopened = RunStore.open(dataDir);
      // Snapshot the VALUE, not the record: `getRun` hands back the live object the sweep
      // mutates in place, so holding the reference would show the healed state either way.
      const before = reopened.getRun(run.id)?.referencedPullRequestUrl;
      reopened.setRepoHandle(handle);
      return { before, after: reopened.getRun(run.id) };
    };

    it('drops a stored foreign referencedPullRequestUrl when the handle arrives', () => {
      const { before, after } = reopenArmed({
        task: 'assessing Phase 0 SQL safety',
        referencedPullRequestUrl: 'https://github.com/supabase/cli/pull/6056',
        referencedPrCandidates: ['https://github.com/supabase/cli/pull/6056'],
      });
      // Before arming, the poisoned value is still there — the heal is not a load-time rewrite.
      expect(before).toBe('https://github.com/supabase/cli/pull/6056');
      expect(after?.referencedPullRequestUrl).toBeUndefined();
      // Evidence survives the heal — only the conclusion drawn from it was wrong.
      expect(after?.referencedPrCandidates).toEqual(['https://github.com/supabase/cli/pull/6056']);
    });

    it('keeps a stored foreign URL the prompt corroborates', () => {
      const { after } = reopenArmed({
        task: 'om-auto-fix-pr https://github.com/open-mercato/open-mercato/pull/1977',
        referencedPullRequestUrl: 'https://github.com/open-mercato/open-mercato/pull/1977',
      });
      expect(after?.referencedPullRequestUrl).toBe(
        'https://github.com/open-mercato/open-mercato/pull/1977',
      );
    });

    it("keeps a stored URL from the project's own repo", () => {
      const { after } = reopenArmed({
        task: 'task',
        referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/407',
      });
      expect(after?.referencedPullRequestUrl).toBe('https://github.com/open-mercato/cezar/pull/407');
    });

    it('revokes an issueNumber this janitor seeded from the dropped URL', () => {
      const { after } = reopenArmed({
        task: 'assessing Phase 0 SQL safety',
        referencedIssueUrl: 'https://github.com/supabase/cli/issues/6056',
        issueNumber: 6056,
        referencedIssueNumberSeeded: true,
      });
      expect(after?.referencedIssueUrl).toBeUndefined();
      expect(after?.issueNumber).toBeUndefined();
      expect(after?.referencedIssueNumberSeeded).toBeUndefined();
    });

    it('leaves an issueNumber it did NOT seed alone', () => {
      // The prompt, the namer or a CEZ:ISSUE marker owns that number — dropping the foreign URL
      // must not take it with them.
      const { after } = reopenArmed({
        task: 'fix issue 42',
        referencedIssueUrl: 'https://github.com/supabase/cli/issues/6056',
        issueNumber: 42,
      });
      expect(after?.referencedIssueUrl).toBeUndefined();
      expect(after?.issueNumber).toBe(42);
    });

    it('a null handle heals nothing — there is nothing to prove foreign against', () => {
      const { after } = reopenArmed(
        {
          task: 'assessing Phase 0 SQL safety',
          referencedPullRequestUrl: 'https://github.com/supabase/cli/pull/6056',
        },
        null,
      );
      expect(after?.referencedPullRequestUrl).toBe('https://github.com/supabase/cli/pull/6056');
    });

    it('is one-directional — it never invents an association', () => {
      // A record with candidates but no resolution stays unresolved: the sweep only ever clears.
      const { after } = reopenArmed({
        task: 'task',
        referencedPullRequestUrl: undefined,
        referencedPrCandidates: [
          'https://github.com/open-mercato/cezar/pull/1',
          'https://github.com/supabase/cli/pull/6056',
        ],
      });
      expect(after?.referencedPullRequestUrl).toBeUndefined();
    });

    it('emits the corrected record so an open cockpit repaints', () => {
      const seed = RunStore.open(dataDir);
      const run = seed.createRun({
        title: 't',
        workflow: 'w',
        task: 'assessing Phase 0 SQL safety',
        steps: [],
      });
      seed.updateRun(run.id, {
        referencedPullRequestUrl: 'https://github.com/supabase/cli/pull/6056',
      });
      const seen: string[] = [];
      seed.on('run', (r: RunRecord) => seen.push(r.id));
      seed.setRepoHandle(HANDLE);
      expect(seen).toContain(run.id);
    });
  });

  it('does not rescue a candidate today’s rule already calls ambiguous', () => {
    // Strictly subtractive: two candidates, one foreign, still resolves to nothing. Filtering the
    // list before resolving would have promoted the local one — a wider change than the fix needs.
    const { store, run } = scopedRun('task');
    store.appendEvent(run.id, {
      type: 'result',
      result:
        'Compare https://github.com/open-mercato/cezar/pull/1 with https://github.com/supabase/cli/pull/6056.',
    });
    expect(store.getRun(run.id)?.referencedPullRequestUrl).toBeUndefined();
  });
});

describe('RunStore — seq survives a restart (#424 symptom class)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-seq-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('continues numbering above the NDJSON max after reopen, so replayed clients keep receiving', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    store.appendEvent(run.id, { type: 'note', message: 'one' });
    store.appendEvent(run.id, { type: 'note', message: 'two' });
    store.flush();

    // A client that replayed the file now dedups with maxSeq = 2. A restarted
    // process restarting seqs at 1 would have every resumed event dropped.
    const reopened = RunStore.open(dataDir, { keepLive: true });
    const resumed = reopened.appendEvent(run.id, { type: 'note', message: 'after restart' });
    expect(resumed.seq).toBe(3);
    const seqs = reopened.readEvents(run.id).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('starts at 1 for a run with no event file', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    expect(store.appendEvent(run.id, { type: 'note', message: 'first' }).seq).toBe(1);
  });
});

describe('RunStore — provider authorization callouts', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-provider-auth-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists the structured provider-auth-required event without vendor error text', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });

    store.appendEvent(run.id, {
      type: 'provider-auth-required',
      provider: 'claude',
      authFailureId: 'auth-incident-1',
      stepId: 'implementation',
    });

    expect(store.readEvents(run.id)).toEqual([expect.objectContaining({
      type: 'provider-auth-required',
      provider: 'claude',
      authFailureId: 'auth-incident-1',
      stepId: 'implementation',
    })]);
    expect(JSON.stringify(store.readEvents(run.id))).not.toContain('OAuth');
    expect(JSON.stringify(store.readEvents(run.id))).not.toContain('token');
  });
});

/** #472 — the queued prompt stack. Additive optional field, and (like `task`)
 *  deliberately outside `redactPatch`'s field list. */
describe('RunStore — queuedMessages (#472)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.GITHUB_TOKEN;
    delete process.env.CEZ_REDACT_SECRETS;
  });

  it('parses a runs.json written before the field existed', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([LEGACY_RUN]));
    const store = RunStore.open(dataDir);
    const run = store.getRun('legacy-1');
    expect(run).toBeDefined();
    // `undefined` reads as an empty stack — no migration, no default to write back.
    expect(run?.queuedMessages).toBeUndefined();
  });

  it('round-trips a record carrying the stack', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'ship it', steps: [] });
    store.updateRun(run.id, {
      queuedMessages: [
        { id: 'm1', text: 'and update the changelog', createdAt: '2026-07-21T10:00:00.000Z' },
        {
          id: 'm2',
          text: 'see this mock',
          images: [`/api/v1/runs/${run.id}/images/pasted-1.png`],
          createdAt: '2026-07-21T10:01:00.000Z',
        },
      ],
    });
    store.flush();

    const reopened = RunStore.open(dataDir);
    const stack = reopened.getRun(run.id)?.queuedMessages;
    expect(stack).toHaveLength(2);
    expect(stack?.[0]).toEqual({
      id: 'm1',
      text: 'and update the changelog',
      createdAt: '2026-07-21T10:00:00.000Z',
    });
    expect(stack?.[1]?.images).toEqual([`/api/v1/runs/${run.id}/images/pasted-1.png`]);
  });

  /** The `task` rule (above) extended to the stack: these strings are replayed
   *  into `{{task}}` verbatim at dequeue, so redacting one would corrupt the run. */
  it('leaves a secret in a stacked message verbatim, exactly as it leaves `task`', () => {
    process.env.GITHUB_TOKEN = 'gho_thisisarealsecrettoken123456';
    delete process.env.CEZ_REDACT_SECRETS;
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'deploy', steps: [] });
    store.updateRun(run.id, {
      queuedMessages: [
        { id: 'm1', text: 'use gho_thisisarealsecrettoken123456', createdAt: '2026-07-21T10:00:00.000Z' },
      ],
    });
    expect(store.getRun(run.id)?.queuedMessages?.[0]?.text).toBe(
      'use gho_thisisarealsecrettoken123456',
    );
  });
});

describe('RunStore — read receipts (#unread-done-items)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Create a run and drive it to a terminal status with a finishedAt, the way the run manager
   *  does — so the read/unread rule has a real "finished" instant to compare against. The instant
   *  is safely in the past: `setRead`/`markAllRead` stamp `seenAt` from the real wall clock, so a
   *  future `finishedAt` would make a just-read run compare as still-unread. */
  const FINISHED_AT = '2020-01-01T00:00:00.000Z';
  function finishedRun(store: RunStore, status: 'done' | 'failed' | 'cancelled'): string {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status, finishedAt: FINISHED_AT });
    return run.id;
  }

  it('setRead stamps seenAt, round-trips, and returns the record', () => {
    const store = RunStore.open(dataDir);
    const id = finishedRun(store, 'done');
    expect(store.getRun(id)?.seenAt).toBeUndefined();

    const updated = store.setRead(id);
    expect(updated?.seenAt).toBeDefined();
    store.flush();

    expect(RunStore.open(dataDir).getRun(id)?.seenAt).toBe(updated?.seenAt);
  });

  it('setRead returns undefined for an unknown id', () => {
    const store = RunStore.open(dataDir);
    expect(store.setRead('nope')).toBeUndefined();
  });

  it('setUnread clears the receipt, round-trips, and returns the record (#775)', () => {
    const store = RunStore.open(dataDir);
    const id = finishedRun(store, 'done');
    store.setRead(id);
    expect(store.getRun(id)?.seenAt).toBeDefined();

    const updated = store.setUnread(id);
    // Cleared, not blanked: `isUnread` and the store's own `markAllRead` both key on the
    // field being ABSENT, so an empty-string receipt would read as "seen at the epoch".
    expect(updated?.seenAt).toBeUndefined();
    expect(Object.hasOwn(updated!, 'seenAt')).toBe(false);
    store.flush();

    expect(RunStore.open(dataDir).getRun(id)?.seenAt).toBeUndefined();
  });

  it('setUnread is idempotent on an already-unread run', () => {
    const store = RunStore.open(dataDir);
    const id = finishedRun(store, 'done');

    expect(store.setUnread(id)?.seenAt).toBeUndefined();
    expect(store.setUnread(id)?.seenAt).toBeUndefined();
  });

  it('setUnread returns undefined for an unknown id', () => {
    const store = RunStore.open(dataDir);
    expect(store.setUnread('nope')).toBeUndefined();
  });

  it('a run put back to unread is counted again by the next markAllRead sweep', () => {
    // The point of clearing rather than flagging: the run rejoins the unread population every
    // other reader already computes, so the badge, the sweep and the marker all agree again.
    const store = RunStore.open(dataDir);
    const id = finishedRun(store, 'done');
    store.setRead(id);
    expect(store.markAllRead()).toBe(0);

    store.setUnread(id);
    expect(store.markAllRead()).toBe(1);
    expect(store.getRun(id)?.seenAt).toBeDefined();
  });

  it('still loads an old runs.json with no seenAt (additive)', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([LEGACY_RUN]), 'utf8');
    expect(RunStore.open(dataDir).getRun('legacy-1')?.seenAt).toBeUndefined();
  });

  it('markAllRead stamps only unread done/failed runs and returns the count', () => {
    const store = RunStore.open(dataDir);
    const doneUnread = finishedRun(store, 'done');
    const failedUnread = finishedRun(store, 'failed');
    const cancelled = finishedRun(store, 'cancelled');
    const alreadyRead = finishedRun(store, 'done');
    store.setRead(alreadyRead);
    const running = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] }).id;

    expect(store.markAllRead()).toBe(2);
    expect(store.getRun(doneUnread)?.seenAt).toBeDefined();
    expect(store.getRun(failedUnread)?.seenAt).toBeDefined();
    // Cancelled and still-running runs are never unread, so they stay untouched.
    expect(store.getRun(cancelled)?.seenAt).toBeUndefined();
    expect(store.getRun(running)?.seenAt).toBeUndefined();

    // Idempotent: a second sweep finds nothing left unread.
    expect(store.markAllRead()).toBe(0);
  });

  it('archiving retires a pending usage-limit resume — one run and in bulk', () => {
    // Archiving is how a user resigns from a task, so an archived run can never carry a promise
    // to resume itself (spec 2026-08-03-auto-resume-after-usage-limit). The rule lives in the
    // store because the "Archive finished" SWEEP never goes through the archive route, and a
    // user who archives fifty finished tasks has resigned from all fifty.
    const store = RunStore.open(dataDir);
    const limited = () => {
      const id = finishedRun(store, 'failed');
      store.updateRun(id, {
        autoResumeAt: '2026-08-03T18:41:48.000Z',
        autoResumeAttempts: 2,
      });
      return id;
    };
    const one = limited();
    store.setArchived(one, true);
    expect(store.getRun(one)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(one)?.autoResumeAttempts).toBeUndefined();

    const swept = limited();
    expect(store.archiveFinished()).toBeGreaterThanOrEqual(1);
    expect(store.getRun(swept)?.archived).toBe(true);
    expect(store.getRun(swept)?.autoResumeAt).toBeUndefined();

    // Un-archiving restores the task, never the promise — that would resume a task the user
    // has already walked away from once.
    store.setArchived(one, false);
    expect(store.getRun(one)?.autoResumeAt).toBeUndefined();
  });

  it('markAllRead skips archived runs, exactly as the cockpit rule does', () => {
    // `isUnread()` (web/src/lib/read-state.ts) treats an archived run as never unread —
    // archiving is a stronger "done with this" than reading. The sweep has to agree, or the
    // count it answers would exceed the unread badge the user clicked, and archived history
    // would take a pointless write and `run` broadcast on every sweep.
    const store = RunStore.open(dataDir);
    const archived = finishedRun(store, 'done');
    store.setArchived(archived, true);
    const active = finishedRun(store, 'done');

    expect(store.markAllRead()).toBe(1);
    expect(store.getRun(active)?.seenAt).toBeDefined();
    expect(store.getRun(archived)?.seenAt).toBeUndefined();
  });

  it('markAllRead skips a run waiting out a usage limit, exactly as the cockpit rule does (#803)', () => {
    // The drift this pins: `isUnread()` (web/src/lib/read-state.ts) gained an `isScheduledResume`
    // exclusion with the auto-resume work — a `failed` run with a pending `autoResumeAt` is not a
    // done item, so it wears no marker and the nav badge does not count it — and this sweep never
    // gained the matching clause. The user-visible symptom: "Mark all read" silently stamped a
    // task the UI never presented as unread, and reported a count larger than the badge showed.
    const store = RunStore.open(dataDir);
    const scheduled = finishedRun(store, 'failed');
    store.updateRun(scheduled, { autoResumeAt: '2026-08-03T18:41:48.000Z', autoResumeAttempts: 1 });
    const ordinary = finishedRun(store, 'done');

    // The count is the badge's number: one, not two.
    expect(store.markAllRead()).toBe(1);
    expect(store.getRun(ordinary)?.seenAt).toBeDefined();
    expect(store.getRun(scheduled)?.seenAt).toBeUndefined();
  });

  it('markAllRead stamps the same run once its resume is no longer pending (#803)', () => {
    // The exclusion is about the APPOINTMENT, not the failure: clear the schedule and the run is
    // an ordinary unread `failed` done item again. Without this, the clause above would be
    // indistinguishable from "never stamp a failed run", which is a different (wrong) rule.
    const store = RunStore.open(dataDir);
    const id = finishedRun(store, 'failed');
    store.updateRun(id, { autoResumeAt: '2026-08-03T18:41:48.000Z' });
    expect(store.markAllRead()).toBe(0);

    store.updateRun(id, { autoResumeAt: undefined });
    expect(store.markAllRead()).toBe(1);
    expect(store.getRun(id)?.seenAt).toBeDefined();
  });
});

describe('RunStore — the legacy `claude-cli` runner id (#547)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('loads a record carrying `claude-cli` and folds it to `claude`', () => {
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([
        {
          ...LEGACY_RUN,
          runner: 'claude-cli',
          steps: [
            {
              id: 'task',
              name: 'Do the task',
              kind: 'agent',
              status: 'done',
              iterations: 1,
              tokensUsed: 0,
              sessionId: 'sess-1',
              backend: 'claude-cli',
            },
          ],
        },
      ]),
      'utf8',
    );

    const run = RunStore.open(dataDir).getRun('legacy-1');
    // Parsed, not dropped — and normalized, so no consumer sees a fourth runner id.
    expect(run?.runner).toBe('claude');
    expect(run?.steps[0]?.backend).toBe('claude');
  });

  it('does not let one `claude-cli` record evict the rest of runs.json', () => {
    // The regression this guards: the loader `safeParse`s the WHOLE array, so before #547 a
    // single record carrying the legacy id took every other run in the file down with it —
    // the exact failure mode BACKWARD_COMPATIBILITY.md §3 warns about.
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([
        { ...LEGACY_RUN, id: 'legacy-cli', runner: 'claude-cli' },
        { ...LEGACY_RUN, id: 'modern', runner: 'codex' },
      ]),
      'utf8',
    );

    const store = RunStore.open(dataDir);
    expect(store.getRun('legacy-cli')?.runner).toBe('claude');
    expect(store.getRun('modern')?.runner).toBe('codex');
  });

  it('rewrites the folded id on the next save, so the narrowing is one-way', () => {
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([{ ...LEGACY_RUN, runner: 'claude-cli' }]),
      'utf8',
    );

    const store = RunStore.open(dataDir);
    store.updateRun('legacy-1', { title: 'touched' });
    store.flush();

    // The index is re-serialized from the PARSED records, so `claude-cli` is gone from disk.
    const onDisk = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    expect(onDisk).not.toContain('claude-cli');
    expect(JSON.parse(onDisk)[0].runner).toBe('claude');
  });

  it('persists and reloads a `pi` run, index and step alike (#387)', () => {
    // `storedRunnerSchema` derives from `RUNNER_IDS` rather than re-listing the ids, so a new
    // runner is readable the moment it is registered. Without this, a completed pi run would
    // fail the whole-array parse on the next boot and take every other run down with it.
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([
        {
          ...LEGACY_RUN,
          runner: 'pi',
          steps: [
            {
              id: 'task',
              name: 'Do the task',
              kind: 'agent',
              status: 'done',
              iterations: 1,
              tokensUsed: 0,
              sessionId: 'pi-sess-1',
              backend: 'pi',
            },
          ],
        },
      ]),
      'utf8',
    );

    const run = RunStore.open(dataDir).getRun('legacy-1');
    expect(run?.runner).toBe('pi');
    expect(run?.steps[0]?.backend).toBe('pi');
  });

  it('still rejects a runner id that is not a legacy spelling of a real backend', () => {
    // Widening the READ side is not an invitation to accept anything: an unknown id is still
    // a parse failure, which is what keeps the enum meaningful.
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([{ ...LEGACY_RUN, runner: 'gemini' }]),
      'utf8',
    );
    expect(RunStore.open(dataDir).getRun('legacy-1')).toBeUndefined();
  });
});
