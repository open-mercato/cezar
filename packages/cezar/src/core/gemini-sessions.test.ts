import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { geminiResumeWaitMs } from './gemini-sessions.ts';

/**
 * The same-minute resume guard (#581). The file name is Gemini CLI 0.60's own
 * (`session-<ISO minute, UTC>-<id8>.jsonl`); reproduced against the real CLI on 2026-09-19: a
 * `session/load` in the creation minute destroyed the session permanently, one a minute later
 * worked.
 */
const SESSION = 'a9a3ac1b-e340-4286-8c10-fc98a83dca58';
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-gemini-sessions-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function recording(project: string, minute: string, id = SESSION): void {
  const chats = join(home, '.gemini', 'tmp', project, 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(chats, `session-${minute}-${id.slice(0, 8)}.jsonl`), '{}\n');
}

describe('geminiResumeWaitMs', () => {
  it('waits for the next minute (plus a margin) when the session was created in the current one', () => {
    recording('repo', '2026-09-19T16-59');
    const now = new Date('2026-09-19T16:59:07.250Z');
    expect(geminiResumeWaitMs(SESSION, { GEMINI_CLI_HOME: home }, now)).toBe(60_000 - 7_250 + 1_500);
  });

  it('does not wait once the minute has passed, or for another session', () => {
    recording('repo', '2026-09-19T16-58');
    recording('repo', '2026-09-19T16-59', 'ffffffff-0000-4000-8000-000000000000');
    expect(geminiResumeWaitMs(SESSION, { GEMINI_CLI_HOME: home }, new Date('2026-09-19T16:59:07Z'))).toBe(0);
  });

  it('finds the recording whatever project folder Gemini filed it under', () => {
    recording('cez-gemini-smoke-hbz4y4', '2026-09-19T16-59');
    expect(geminiResumeWaitMs(SESSION, { GEMINI_CLI_HOME: home }, new Date('2026-09-19T16:59:59.000Z'))).toBe(2_500);
  });

  it('degrades to no wait when Gemini has no tmp dir or the id is not id-shaped', () => {
    expect(geminiResumeWaitMs(SESSION, { GEMINI_CLI_HOME: home })).toBe(0);
    expect(geminiResumeWaitMs('../../x', { GEMINI_CLI_HOME: home })).toBe(0);
  });
});
