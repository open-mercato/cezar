import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHandoffCommand, type HandoffCliIo } from './handoff-cli.ts';
import { HANDOFF_ONLY_INSTRUCTIONS, seedHandoffFile } from './handoff.ts';

const NOW = new Date('2026-09-28T11:21:22.000Z');
const TS = NOW.toISOString();

let dir: string;
let file: string;
let out: string[];
let err: string[];

function io(stdin: string | null = null): HandoffCliIo {
  return {
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    readStdin: async () => stdin,
    now: () => NOW,
  };
}

function run(args: string[], stdin: string | null = null): Promise<number> {
  return runHandoffCommand(args, { CEZ_HANDOFF_FILE: file }, io(stdin));
}

const read = () => readFileSync(file, 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-handoff-cli-'));
  file = seedHandoffFile(dir, { id: 'run-1', title: 'Draft', workflow: 'quick-task', task: 'Draft the reply.' });
  out = [];
  err = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SEED_HEAD = '# Handoff — Draft\n\n**Task id:** run-1\n**Workflow:** quick-task\n\n## Goal\n\nDraft the reply.\n\n';

describe('cez handoff log', () => {
  /**
   * agents-master I049: the evidence run (SDRC 20c6bc72, seq 314) inserted this note with
   * `s.replace('## Progress log\n', '## Progress log\n\n' + line)` on a freshly seeded file.
   * The command must produce the same file — only the timestamp token differs (cez writes the
   * same `<ISO> — ` prefix as its own heartbeat lines).
   */
  it('replays the evidence-run edit: same file as the inline python, bar the timestamp', async () => {
    const note =
      'Completed: Gmail draft UID 16491 to m.maslanka@mdmnt.com, verified by read_email including recipient, HTML and full body. No email sent, contracts/P&L unchanged.';
    const python = read().replace('## Progress log\n', `## Progress log\n\n- 2026-09-28T13:21:22+02:00 ${note}\n`);

    expect(await run(['log', note])).toBe(0);

    const normalize = (s: string) => s.replace(/^- \S+ (— )?/gm, '- <ts> ');
    expect(normalize(read())).toBe(normalize(python));
    expect(read()).toBe(`${SEED_HEAD}## Progress log\n\n- ${TS} — ${note}\n\n## Resume notes\n`);
  });

  it('puts the newest line at the top and folds a multi-line note onto one line', async () => {
    await run(['log', 'first']);
    await run(['log', 'second\n  line two']);
    expect(read()).toBe(`${SEED_HEAD}## Progress log\n\n- ${TS} — second line two\n- ${TS} — first\n\n## Resume notes\n`);
  });

  it('joins unquoted words and refuses an empty line', async () => {
    expect(await run(['log', 'tests', 'pass'])).toBe(0);
    expect(read()).toContain(`- ${TS} — tests pass\n`);
    expect(await run(['log', '  '])).toBe(2);
    expect(err.join('\n')).toContain('give the line to log');
  });
});

describe('cez handoff resume', () => {
  it('replaces the section from an argument, as the omskills evidence run did with split()', async () => {
    const notes = 'Read-only status investigation. Check upstream PR #4319 before answering.';
    const python = `${read().split('## Resume notes')[0]}## Resume notes\n\n${notes}\n`;
    expect(await run(['resume', notes])).toBe(0);
    expect(read()).toBe(python);
    expect(await run(['resume', 'newer notes'])).toBe(0);
    expect(read()).toBe(`${SEED_HEAD}## Progress log\n\n## Resume notes\n\nnewer notes\n`);
  });

  it('takes multi-line notes from stdin', async () => {
    expect(await run(['resume'], 'Done: A.\nNext: B.\n')).toBe(0);
    expect(read().endsWith('## Resume notes\n\nDone: A.\nNext: B.\n')).toBe(true);
  });

  it('clears the section with an empty argument', async () => {
    await run(['resume', 'old']);
    expect(await run(['resume', ''])).toBe(0);
    expect(read()).toBe(`${SEED_HEAD}## Progress log\n\n## Resume notes\n`);
  });

  it('keeps a section that follows Resume notes, and the progress log, untouched', async () => {
    await run(['log', 'milestone']);
    writeFileSync(file, `${read()}\nold notes\n\n## Extra\n\nkeep me\n`);
    await run(['resume', 'fresh']);
    expect(read()).toBe(
      `${SEED_HEAD}## Progress log\n\n- ${TS} — milestone\n\n## Resume notes\n\nfresh\n\n## Extra\n\nkeep me\n`,
    );
  });

  it('appends the section when the file has none', async () => {
    writeFileSync(file, '# Handoff\n');
    await run(['resume', 'notes']);
    expect(read()).toBe('# Handoff\n\n## Resume notes\n\nnotes\n');
  });

  it('refuses a bare resume at a terminal instead of silently clearing', async () => {
    await run(['resume', 'keep']);
    expect(await run(['resume'], null)).toBe(2);
    expect(read()).toContain('keep');
  });
});

describe('cez handoff — guards', () => {
  it('exits 2 without CEZ_HANDOFF_FILE', async () => {
    expect(await runHandoffCommand(['log', 'x'], {}, io())).toBe(2);
    expect(err.join('\n')).toContain('CEZ_HANDOFF_FILE is not set');
  });

  it('exits 1 when the file cannot be read', async () => {
    expect(await runHandoffCommand(['log', 'x'], { CEZ_HANDOFF_FILE: join(dir, 'nope.md') }, io())).toBe(1);
  });

  it('prints usage for no command and rejects an unknown one', async () => {
    expect(await run([])).toBe(2);
    expect(out.join('\n')).toContain('cez handoff log');
    expect(await run(['show'])).toBe(2);
  });

  it('the system prompt names both commands through the cockpit binary', () => {
    expect(HANDOFF_ONLY_INSTRUCTIONS).toContain('node "$CEZ_BIN" handoff log');
    expect(HANDOFF_ONLY_INSTRUCTIONS).toContain('node "$CEZ_BIN" handoff resume');
  });
});
