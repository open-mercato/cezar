import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDefinition } from '@open-mercato/cezar-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { AutomationRunReport } from './engine.ts';
import { finalAssistantText, watchAutomationReports } from './automation-reports.ts';

describe('automation reports', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-automation-reports-unit-'));
    mkdirSync(join(dataDir, 'runs'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('reads the last assistant message whole, without CEZ control lines', () => {
    const lines = [
      { type: 'text', text: 'first draft', seq: 1 },
      { type: 'tool-call', tool: 'Bash', seq: 2 },
      { type: 'text', text: `# Brief\n${'x'.repeat(3_000)}\nCEZ:TITLE=brief\nCEZ:DONE`, seq: 3 },
      { type: 'done', seq: 4 },
    ];
    writeFileSync(join(dataDir, 'runs', 'r1.ndjson'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    expect(finalAssistantText(dataDir, 'r1')).toBe(`# Brief\n${'x'.repeat(3_000)}`);
    expect(finalAssistantText(dataDir, 'missing')).toBeUndefined();
  });

  it('reports a settled linked run once per outcome, never history, children or a cancel', async () => {
    const store = Object.assign(new EventEmitter(), { listRuns: () => [{ id: 'old', status: 'running' }] }) as unknown as RunStore;
    const reports: AutomationRunReport[] = [];
    const definition = { id: 'a1', name: 'Brief', report: { managerId: 'm1', mode: 'post-result' } } as AutomationDefinition;
    const unlinked = { id: 'a2', name: 'Plain' } as AutomationDefinition;
    let answer: ReturnType<Parameters<typeof watchAutomationReports>[0]['report']> = 'posted';
    const unlink = vi.fn();
    const off = watchAutomationReports({
      projectId: () => 'alpha',
      dataDir,
      store,
      automation: (id) => (id === 'a1' ? definition : id === 'a2' ? unlinked : undefined),
      report: (input) => { reports.push(input); return answer; },
      unlink,
      enabled: () => true,
    });
    const trigger = (automationId: string): Partial<RunRecord> => ({ automationTrigger: { automationId, automationRevision: 1, receiptId: 'r', trigger: 'schedule', occurrenceAt: '' } });
    const emit = (run: Partial<RunRecord>) => store.emit('run', { finishedAt: '2026-11-12T07:50:00.000Z', ...run } as RunRecord);
    emit({ id: 'new', status: 'running', ...trigger('a1') });
    emit({ id: 'new', status: 'review', ...trigger('a1') });
    emit({ id: 'new', status: 'done', ...trigger('a1') });
    emit({ id: 'plain', status: 'running', ...trigger('a2') });
    emit({ id: 'plain', status: 'done', ...trigger('a2') });
    emit({ id: 'child', status: 'running', ...trigger('a1'), dispatch: { parentRunId: 'new' } as RunRecord['dispatch'] });
    emit({ id: 'child', status: 'done', ...trigger('a1'), dispatch: { parentRunId: 'new' } as RunRecord['dispatch'] });
    emit({ id: 'stopped', status: 'running', ...trigger('a1') });
    emit({ id: 'stopped', status: 'cancelled', ...trigger('a1') });
    emit({ id: 'old', status: 'failed', error: 'Not logged in', ...trigger('a1') });
    await vi.waitFor(() => expect(reports).toHaveLength(2));
    expect(reports.map(({ runId, outcome, reason }) => ({ runId, outcome, reason }))).toEqual([
      { runId: 'new', outcome: 'success', reason: undefined },
      { runId: 'old', outcome: 'failure', reason: 'Not logged in' },
    ]);
    expect(reports[0]?.attentionKeys).toContain('task-finished:alpha:new:2026-11-12T07:50:00.000Z');
    answer = 'gone';
    emit({ id: 'later', status: 'running', ...trigger('a1') });
    emit({ id: 'later', status: 'done', ...trigger('a1') });
    await vi.waitFor(() => expect(unlink).toHaveBeenCalledWith('a1'));
    off();
    expect(store.listenerCount('run')).toBe(0);
  });
});
