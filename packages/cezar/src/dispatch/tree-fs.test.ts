import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLedger,
  inboxDigest,
  inboxName,
  listInbox,
  treeEnvelopeLines,
  notesSuggestions,
  seedNotes,
  shortId,
  taskPaths,
  writeBrief,
  writeInboxMessage,
  writeOrder,
  writeReport,
} from './tree-fs.ts';

/**
 * The tree directory (the filesystem channel): every path a task is told about exists where
 * the order says, every reader degrades to "nothing there", and the inbox listing is what the
 * engine's wake and digest are built on.
 */
describe('the tree directory', () => {
  let dataDir: string;
  const MISSION = 'aaaaaaaa-1111-2222-3333-444444444444';
  const CHILD = 'bbbbbbbb-1111-2222-3333-444444444444';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-tree-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('addresses the root as `root` and every other unit by its id8 — the branch handle', () => {
    expect(shortId(CHILD)).toBe('bbbbbbbb');
    expect(inboxName(MISSION, MISSION)).toBe('root');
    expect(inboxName(CHILD, MISSION)).toBe('bbbbbbbb');
    const paths = taskPaths(dataDir, MISSION, CHILD);
    expect(paths.inbox).toBe(join(dataDir, 'dispatch', MISSION, 'inbox', 'bbbbbbbb'));
    expect(paths.rootInbox).toBe(join(dataDir, 'dispatch', MISSION, 'inbox', 'root'));
    expect(paths.notes).toBe(join(dataDir, 'dispatch', MISSION, 'units', 'bbbbbbbb', 'notes.md'));
  });

  it('writes the brief once from the root’s objective, and never overwrites it', () => {
    const path = writeBrief(dataDir, MISSION, 'Ship the thing\n\n## Constraints\n- never touch billing');
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('## Objective');
    expect(text).toContain('Ship the thing');
    expect(text).toContain('- never touch billing');
    expect(text).toContain('inbox/root/');
    writeBrief(dataDir, MISSION, 'something else');
    expect(readFileSync(path, 'utf8')).toContain('Ship the thing');
  });

  it('writes an order and seeds notes once — the notes file is the unit’s own after that', () => {
    writeOrder(dataDir, MISSION, CHILD, { title: 'Left flank', kind: 'implement', parentRunId: MISSION, text: 'take it' });
    const paths = taskPaths(dataDir, MISSION, CHILD);
    expect(readFileSync(paths.order, 'utf8')).toContain('take it');
    seedNotes(dataDir, MISSION, CHILD, 'Left flank');
    writeFileSync(paths.notes, '# mine now\n\n## Suggestions for the root\n\n- split billing out\n');
    seedNotes(dataDir, MISSION, CHILD, 'Left flank'); // a second seed must not clobber
    expect(readFileSync(paths.notes, 'utf8')).toContain('# mine now');
    expect(notesSuggestions(dataDir, MISSION, CHILD)).toBe('- split billing out');
  });

  it('reads no suggestions from a fresh seed and none from a missing notes file', () => {
    expect(notesSuggestions(dataDir, MISSION, CHILD)).toBe('');
    seedNotes(dataDir, MISSION, CHILD, 'Left flank');
    expect(notesSuggestions(dataDir, MISSION, CHILD)).toBe('');
  });

  it('lists inbox files newer than the watermark, oldest first, and nothing for a missing inbox', () => {
    expect(listInbox(dataDir, MISSION, 'root')).toEqual([]);
    const older = writeInboxMessage(dataDir, MISSION, 'root', { from: CHILD, subject: 'First', body: 'one' });
    const newer = writeInboxMessage(dataDir, MISSION, 'root', { from: CHILD, subject: 'Second', body: 'two' });
    const t0 = new Date('2026-09-09T10:00:00.000Z');
    utimesSync(older, t0, t0);
    const t1 = new Date('2026-09-09T11:00:00.000Z');
    utimesSync(newer, t1, t1);
    expect(listInbox(dataDir, MISSION, 'root').map((item) => item.path)).toEqual([older, newer]);
    expect(listInbox(dataDir, MISSION, 'root', '2026-09-09T10:30:00.000Z').map((item) => item.path)).toEqual([newer]);
    expect(listInbox(dataDir, MISSION, 'root', '2026-09-09T12:00:00.000Z')).toEqual([]);
    const digest = inboxDigest(listInbox(dataDir, MISSION, 'root'), taskPaths(dataDir, MISSION, MISSION).inbox);
    expect(digest).toContain('2 new messages');
    expect(digest).toContain(older);
    expect(inboxDigest([], 'x')).toBeUndefined();
  });

  it('names an inbox message by instant, sender and subject, and writes a readable header', () => {
    const path = writeInboxMessage(dataDir, MISSION, 'cccccccc', { from: CHILD, subject: 'Scope overlap?', body: 'we both touch auth' });
    expect(path).toMatch(/inbox\/cccccccc\/.*-bbbbbbbb-scope-overlap\.md$/);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# Scope overlap?');
    expect(text).toContain(`- From: ${CHILD}`);
    expect(text).toContain('we both touch auth');
  });

  it('writes the report file and appends ledger lines, best effort', () => {
    writeReport(dataDir, MISSION, CHILD, 'Report from centurion: status done', { status: 'done' });
    expect(readFileSync(taskPaths(dataDir, MISSION, CHILD).report, 'utf8')).toContain('"status": "done"');
    appendLedger(dataDir, MISSION, { type: 'spawn', runId: CHILD });
    appendLedger(dataDir, MISSION, { type: 'settle', runId: CHILD });
    const lines = readFileSync(join(dataDir, 'dispatch', MISSION, 'ledger.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'settle', runId: CHILD });
    expect(existsSync(join(dataDir, 'dispatch', MISSION, 'brief.md'))).toBe(false); // nothing is required
  });

  it('spells the task-order lines a unit needs to find its files', () => {
    const lines = treeEnvelopeLines(taskPaths(dataDir, MISSION, CHILD));
    expect(lines.some((line) => line.includes('brief.md') && /read it FIRST/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes('notes.md'))).toBe(true);
    expect(lines.some((line) => line.includes('inbox/root/'))).toBe(true);
  });
});
