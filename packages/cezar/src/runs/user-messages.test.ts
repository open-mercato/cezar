import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RUN_USER_MESSAGE_PREVIEW_CHARS } from '@open-mercato/cezar-contract';
import { readRunUserMessages } from './user-messages.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const write = (lines: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-usermsgs-'));
  dirs.push(dir);
  const file = join(dir, 'run.ndjson');
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

describe('readRunUserMessages', () => {
  it('answers just the opening task when the file is missing', async () => {
    expect(await readRunUserMessages('/nonexistent/run.ndjson', { task: 'go', ts: 't0' })).toEqual([
      { seq: 0, ts: 't0', text: 'go', images: 0, files: 0 },
    ]);
  });

  it('lists user-message lines after the opening task, splitting images from files', async () => {
    const file = write([
      JSON.stringify({ seq: 1, ts: 'a', type: 'text', text: 'user-message mentioned in agent text' }),
      'not json user-message {',
      JSON.stringify({ seq: 2, ts: 'b', type: 'user-message', text: 'x'.repeat(RUN_USER_MESSAGE_PREVIEW_CHARS + 50), images: ['/api/v1/runs/r/images/1-a.png', '/api/v1/runs/r/images/2-b.pdf'] }),
      JSON.stringify({ seq: 3, ts: 'c', type: 'user-message', text: 'hi', imageCount: 2 }),
    ]);
    const out = await readRunUserMessages(file, { task: 'open', images: ['/i/1-a.png'] });
    expect(out.map((m) => m.seq)).toEqual([0, 2, 3]);
    expect(out[0]).toMatchObject({ images: 1, files: 0 });
    expect(out[1]).toMatchObject({ ts: 'b', images: 1, files: 1 });
    expect(out[1]?.text).toHaveLength(RUN_USER_MESSAGE_PREVIEW_CHARS);
    expect(out[2]).toMatchObject({ text: 'hi', images: 2, files: 0 });
  });
});
