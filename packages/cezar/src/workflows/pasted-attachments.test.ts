import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentBlock } from '../core/agent-runner.ts';
import { HANDOFF_INSTRUCTIONS } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import {
  fileExtensionFor,
  isImageAttachment,
  mediaTypeFor,
  pastedAttachmentsNote,
  pastedAttachmentsText,
  RunManager,
} from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

// 1x1 transparent PNG — small enough to inline, real enough to round-trip through base64.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** The static system-prompt note every agent step gets (#357) — the agent
 *  contract that says "use the on-disk path, the inline image is view-only". */
describe('HANDOFF_INSTRUCTIONS pasted-attachments note', () => {
  it('tells the agent pasted files are real files with paths, not just inline images', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('## Pasted attachments');
    expect(HANDOFF_INSTRUCTIONS).toMatch(/saved as real files/);
    expect(HANDOFF_INSTRUCTIONS).toMatch(/the inline image is for viewing only/);
  });
});

/**
 * Pure formatting helpers behind the "pasted attachment" note (#357) — the
 * text every pasted image's on-disk path is announced through, whether it
 * rides inline in `userPrompt` (task start) or as a trailing ContentBlock
 * (follow-up messages, see `RunManager.sendMessage`).
 */
describe('pastedAttachmentsText / pastedAttachmentsNote', () => {
  it('lists absolute paths and uses singular wording for one file', () => {
    const text = pastedAttachmentsText([{ name: 'pasted-1.png', url: '/api/v1/x', path: '/abs/pasted-1.png' }]);
    expect(text).toContain('The user attached 1 pasted file, also saved on disk at:');
    expect(text).toContain('- /abs/pasted-1.png');
    expect(text).not.toContain('files,');
  });

  it('uses plural wording and lists every path for multiple files', () => {
    const text = pastedAttachmentsText([
      { name: 'pasted-1.png', url: '/api/v1/x', path: '/abs/pasted-1.png' },
      { name: 'pasted-2.jpg', url: '/api/v1/y', path: '/abs/pasted-2.jpg' },
    ]);
    expect(text).toContain('The user attached 2 pasted files, also saved on disk at:');
    expect(text).toContain('- /abs/pasted-1.png\n- /abs/pasted-2.jpg');
  });

  it('tells the agent to operate on the files, not reconstruct them', () => {
    const text = pastedAttachmentsText([{ name: 'pasted-1.png', url: '/api/v1/x', path: '/abs/pasted-1.png' }]);
    expect(text).toMatch(/operate on these files/);
    expect(text).toMatch(/do not attempt to reconstruct/);
  });

  it('wraps the same text as a trailing text ContentBlock', () => {
    const attachments = [{ name: 'pasted-1.png', url: '/api/v1/x', path: '/abs/pasted-1.png' }];
    expect(pastedAttachmentsNote(attachments)).toEqual({ type: 'text', text: pastedAttachmentsText(attachments) });
  });
});

/**
 * The naming rules behind a run's attachment folder. One folder holds screenshots, pasted images
 * and attached text files, so the on-disk EXTENSION is the only thing that says which is which —
 * `readPersistedAttachments` re-encodes an image from it and must never re-encode a `.md`.
 */
describe('attachment naming', () => {
  it('reads an image by its extension', () => {
    expect(isImageAttachment('pasted-1.png')).toBe(true);
    expect(isImageAttachment('screenshot-2.jpg')).toBe(true);
    // The fallback extension `persistImage` writes for an unrecognized image media type.
    expect(isImageAttachment('pasted-3.img')).toBe(true);
    expect(isImageAttachment('pasted-4.md')).toBe(false);
    expect(isImageAttachment('pasted-5')).toBe(false);
  });

  it('keeps the user file’s extension so the agent gets a `.md` it can read', () => {
    expect(fileExtensionFor('BRIEF.md')).toBe('md');
    expect(fileExtensionFor('server.log')).toBe('log');
    expect(fileExtensionFor('data.tar.gz')).toBe('gz');
  });

  /** The name is user input. Only the extension is ever honoured, and anything that could leave
   *  the folder — or claim to be an image — degrades to `txt` rather than reaching the disk. */
  it('sanitizes an extension it cannot vouch for', () => {
    expect(fileExtensionFor('no-extension')).toBe('txt');
    expect(fileExtensionFor('../../etc/passwd')).toBe('txt');
    expect(fileExtensionFor('trick.md/../../evil')).toBe('txt');
    expect(fileExtensionFor('spaced. md')).toBe('txt');
    expect(fileExtensionFor('longer.extensionthanallowed')).toBe('txt');
    // A text file must not be able to name itself into the image branch.
    expect(fileExtensionFor('notes.png')).toBe('txt');
  });

  it('maps an image name back to its media type for re-encoding', () => {
    expect(mediaTypeFor('pasted-1.png')).toBe('image/png');
    expect(mediaTypeFor('pasted-2.jpg')).toBe('image/jpeg');
    expect(mediaTypeFor('pasted-3.webp')).toBe('image/webp');
    expect(mediaTypeFor('pasted-4.gif')).toBe('image/gif');
  });
});

/**
 * End-to-end through the real engine with CEZ_DRY_RUN=1 (#357): a pasted
 * screenshot must land as a real file under `.ai/cezar/runs/<id>-images/`
 * (named `pasted-<n>.<ext>`, never `screenshot-<n>.<ext>` — that prefix stays
 * reserved for the agent's own tool screenshots) and its absolute path must
 * reach the agent in the prompt/message text — verified via the mock's
 * CEZ_MOCK_STDIN_FILE hook, which captures the untruncated inbound text.
 */
describe('pasted screenshots materialize to disk and reach the agent as file paths', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;
  let argsFile: string;
  let stdinFile: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-pasted-'));
    dataDir = join(repoRoot, '.ai/cezar');
    argsFile = join(repoRoot, 'mock-args.ndjson');
    stdinFile = join(repoRoot, 'mock-stdin.ndjson');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ maxParallel: 1 }));
    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function readStdinLines(): Array<{ userText: string; imageCount: number }> {
    return readFileSync(stdinFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function waitForStatus(runId: string, statuses: string[], timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = store.getRun(runId)?.status;
      if (status && statuses.includes(status)) return status;
      if (Date.now() > deadline) throw new Error(`run did not reach ${statuses.join('/')} in time (was ${status})`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('a task-start pasted image is saved as pasted-1.png and its path lands in the opening prompt', async () => {
    writeFileSync(argsFile, '', 'utf8');
    writeFileSync(stdinFile, '', 'utf8');
    // Agent step + trailing check so the run reaches a terminal status
    // instead of parking at `waiting` (same shape as system-prompt.test.ts).
    const workflow: WorkflowDef = {
      name: 'pasted-start-test',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}' },
        { id: 'verify', command: 'true' },
      ],
    };
    const image: ContentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
    };
    const holder: WorkflowDef = {
      name: 'hold-slot',
      source: 'built-in',
      steps: [{ id: 'hold', command: `${process.execPath} -e "setTimeout(() => {}, 500)"` }],
    };
    manager.startRun(holder, { task: 'occupy the only slot', worktree: false });
    const record = manager.startRun(workflow, {
      task: 'save the pasted screenshot to disk',
      images: [image],
      worktree: false,
    });

    // The task image is durable and renderable before `execute()` gets a slot.
    const queued = store.getRun(record.id);
    expect(queued?.status).toBe('queued');
    expect(queued?.taskImages).toEqual([`/api/v1/runs/${record.id}/images/pasted-1.png`]);
    expect(existsSync(join(dataDir, 'runs', `${record.id}-images`, 'pasted-1.png'))).toBe(true);

    await waitForStatus(record.id, ['done', 'review', 'failed', 'cancelled']);

    const after = store.getRun(record.id);
    expect(after?.status, after?.error).toMatch(/^(done|review)$/);
    expect(after?.taskImages?.length).toBe(1);
    expect(after?.taskImages?.[0]).toMatch(/\/images\/pasted-1\.png$/);

    const filePath = join(dataDir, 'runs', `${record.id}-images`, 'pasted-1.png');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).equals(Buffer.from(TINY_PNG_B64, 'base64'))).toBe(true);
    expect(readdirSync(join(dataDir, 'runs', `${record.id}-images`)).filter((name) => name.startsWith('pasted-'))).toEqual([
      'pasted-1.png',
    ]);

    const lines = readStdinLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]?.imageCount).toBe(1);
    expect(lines[0]?.userText).toContain('The user attached 1 pasted file, also saved on disk at:');
    expect(lines[0]?.userText).toContain(`- ${filePath}`);

    // The base64 bytes never enter the NDJSON event log (only the name/url pair does).
    const ndjson = readFileSync(join(dataDir, 'runs', `${record.id}.ndjson`), 'utf8');
    expect(ndjson).not.toContain(TINY_PNG_B64);
  }, 30_000);

  it('a follow-up pasted image is saved and its path is appended to the delivered message', async () => {
    writeFileSync(stdinFile, '', 'utf8');
    // A single agent step with no trailing check stays interactive — it parks
    // at `waiting` after its first turn so a follow-up can be sent.
    const workflow: WorkflowDef = {
      name: 'pasted-followup-test',
      source: 'built-in',
      steps: [{ id: 'work', prompt: '{{task}}' }],
    };
    const record = manager.startRun(workflow, { task: 'chat with me' });
    await waitForStatus(record.id, ['waiting']);

    const image: ContentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: TINY_PNG_B64 },
    };
    const delivered = manager.sendMessage(record.id, [{ type: 'text', text: 'here is a screenshot' }, image]);
    expect(delivered).toBe(true);

    // Back to `waiting` once the mock's follow-up turn completes.
    await waitForStatus(record.id, ['waiting']);

    const lines = readStdinLines();
    const followUp = lines.find((line) => line.userText.includes('here is a screenshot'));
    expect(followUp).toBeDefined();
    expect(followUp?.userText).toContain('The user attached 1 pasted file, also saved on disk at:');

    // The mock's own turn-1 tool screenshot shares the same on-disk counter, so
    // this pasted follow-up doesn't have to land on seq 1 — it must land on
    // *some* `pasted-<n>.jpg`, with the exact path echoed back in the prompt.
    const pathMatch = followUp?.userText.match(/- (.*pasted-\d+\.jpg)/);
    expect(pathMatch).toBeTruthy();
    const filePath = pathMatch?.[1] as string;
    expect(filePath).toMatch(new RegExp(`^${join(dataDir, 'runs', `${record.id}-images`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pasted-\\d+\\.jpg$`));
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).equals(Buffer.from(TINY_PNG_B64, 'base64'))).toBe(true);

    manager.finish(record.id);
  }, 30_000);

  /** Continue takes a prompt of its own, and the composer that writes it is a full composer —
   *  so a screenshot pasted into a CLOSED run's composer has to travel the same road as one
   *  pasted mid-session: onto disk, into the thread's bubble, and into the reopened session's
   *  opening message as both an inline image and an absolute path. */
  it('a Continue pasted image is saved, rendered on the bubble, and reaches the reopened session', async () => {
    writeFileSync(stdinFile, '', 'utf8');
    const workflow: WorkflowDef = {
      name: 'pasted-continue-test',
      source: 'built-in',
      steps: [{ id: 'work', prompt: '{{task}}' }],
    };
    const record = manager.startRun(workflow, { task: 'do a thing' });
    await waitForStatus(record.id, ['waiting']);
    manager.finish(record.id);
    await waitForStatus(record.id, ['done', 'review']);

    writeFileSync(stdinFile, '', 'utf8');
    const image: ContentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
    };
    expect(manager.continueRun(record.id, { text: 'fix what this shows', images: [image] })).toEqual({
      ok: true,
    });
    await waitForStatus(record.id, ['waiting']);

    const reopened = readStdinLines().find((line) => line.userText.includes('fix what this shows'));
    expect(reopened).toBeDefined();
    // Inline, so the model can view it…
    expect(reopened?.imageCount).toBe(1);
    // …and on disk, so it can operate on it.
    const pathMatch = reopened?.userText.match(/- (.*pasted-\d+\.png)/);
    expect(pathMatch).toBeTruthy();
    const filePath = pathMatch?.[1] as string;
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).equals(Buffer.from(TINY_PNG_B64, 'base64'))).toBe(true);

    // The thread renders the bubble's image, not a bare count — and the base64 stays out of
    // the event log, exactly as on the task-start and follow-up paths.
    const ndjson = readFileSync(join(dataDir, 'runs', `${record.id}.ndjson`), 'utf8');
    const userMessage = ndjson
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string; images?: string[] })
      .find((event) => event.type === 'user-message' && event.text === 'fix what this shows');
    expect(userMessage?.images?.[0]).toBe(`/api/v1/runs/${record.id}/images/${filePath.split('/').pop()}`);
    expect(ndjson).not.toContain(TINY_PNG_B64);

    manager.finish(record.id);
  }, 40_000);

  /**
   * The text half of the same road. A `.md` brief has nothing to look at, so it never becomes an
   * image block: it is written to the run's attachment folder under its own extension and reaches
   * the agent as a PATH, which is the form its file tools can act on. The base64 must not appear
   * in the prompt — inlining it is exactly what this design avoids.
   */
  it('an attached text file is saved as pasted-<n>.md and reaches the agent as a path, never inline', async () => {
    writeFileSync(argsFile, '', 'utf8');
    writeFileSync(stdinFile, '', 'utf8');
    const workflow: WorkflowDef = {
      name: 'attached-file-test',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}' },
        { id: 'verify', command: 'true' },
      ],
    };
    const body = '# Brief\n\nShip the thing.\n';
    const record = manager.startRun(workflow, {
      task: 'read the attached brief',
      files: [{ name: 'BRIEF.md', mediaType: 'text/markdown', data: Buffer.from(body).toString('base64') }],
      worktree: false,
    });

    await waitForStatus(record.id, ['done', 'review', 'failed', 'cancelled']);
    const after = store.getRun(record.id);
    expect(after?.status, after?.error).toMatch(/^(done|review)$/);
    // Attachments are ONE list: the file rides `taskImages` like a pasted image does, because
    // that list is what the bubble, the orphan sweep and the dequeue all read.
    expect(after?.taskImages).toEqual([`/api/v1/runs/${record.id}/images/pasted-1.md`]);

    const filePath = join(dataDir, 'runs', `${record.id}-images`, 'pasted-1.md');
    expect(readFileSync(filePath, 'utf8')).toBe(body);

    const opening = readStdinLines()[0];
    expect(opening?.userText).toContain('The user attached 1 pasted file, also saved on disk at:');
    expect(opening?.userText).toContain(`- ${filePath}`);
    // Named, not inlined — and not smuggled in as an image either.
    expect(opening?.userText).not.toContain(body);
    expect(opening?.imageCount).toBe(0);
  }, 30_000);

  /** The same file attached to a LIVE session: persisted at delivery and appended to the message
   *  the session receives. */
  it('a follow-up text file is saved and its path is appended to the delivered message', async () => {
    writeFileSync(stdinFile, '', 'utf8');
    const workflow: WorkflowDef = {
      name: 'attached-file-followup-test',
      source: 'built-in',
      steps: [{ id: 'work', prompt: '{{task}}' }],
    };
    const record = manager.startRun(workflow, { task: 'chat about a file' });
    await waitForStatus(record.id, ['waiting']);

    const delivered = manager.sendMessage(
      record.id,
      [{ type: 'text', text: 'here are the notes' }],
      [{ name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('two lines\n').toString('base64') }],
    );
    expect(delivered).toBe(true);
    await waitForStatus(record.id, ['waiting']);

    const followUp = readStdinLines().find((line) => line.userText.includes('here are the notes'));
    const pathMatch = followUp?.userText.match(/- (.*pasted-\d+\.txt)/);
    expect(pathMatch).toBeTruthy();
    expect(readFileSync(pathMatch?.[1] as string, 'utf8')).toBe('two lines\n');

    manager.finish(record.id);
  }, 30_000);
});
