import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ContentBlock } from '../core/agent-runner.ts';
import { HANDOFF_INSTRUCTIONS } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import {
  RunManager,
  attachmentLibraryDir,
  contentBlocksOf,
  copyToAttachmentLibrary,
  mediaTypeFor,
  pastedAttachmentsNote,
  pastedAttachmentsText,
  toPastedContent,
  type PastedContent,
} from './run.ts';
import {
  attachmentExtension,
  isAttachmentMediaType,
  isImageAttachmentName,
  sanitizeAttachmentName,
} from '@open-mercato/cezar-contract';

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

  /**
   * #929 — the library is pointed at as a DIRECTORY, not per file. The run-folder paths already
   * cover this message; what the library answers is "the brief I attached last week", which is a
   * file this note has no per-attachment handle on.
   */
  it('points at the attachment library without disturbing the per-run paths', () => {
    const text = pastedAttachmentsText(
      [{ name: 'pasted-1.md', url: '/api/v1/x', path: '/abs/runs/r-images/pasted-1.md' }],
      '/repo/.ai/cezar/attachments',
    );
    expect(text).toContain('The user attached 1 pasted file, also saved on disk at:');
    expect(text).toContain('- /abs/runs/r-images/pasted-1.md');
    expect(text).toContain('kept under their original names in /repo/.ai/cezar/attachments');
    expect(text).toContain('a document the user names but did not attach to this message');
    // "Documents", not "files": an image and a nameless upload are deliberately never filed, so a
    // note promising every attachment would send the agent hunting in the wrong folder.
    expect(text).toContain('Documents (PDF, TXT, MD) attached anywhere in this project');
    // The #950 closing instruction still lands after it, not before.
    expect(text.indexOf('/repo/.ai/cezar/attachments')).toBeLessThan(text.indexOf('operate on these files'));
  });

  /** The #950 wording is load-bearing for every backend that only ever sees text — a note that
   *  changed shape for a project with no library would be a regression nobody's test caught. */
  it('is byte-identical to the pre-#929 note when there is no library to name', () => {
    const text = pastedAttachmentsText([{ name: 'pasted-1.png', url: '/x', path: '/abs/pasted-1.png' }]);
    expect(text).toBe(
      'The user attached 1 pasted file, also saved on disk at:\n- /abs/pasted-1.png\n' +
        'When the task involves saving, uploading, attaching, or transforming the pasted content ' +
        '(e.g. attaching to a GitHub issue/PR, copying into the repo), operate on these files — do ' +
        'not attempt to reconstruct them from the conversation.',
    );
  });
});

/**
 * The attachment library writer (#929). Its whole job is deciding what "a file with this name is
 * already here" means: the same document attached to six tasks must leave one file, while two
 * genuinely different `notes.md` must both survive.
 */
describe('copyToAttachmentLibrary (#929)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-library-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files a file under its own name and creates the library on first use', () => {
    const path = copyToAttachmentLibrary(dataDir, 'brief.md', Buffer.from(BRIEF_MD));
    expect(path).toBe(join(attachmentLibraryDir(dataDir), 'brief.md'));
    expect(readFileSync(path as string, 'utf8')).toBe(BRIEF_MD);
  });

  it('reuses the existing copy when the same document is attached again', () => {
    const first = copyToAttachmentLibrary(dataDir, 'brief.md', Buffer.from(BRIEF_MD));
    const second = copyToAttachmentLibrary(dataDir, 'brief.md', Buffer.from(BRIEF_MD));
    expect(second).toBe(first);
    expect(readdirSync(attachmentLibraryDir(dataDir))).toEqual(['brief.md']);
  });

  it('keeps both when the name matches but the bytes do not', () => {
    const first = copyToAttachmentLibrary(dataDir, 'notes.md', Buffer.from('# one\n'));
    const second = copyToAttachmentLibrary(dataDir, 'notes.md', Buffer.from('# two\n'));
    expect(first).toBe(join(attachmentLibraryDir(dataDir), 'notes.md'));
    expect(second).toBe(join(attachmentLibraryDir(dataDir), 'notes-2.md'));
    const third = copyToAttachmentLibrary(dataDir, 'notes.md', Buffer.from('# three\n'));
    expect(third).toBe(join(attachmentLibraryDir(dataDir), 'notes-3.md'));
    // …and the second document, re-attached, still deduplicates onto its own copy.
    expect(copyToAttachmentLibrary(dataDir, 'notes.md', Buffer.from('# two\n'))).toBe(second);
    expect(readdirSync(attachmentLibraryDir(dataDir)).sort()).toEqual(['notes-2.md', 'notes-3.md', 'notes.md']);
  });

  it('suffixes an extensionless name without inventing a dot', () => {
    copyToAttachmentLibrary(dataDir, 'LICENSE', Buffer.from('a'));
    expect(copyToAttachmentLibrary(dataDir, 'LICENSE', Buffer.from('b'))).toBe(
      join(attachmentLibraryDir(dataDir), 'LICENSE-2'),
    );
  });

  /**
   * Defense in depth. `toPastedContent` sanitizes at the wire boundary and is the only producer of
   * `FileBlock.name` today, but that field is a plain `string` — so the writer refuses anything
   * that is not already a bare segment rather than trusting a caller two modules away. A traversal
   * that got this far would land outside `.ai/cezar/` entirely.
   */
  it('refuses a name that is not already a bare filename, whoever hands it over', () => {
    expect(copyToAttachmentLibrary(dataDir, '../../etc/shadow', Buffer.from('x'))).toBeNull();
    expect(copyToAttachmentLibrary(dataDir, 'sub/notes.md', Buffer.from('x'))).toBeNull();
    expect(copyToAttachmentLibrary(dataDir, '..', Buffer.from('x'))).toBeNull();
    expect(copyToAttachmentLibrary(dataDir, '.gitignore', Buffer.from('x'))).toBeNull();
    expect(copyToAttachmentLibrary(dataDir, '', Buffer.from('x'))).toBeNull();
    expect(existsSync(join(attachmentLibraryDir(dataDir), 'shadow'))).toBe(false);
  });

  /** Best-effort by contract: the run folder already holds the file the agent was promised, so a
   *  library that cannot be written must cost the entry and nothing else. */
  it('answers null instead of throwing when the library cannot be written', () => {
    // A regular file where the directory should be — `mkdirSync` cannot proceed past it.
    writeFileSync(attachmentLibraryDir(dataDir), 'not a directory', 'utf8');
    expect(copyToAttachmentLibrary(dataDir, 'brief.md', Buffer.from(BRIEF_MD))).toBeNull();
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

  /**
   * #929 — `toPastedContent` is the wire boundary, so it is where a client-supplied name is
   * sanitized. Past this point nothing in the engine handles a raw one.
   */
  it('sanitizes a file’s name at the wire boundary and drops one that cannot be salvaged', () => {
    expect(toPastedContent({ mediaType: 'text/markdown', data: BRIEF_MD_B64, name: 'brief.md' })).toEqual({
      type: 'file',
      mediaType: 'text/markdown',
      data: BRIEF_MD_B64,
      name: 'brief.md',
    });
    expect(
      toPastedContent({ mediaType: 'text/plain', data: BRIEF_MD_B64, name: '../../etc/shadow' }),
    ).toEqual({ type: 'file', mediaType: 'text/plain', data: BRIEF_MD_B64, name: 'shadow.txt' });
    // Nothing usable survives, so the block carries no name at all rather than an empty one.
    expect(toPastedContent({ mediaType: 'text/plain', data: BRIEF_MD_B64, name: '...' })).toEqual({
      type: 'file',
      mediaType: 'text/plain',
      data: BRIEF_MD_B64,
    });
  });

  /**
   * The image branch produces a `ContentBlock`, which is the runner protocol and reaches a vendor
   * API verbatim. An extra key here would survive `contentBlocksOf` and be sent to a backend that
   * rejects unknown fields — so a name offered for an image must be ignored, not carried.
   */
  it('never puts a name on an image block, even when the client sends one', () => {
    expect(toPastedContent({ mediaType: 'image/png', data: TINY_PNG_B64, name: 'diagram.png' })).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
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
 * `sanitizeAttachmentName` (#929) — the one place a user-supplied string is allowed to influence a
 * path. Everything the attachment library writes goes through it, so these cases are the security
 * boundary of that feature rather than formatting preferences.
 */
describe('sanitizeAttachmentName (#929)', () => {
  it('keeps an ordinary filename as it was written', () => {
    expect(sanitizeAttachmentName('design-notes.md', 'text/markdown')).toBe('design-notes.md');
    expect(sanitizeAttachmentName('Q3 Report.pdf', 'application/pdf')).toBe('Q3 Report.pdf');
  });

  it('reduces any path to its last segment, on both separator conventions', () => {
    expect(sanitizeAttachmentName('/etc/passwd.txt', 'text/plain')).toBe('passwd.txt');
    expect(sanitizeAttachmentName('C:\\Users\\me\\notes.md', 'text/markdown')).toBe('notes.md');
    expect(sanitizeAttachmentName('a/b/c/deep.txt', 'text/plain')).toBe('deep.txt');
  });

  it('cannot be talked into traversing out of the library', () => {
    // `..` survives basenaming only as a name, never as an operation — and a name of nothing but
    // dots leaves no stem at all, so there is nothing to write.
    expect(sanitizeAttachmentName('..', 'text/plain')).toBeNull();
    expect(sanitizeAttachmentName('../../etc/shadow', 'text/plain')).toBe('shadow.txt');
    expect(sanitizeAttachmentName('....//....//x.txt', 'text/plain')).toBe('x.txt');
  });

  it('never produces a dotfile', () => {
    expect(sanitizeAttachmentName('.gitignore', 'text/plain')).toBe('gitignore.txt');
    expect(sanitizeAttachmentName('.env', 'text/plain')).toBe('env.txt');
  });

  it('strips control characters and the characters Windows refuses', () => {
    expect(sanitizeAttachmentName('no\u0000tes\u001f.md', 'text/markdown')).toBe('notes.md');
    expect(sanitizeAttachmentName('a<b>c:d"e|f?g*h.txt', 'text/plain')).toBe('a-b-c-d-e-f-g-h.txt');
  });

  /**
   * The case the whole helper exists for. The media type is what the allowlist screened; letting
   * the NAME contradict it would mean a `text/plain` upload landing in the user's project as
   * `install.sh` — a file that passed a check that believed it was screening for exactly that.
   */
  it('pins the extension to the validated media type, so a claimed name cannot contradict it', () => {
    expect(sanitizeAttachmentName('install.sh', 'text/plain')).toBe('install.sh.txt');
    expect(sanitizeAttachmentName('payload.exe', 'application/pdf')).toBe('payload.exe.pdf');
    expect(sanitizeAttachmentName('notes.md', 'text/plain')).toBe('notes.md.txt');
    expect(sanitizeAttachmentName('README', 'text/plain')).toBe('README.txt');
  });

  it('accepts the alternative spellings of a type the composer already takes', () => {
    // `.log` is the one the composer went out of its way to support; renaming `server.log` to
    // `server.log.txt` would throw away the only name the user recognises it by.
    expect(sanitizeAttachmentName('server.log', 'text/plain')).toBe('server.log');
    expect(sanitizeAttachmentName('spec.markdown', 'text/x-markdown')).toBe('spec.markdown');
    // Case is normalised on the extension alone: `notes.TXT` and `notes.txt` are the same file on
    // macOS and Windows, and the library's dedupe compares names before it compares bytes.
    expect(sanitizeAttachmentName('notes.TXT', 'text/plain')).toBe('notes.txt');
  });

  it('bounds the stem so a hostile name cannot exceed a filesystem entry', () => {
    const long = sanitizeAttachmentName(`${'x'.repeat(400)}.md`, 'text/markdown');
    expect(long).toBe(`${'x'.repeat(100)}.md`);
  });

  /**
   * A filesystem bounds an entry in BYTES, so a character bound alone is not one — and the write
   * that would fail is caught, which means getting this wrong costs a silently missing library
   * entry rather than a visible error.
   */
  it('bounds the stem in bytes too, cutting on a code-point boundary', () => {
    // 100 four-byte emoji are 400 bytes: under the character bound, far over the byte budget.
    const emoji = sanitizeAttachmentName(`${'😀'.repeat(100)}.md`, 'text/markdown') as string;
    expect(emoji.endsWith('.md')).toBe(true);
    expect(new TextEncoder().encode(emoji).length).toBeLessThanOrEqual(184);
    // Never a lone surrogate: every kept character is a whole emoji.
    const stem = emoji.slice(0, -'.md'.length);
    expect(stem).toBe('😀'.repeat([...stem].length));
    expect([...stem].length).toBe(45);
  });

  /**
   * The odd-boundary case, which `'😀'.repeat(100)` above cannot reach: it cuts cleanly at code
   * unit 100, so a character-first truncation would look correct. Put one ASCII character in front
   * and unit 100 lands on half of an emoji — the cut a UTF-16 `slice` makes and a code-point loop
   * does not. Node writes a lone surrogate out as `U+FFFD`, so the symptom would be a library
   * entry ending in `�` rather than an error anyone would notice.
   */
  it('cuts on a code-point boundary even when the bound falls mid-surrogate-pair', () => {
    const name = sanitizeAttachmentName(`${'a'.repeat(97)}${'😀'.repeat(2)}.md`, 'text/markdown') as string;
    expect(name).not.toBeNull();
    // `for…of` yields whole code points, so any value left in the surrogate range is an unpaired
    // half — a whole emoji reads as U+1F600, never as U+D83D.
    const lone = [...name]
      .map((char) => char.codePointAt(0) as number)
      .filter((code) => code >= 0xd800 && code <= 0xdfff);
    expect(lone, `lone surrogate in ${JSON.stringify(name)}`).toEqual([]);
    // 97 ASCII + 2 whole emoji is 99 code points and 105 bytes — inside both bounds, so nothing
    // is dropped and the pair survives intact.
    expect(name).toBe(`${'a'.repeat(97)}${'😀'.repeat(2)}.md`);
  });

  /** The one Windows filename rule that is not about characters: these stems name DEVICES no
   *  matter what extension follows, so a write to `CON.txt` goes to the console rather than to a
   *  file anyone can read back. */
  it('does not hand Windows a reserved device name', () => {
    expect(sanitizeAttachmentName('CON.txt', 'text/plain')).toBe('CON-.txt');
    expect(sanitizeAttachmentName('nul', 'text/plain')).toBe('nul-.txt');
    expect(sanitizeAttachmentName('LPT1.pdf', 'application/pdf')).toBe('LPT1-.pdf');
    // Only the exact stems are reserved — a name that merely starts with one is a normal file.
    expect(sanitizeAttachmentName('console.log', 'text/plain')).toBe('console.log');
    expect(sanitizeAttachmentName('com10.txt', 'text/plain')).toBe('com10.txt');
  });

  it('never leaves a trailing dot or space, which Windows refuses outright', () => {
    expect(sanitizeAttachmentName('notes.', 'text/plain')).toBe('notes.txt');
    expect(sanitizeAttachmentName('notes ', 'text/plain')).toBe('notes.txt');
    expect(sanitizeAttachmentName('report...', 'application/pdf')).toBe('report.pdf');
  });

  it('returns null when nothing usable survives, so the caller falls back to the run-folder name', () => {
    expect(sanitizeAttachmentName('', 'text/plain')).toBeNull();
    expect(sanitizeAttachmentName('   ', 'text/plain')).toBeNull();
    expect(sanitizeAttachmentName('\u0000\u0001', 'text/plain')).toBeNull();
    expect(sanitizeAttachmentName('...', 'text/plain')).toBeNull();
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

  /**
   * The library end to end (#929): a named file attached to a task must land in
   * `.ai/cezar/attachments/` under the name the user picked, and the agent must be told where —
   * that path is the only one a LATER task could find it by.
   */
  it('a named file attachment is filed in the project library and its path reaches the agent', async () => {
    writeFileSync(stdinFile, '', 'utf8');
    writeFileSync(argsFile, '', 'utf8');
    const workflow: WorkflowDef = {
      name: 'library-test',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}' },
        { id: 'verify', command: 'true' },
      ],
    };
    const holder: WorkflowDef = {
      name: 'hold-slot-library',
      source: 'built-in',
      steps: [{ id: 'hold', command: `${process.execPath} -e "setTimeout(() => {}, 500)"` }],
    };
    manager.startRun(holder, { task: 'occupy the only slot', worktree: false });
    const record = manager.startRun(workflow, {
      task: 'read the attached brief',
      images: [
        { type: 'file', mediaType: 'text/markdown', data: BRIEF_MD_B64, name: 'alpha-brief.md' },
        // No name (a client from before #929, or a paste with nothing to go on): still persisted
        // to the run folder exactly as before, just not filed.
        { type: 'file', mediaType: 'application/pdf', data: TINY_PDF_B64 },
      ],
      worktree: false,
    });

    const libraryPath = join(attachmentLibraryDir(dataDir), 'alpha-brief.md');
    // Filed at persist time, so it is on disk before the run is even dequeued.
    expect(readFileSync(libraryPath, 'utf8')).toBe(BRIEF_MD);
    expect(readdirSync(attachmentLibraryDir(dataDir))).toEqual(['alpha-brief.md']);

    await waitForStatus(record.id, ['done', 'review', 'failed', 'cancelled']);
    const after = store.getRun(record.id);
    expect(after?.status, after?.error).toMatch(/^(done|review)$/);

    const lines = readStdinLines();
    // Both run-folder paths are still announced — the library is additive, not a replacement.
    expect(lines[0]?.userText).toContain(`- ${join(dataDir, 'runs', `${record.id}-images`, 'pasted-1.md')}`);
    expect(lines[0]?.userText).toContain(`- ${join(dataDir, 'runs', `${record.id}-images`, 'pasted-2.pdf')}`);
    // …and the library is named, so a later task can find `alpha-brief.md` by the name the user
    // knows it by rather than by this run's `pasted-1.md`.
    expect(lines[0]?.userText).toContain(`kept under their original names in ${attachmentLibraryDir(dataDir)}`);
    // The unnamed PDF was persisted to the run folder but never filed.
    expect(existsSync(join(attachmentLibraryDir(dataDir), 'pasted-2.pdf'))).toBe(false);
    expect(readdirSync(attachmentLibraryDir(dataDir))).toEqual(['alpha-brief.md']);
    expect(readFileSync(libraryPath, 'utf8')).toBe(BRIEF_MD);

    // …and the agent is actually ALLOWED to look where it was told to. A run's cwd is its
    // worktree, headless runs get `--permission-mode dontAsk`, and the library is a sibling of
    // `runs/` — so without this grant `Read`/`Glob` on the path the note names is refused
    // outright, with no prompt, and the whole point of the library never reaches the agent.
    const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n')[0] as string) as string[];
    const granted = argv.flatMap((arg, i) => (arg === '--add-dir' ? [argv[i + 1] as string] : []));
    expect(granted).toContain(attachmentLibraryDir(dataDir));
    expect(granted).toContain(join(dataDir, 'runs'));
  }, 30_000);

  /** The agent's own tool screenshots share `persistAttachment` with user uploads. They must not
   *  share the library — a folder of the agent's screenshots is a log, not a library. */
  it('never files an agent screenshot or a user image in the library', async () => {
    const before = existsSync(attachmentLibraryDir(dataDir)) ? readdirSync(attachmentLibraryDir(dataDir)) : [];
    const workflow: WorkflowDef = {
      name: 'library-images-test',
      source: 'built-in',
      steps: [{ id: 'work', prompt: '{{task}}' }],
    };
    const image: ContentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
    };
    const record = manager.startRun(workflow, { task: 'look at this', images: [image] });
    await waitForStatus(record.id, ['waiting']);
    // The mock takes its own tool screenshot during turn 1, so this covers both origins at once.
    expect(existsSync(join(dataDir, 'runs', `${record.id}-images`, 'pasted-1.png'))).toBe(true);
    const after = existsSync(attachmentLibraryDir(dataDir)) ? readdirSync(attachmentLibraryDir(dataDir)) : [];
    expect(after).toEqual(before);
    manager.finish(record.id);
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
