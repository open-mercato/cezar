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
  RunManager,
  contentBlocksOf,
  mediaTypeFor,
  pastedAttachmentsNote,
  pastedAttachmentsText,
  toPastedContent,
  type PastedContent,
} from './run.ts';
import { attachmentExtension, isAttachmentMediaType, isImageAttachmentName } from '@open-mercato/cezar-contract';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

// 1x1 transparent PNG — small enough to inline, real enough to round-trip through base64.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// A markdown brief and a minimal PDF (#950) — the two non-image attachments the composer takes.
// Their CONTENT is the thing every assertion below is about: it must reach disk and never the
// prompt, which is the whole point of handing the agent a path instead of the bytes.
const BRIEF_MD = '# Brief\n\nShip the alpha-particle report.\n';
const BRIEF_MD_B64 = Buffer.from(BRIEF_MD).toString('base64');
const TINY_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const TINY_PDF_B64 = Buffer.from(TINY_PDF).toString('base64');

/** The static system-prompt note every agent step gets (#357) — the agent
 *  contract that says "use the on-disk path, the inline image is view-only". */
describe('HANDOFF_INSTRUCTIONS pasted-attachments note', () => {
  it('tells the agent pasted files are real files with paths, not just inline images', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('## Pasted attachments');
    expect(HANDOFF_INSTRUCTIONS).toMatch(/saved as real files/);
    expect(HANDOFF_INSTRUCTIONS).toMatch(/that copy is for viewing only/);
  });

  /** #950 — a file has no inline copy at all, and an agent that assumes one would answer about a
   *  document it never saw. The contract has to say so, not merely imply it. */
  it('says a non-image attachment exists only as the file on disk', () => {
    expect(HANDOFF_INSTRUCTIONS).toMatch(/PDF, TXT, MD/);
    expect(HANDOFF_INSTRUCTIONS).toMatch(/a non-image attachment exists ONLY as the file at that path/);
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
 * The attachment vocabulary shared by the wire, the engine and the cockpit (#950). One mapping
 * lives in `packages/contract` precisely so a file cannot be stored under one rule and read back
 * under another — these cases pin both directions of that round trip.
 */
describe('attachment media types, extensions and blocks (#950)', () => {
  it('accepts images and the PDF/TXT/MD allowlist, and nothing else', () => {
    expect(isAttachmentMediaType('image/png')).toBe(true);
    expect(isAttachmentMediaType('image/svg+xml')).toBe(true); // unchanged: images were never narrowed
    expect(isAttachmentMediaType('application/pdf')).toBe(true);
    expect(isAttachmentMediaType('text/plain')).toBe(true);
    expect(isAttachmentMediaType('text/markdown')).toBe(true);
    expect(isAttachmentMediaType('text/x-markdown')).toBe(true);
    expect(isAttachmentMediaType('application/zip')).toBe(false);
    expect(isAttachmentMediaType('text/html')).toBe(false);
  });

  it('derives the on-disk extension from the media type alone — no user filename reaches a path', () => {
    expect(attachmentExtension('image/png')).toBe('png');
    expect(attachmentExtension('image/jpeg')).toBe('jpg');
    expect(attachmentExtension('application/pdf')).toBe('pdf');
    expect(attachmentExtension('text/plain')).toBe('txt');
    expect(attachmentExtension('text/markdown')).toBe('md');
    expect(attachmentExtension('text/x-markdown')).toBe('md');
    // The pre-existing catch-all for an image type cezar does not name, kept so an SVG paste
    // still lands exactly where it always did.
    expect(attachmentExtension('image/svg+xml')).toBe('img');
  });

  it('tells images and files apart by the persisted NAME, which is what every reader branches on', () => {
    expect(isImageAttachmentName('pasted-1.png')).toBe(true);
    expect(isImageAttachmentName('screenshot-9.jpg')).toBe(true);
    expect(isImageAttachmentName('pasted-2.img')).toBe(true);
    expect(isImageAttachmentName('pasted-3.pdf')).toBe(false);
    expect(isImageAttachmentName('pasted-4.md')).toBe(false);
    expect(isImageAttachmentName('pasted-5.txt')).toBe(false);
  });

  it('re-encodes an image name back to its media type at dequeue', () => {
    expect(mediaTypeFor('pasted-1.png')).toBe('image/png');
    expect(mediaTypeFor('pasted-2.jpg')).toBe('image/jpeg');
    expect(mediaTypeFor('pasted-3.webp')).toBe('image/webp');
    expect(mediaTypeFor('pasted-4.gif')).toBe('image/gif');
  });

  it('turns a wire attachment into a viewable block for an image and a file block otherwise', () => {
    expect(toPastedContent({ mediaType: 'image/png', data: TINY_PNG_B64 })).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
    });
    expect(toPastedContent({ mediaType: 'application/pdf', data: TINY_PDF_B64 })).toEqual({
      type: 'file',
      mediaType: 'application/pdf',
      data: TINY_PDF_B64,
    });
  });

  it('keeps file blocks out of what a session is handed — a backend never sees one', () => {
    const content: PastedContent[] = [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } },
      { type: 'file', mediaType: 'text/markdown', data: BRIEF_MD_B64 },
    ];
    expect(contentBlocksOf(content)).toEqual([content[0], content[1]]);
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

  /**
   * The PDF/TXT/MD half of the same contract (#950). A file has nothing for the model to look at,
   * so the assertions are the mirror image of the screenshot case: the bytes must land on disk and
   * must NOT reach the prompt, while the path must — because the path is the only reference the
   * agent gets, and on codex/opencode it is the only one that would survive anyway.
   */
  it('task-start PDF and markdown attachments land on disk and reach the agent as paths, not bytes', async () => {
    writeFileSync(argsFile, '', 'utf8');
    writeFileSync(stdinFile, '', 'utf8');
    const workflow: WorkflowDef = {
      name: 'pasted-files-test',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}' },
        { id: 'verify', command: 'true' },
      ],
    };
    const holder: WorkflowDef = {
      name: 'hold-slot-files',
      source: 'built-in',
      steps: [{ id: 'hold', command: `${process.execPath} -e "setTimeout(() => {}, 500)"` }],
    };
    manager.startRun(holder, { task: 'occupy the only slot', worktree: false });
    const record = manager.startRun(workflow, {
      task: 'read the attached brief',
      images: [
        { type: 'file', mediaType: 'text/markdown', data: BRIEF_MD_B64 },
        { type: 'file', mediaType: 'application/pdf', data: TINY_PDF_B64 },
      ],
      worktree: false,
    });

    // Durable and listed before a slot opens, exactly like a pasted screenshot — and named by
    // media type, in the numbering space the screenshots share.
    const queued = store.getRun(record.id);
    expect(queued?.status).toBe('queued');
    expect(queued?.taskImages).toEqual([
      `/api/v1/runs/${record.id}/images/pasted-1.md`,
      `/api/v1/runs/${record.id}/images/pasted-2.pdf`,
    ]);

    await waitForStatus(record.id, ['done', 'review', 'failed', 'cancelled']);
    const after = store.getRun(record.id);
    expect(after?.status, after?.error).toMatch(/^(done|review)$/);

    const mdPath = join(dataDir, 'runs', `${record.id}-images`, 'pasted-1.md');
    const pdfPath = join(dataDir, 'runs', `${record.id}-images`, 'pasted-2.pdf');
    expect(readFileSync(mdPath, 'utf8')).toBe(BRIEF_MD);
    expect(readFileSync(pdfPath, 'utf8')).toBe(TINY_PDF);

    const lines = readStdinLines();
    expect(lines.length).toBeGreaterThan(0);
    // No image block: there is nothing to view.
    expect(lines[0]?.imageCount).toBe(0);
    expect(lines[0]?.userText).toContain('The user attached 2 pasted files, also saved on disk at:');
    expect(lines[0]?.userText).toContain(`- ${mdPath}`);
    expect(lines[0]?.userText).toContain(`- ${pdfPath}`);
    // The bytes stay out of the prompt AND out of the event log — a 200 kB brief must cost the
    // run a path, not a fifth of its prompt budget.
    expect(lines[0]?.userText).not.toContain('Ship the alpha-particle report');
    expect(lines[0]?.userText).not.toContain(BRIEF_MD_B64);
    const ndjson = readFileSync(join(dataDir, 'runs', `${record.id}.ndjson`), 'utf8');
    expect(ndjson).not.toContain(BRIEF_MD_B64);
    expect(ndjson).not.toContain(TINY_PDF_B64);
  }, 30_000);

  /** A file stacked onto a still-queued run (#472 + #950). Its path has to reach the opening
   *  prompt too: a stacked screenshot could at least fall back on its inline block, a stacked
   *  `.md` has nothing to fall back on. */
  it('a file stacked onto a queued run reaches the opening prompt as a path', async () => {
    writeFileSync(stdinFile, '', 'utf8');
    const workflow: WorkflowDef = {
      name: 'stacked-file-test',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}' },
        { id: 'verify', command: 'true' },
      ],
    };
    const holder: WorkflowDef = {
      name: 'hold-slot-stacked',
      source: 'built-in',
      steps: [{ id: 'hold', command: `${process.execPath} -e "setTimeout(() => {}, 700)"` }],
    };
    manager.startRun(holder, { task: 'occupy the only slot', worktree: false });
    const record = manager.startRun(workflow, { task: 'wait for my brief', worktree: false });
    expect(store.getRun(record.id)?.status).toBe('queued');

    const queuedMessage = manager.enqueueMessage(record.id, [
      { type: 'text', text: 'here is the brief' },
      { type: 'file', mediaType: 'text/plain', data: Buffer.from('two lines\n').toString('base64') },
    ]);
    expect(queuedMessage?.images?.length).toBe(1);
    const stackedName = queuedMessage?.images?.[0]?.split('/').pop() as string;
    expect(stackedName).toMatch(/^pasted-\d+\.txt$/);

    await waitForStatus(record.id, ['done', 'review', 'failed', 'cancelled']);
    const opening = readStdinLines().find((line) => line.userText.includes('wait for my brief'));
    expect(opening).toBeDefined();
    expect(opening?.userText).toContain('here is the brief');
    expect(opening?.userText).toContain(`- ${join(dataDir, 'runs', `${record.id}-images`, stackedName)}`);
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
});
