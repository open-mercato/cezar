import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendHandoffHeartbeat, HANDOFF_INSTRUCTIONS, handoffPath } from './handoff.ts';
import { todoSchema } from './todos.ts';

const RUN_ID = 'run-1215';

function journal(dataDir: string, progress: string, resume = 'keep this') {
  const file = handoffPath(dataDir, RUN_ID);
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  writeFileSync(
    file,
    `# Handoff\n\n## Goal\n\nGoal\n\n## Progress log\n\n${progress}\n## Resume notes\n\n${resume}\n`,
  );
  return file;
}

describe('appendHandoffHeartbeat bounded progress log', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cezar-handoff-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces adjacent same-note heartbeats and extends an existing count', () => {
    journal(
      dataDir,
      '- 2026-10-08T00:00:00Z — turn complete — status=running (×2)\n' +
        '- 2026-10-07T23:00Z — turn complete — status=running\n' +
        '- 2026-10-07T22:00:00.000Z — step "build" complete — status=done',
    );
    vi.setSystemTime(new Date('2026-10-08T01:00:00.000Z'));

    appendHandoffHeartbeat(dataDir, RUN_ID, 'turn complete — status=running');

    const text = readFileSync(handoffPath(dataDir, RUN_ID), 'utf8');
    expect(text).toContain('- 2026-10-08T01:00:00.000Z — turn complete — status=running (×4)');
    expect(text).toContain('- 2026-10-07T22:00:00.000Z — step "build" complete — status=done');
    expect(text).not.toContain('2026-10-07T23:00Z');
  });

  it('does not coalesce across agent lines, note changes, blanks, or section boundaries', () => {
    journal(
      dataDir,
      '- 2026-10-08T00:00:00Z — turn complete — status=running\n' +
        '- 2026-10-07T23:00:00Z — agent copied this timestamped note\n' +
        '- 2026-10-07T22:00:00Z — turn complete — status=running\n' +
        '\n' +
        '- 2026-10-07T21:00:00Z — turn complete — status=running',
    );
    vi.setSystemTime(new Date('2026-10-08T01:00:00.000Z'));

    appendHandoffHeartbeat(dataDir, RUN_ID, 'turn complete — status=running');

    const text = readFileSync(handoffPath(dataDir, RUN_ID), 'utf8');
    expect(text.match(/turn complete — status=running/g)).toHaveLength(3);
    expect(text).toContain('- 2026-10-07T23:00:00Z — agent copied this timestamped note');
    expect(text).toContain('\n\n- 2026-10-07T21:00:00Z');
  });

  it('caps distinct eligible heartbeat entries while retaining newest entries and other content', () => {
    const oldEntries = Array.from(
      { length: 101 },
      (_, index) =>
        `- 2026-10-07T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z — turn complete — status=${100 - index}`,
    ).join('\n');
    journal(dataDir, `${oldEntries}\n- 2026-10-07T00:00:00Z — agent milestone`);
    vi.setSystemTime(new Date('2026-10-08T01:00:00.000Z'));

    appendHandoffHeartbeat(dataDir, RUN_ID, 'step "new" complete — status=done');

    const text = readFileSync(handoffPath(dataDir, RUN_ID), 'utf8');
    const progress = text.slice(text.indexOf('## Progress log'), text.indexOf('## Resume notes'));
    expect(progress.match(/^- .* — (?:turn complete|step ")/gm)).toHaveLength(100);
    expect(progress).toContain('step "new" complete — status=done');
    expect(progress).not.toContain('status=0');
    expect(progress).toContain('- 2026-10-07T00:00:00Z — agent milestone');
    expect(text).toContain('## Goal\n\nGoal');
    expect(text).toContain('## Resume notes\n\nkeep this');
  });

  it('accepts minute-precision and legacy bare timestamps, but leaves non-engine lines intact', () => {
    journal(
      dataDir,
      '2026-10-08T00:00Z — turn complete — status=running\n' +
        '2026-10-07T23:00:58.028Z — turn complete — status=running\n' +
        '- 2026-10-07T22:00:58Z — user milestone',
    );
    vi.setSystemTime(new Date('2026-10-08T01:00:00.000Z'));

    appendHandoffHeartbeat(dataDir, RUN_ID, 'turn complete — status=running');

    const text = readFileSync(handoffPath(dataDir, RUN_ID), 'utf8');
    expect(text).toContain('- 2026-10-08T01:00:00.000Z — turn complete — status=running (×3)');
    expect(text).toContain('- 2026-10-07T22:00:58Z — user milestone');
  });

  it('preserves impossible timestamps and avoids unsafe count summation', () => {
    journal(
      dataDir,
      '- 2026-99-08T00:00:00Z — turn complete — status=bad\n' +
        '- 2026-10-08T00:00:00Z — turn complete — status=running (×9007199254740991)',
    );
    vi.setSystemTime(new Date('2026-10-08T01:00:00.000Z'));

    appendHandoffHeartbeat(dataDir, RUN_ID, 'turn complete — status=running');

    const text = readFileSync(handoffPath(dataDir, RUN_ID), 'utf8');
    expect(text).toContain('- 2026-99-08T00:00:00Z — turn complete — status=bad');
    expect(text).toContain(
      '- 2026-10-08T00:00:00Z — turn complete — status=running (×9007199254740991)',
    );
    expect(text).toContain('- 2026-10-08T01:00:00.000Z — turn complete — status=running');
    expect(text).not.toContain('(×9007199254740992)');
  });

  it('keeps header-less append and missing-file no-op behavior', () => {
    const file = handoffPath(dataDir, RUN_ID);
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    writeFileSync(file, '# Handoff without the progress marker');
    vi.setSystemTime(new Date('2026-10-08T01:00:00.000Z'));

    appendHandoffHeartbeat(dataDir, RUN_ID, 'picked from variant-a');
    expect(readFileSync(file, 'utf8')).toBe(
      '# Handoff without the progress marker\n- 2026-10-08T01:00:00.000Z — picked from variant-a\n',
    );

    appendHandoffHeartbeat(dataDir, 'missing-run', 'turn complete — status=running');
    expect(readFileSync(file, 'utf8')).toContain('picked from variant-a');
  });
});

/**
 * HANDOFF_INSTRUCTIONS is the only thing that tells an agent what to append to todos.json,
 * so a field can be added to todoSchema and still never be written by anyone. `runnable`
 * shipped exactly that way. This pins the contract instead of the prose: every agent-writable
 * schema field has to appear in the instructions.
 */
describe('HANDOFF_INSTRUCTIONS', () => {
  /** The server assigns these on read/start — an agent never writes them. */
  const SERVER_MANAGED = new Set(['id', 'startedTaskId']);

  it('documents every agent-writable field of todoSchema', () => {
    const undocumented = Object.keys(todoSchema.shape)
      .filter((field) => !SERVER_MANAGED.has(field))
      .filter((field) => !HANDOFF_INSTRUCTIONS.includes(`"${field}"`));

    expect(undocumented).toEqual([]);
  });

  it('tells the agent which way to set runnable, so notes are acknowledged and not run', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": false');
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": true');
    expect(HANDOFF_INSTRUCTIONS).toContain('Acknowledge');
  });
});

/**
 * #933 — a task that had dispatched sub-agents and was waiting only on them showed as
 * "needs you", with the "paused, waiting for your reply" footer and a browser notification.
 * The transcript evidence put it on the BEHAVIORAL branch: cezar has no sub-agent-completion
 * event, so this paragraph is the only thing that makes the agent declare the state, and the
 * pre-#933 wording ("a sub-agent you dispatched") never said whether a sub-agent that hands
 * control back immediately and reports later still counts.
 *
 * These pin the contract, not the prose: the case has to be named, and the example has to end
 * on the marker — an example whose last line is anything else teaches the wrong shape, since
 * detection is anchored at the end of the turn (`MONITORING_MARKER_RE`).
 */
describe('HANDOFF_INSTRUCTIONS — the still-working marker contract (#933)', () => {
  const paragraph = HANDOFF_INSTRUCTIONS.slice(
    HANDOFF_INSTRUCTIONS.indexOf('Still-working marker:'),
    HANDOFF_INSTRUCTIONS.indexOf('Structured question marker:'),
  );

  it('extracts a non-empty paragraph to assert on', () => {
    expect(paragraph.startsWith('Still-working marker:')).toBe(true);
    expect(paragraph).toContain('CEZ:MONITORING');
  });

  it('names dispatching a sub-agent as the case the marker exists for', () => {
    expect(paragraph).toContain('Dispatching a sub-agent is exactly this case');
  });

  it('covers a sub-agent that reports back after the turn, not only one that finishes inside it', () => {
    expect(paragraph).toContain('background');
    expect(paragraph).toContain('completion notification');
  });

  it('carries a worked example whose last line is exactly the marker', () => {
    const example = paragraph
      .split('\n')
      .filter((line) => line.startsWith('    '))
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(example.length).toBeGreaterThanOrEqual(2);
    expect(example[example.length - 1]).toBe('CEZ:MONITORING');
    expect(example[0]).toContain('sub-agents');
  });

  /**
   * The belt to the engine's braces: `run.ts` now tolerates trailing task-reference lines, but
   * the contract should still ask for the ordering that needs no tolerance.
   */
  it('tells the agent to keep task-reference markers above the turn-end markers', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('above any CEZ:DONE / CEZ:MONITORING line');
  });
});
