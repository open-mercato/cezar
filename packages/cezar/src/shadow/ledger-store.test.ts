import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHADOW_INTENT_ID_RE } from '@open-mercato/cezar-contract';
import {
  INTENT_ID_RE,
  LEDGER_VERSION,
  appendDecision,
  appendIntent,
  newIntentId,
  shadowPaths,
  withholdValues,
  type PushIntentLine,
} from './ledger.ts';
import { MAX_INTENTS, readLedger } from './ledger-store.ts';

describe('shadow ledger', () => {
  let dir: string;
  const SHA = 'a'.repeat(40);
  const ZERO = '0'.repeat(40);

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-shadow-ledger-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const push = (id: string): PushIntentLine => ({
    v: LEDGER_VERSION,
    type: 'intent',
    id,
    at: '2026-10-06T12:00:00.000Z',
    kind: 'push',
    remote: 'origin',
    ref: 'refs/heads/feature',
    sha: SHA,
    oldSha: ZERO,
    pinned: true,
  });

  it('mints ids the contract accepts - the shim cannot import the contract, so this pins the copy', () => {
    expect(INTENT_ID_RE.source).toBe(SHADOW_INTENT_ID_RE.source);
    expect(newIntentId()).toMatch(SHADOW_INTENT_ID_RE);
  });

  it('skips lines that fail the schema instead of failing the whole ledger', () => {
    const paths = shadowPaths(dir);
    appendIntent(dir, push(newIntentId()));
    appendFileSync(paths.intents, 'not json\n{"v":1,"type":"intent","id":"../../etc","kind":"push"}\n');
    appendIntent(dir, push(newIntentId()));
    expect(readLedger(dir).intents).toHaveLength(2);
  });

  it('keeps the first line for a duplicated id - a later forged copy cannot rewrite it', () => {
    const id = newIntentId();
    appendIntent(dir, push(id));
    appendIntent(dir, { ...push(id), ref: 'refs/heads/main' });
    expect(readLedger(dir).intents).toMatchObject([{ ref: 'refs/heads/feature' }]);
  });

  it('treats promoted and discarded as final, and lets a failed promotion be retried', () => {
    const [a, b] = [newIntentId(), newIntentId()];
    const decide = (intentId: string, decision: 'promoted' | 'discarded' | 'failed') =>
      appendDecision(dir, { v: LEDGER_VERSION, type: 'decision', intentId, at: '2026-10-06T12:01:00.000Z', decision });
    decide(a, 'failed');
    decide(a, 'promoted');
    decide(a, 'discarded'); // after a final decision: ignored
    decide(b, 'discarded');
    decide(b, 'promoted'); // ignored too
    const { decisions } = readLedger(dir);
    expect(decisions.get(a)?.decision).toBe('promoted');
    expect(decisions.get(b)?.decision).toBe('discarded');
  });

  it('stops at the intent cap and says so', () => {
    mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: MAX_INTENTS + 5 }, (_, index) =>
      JSON.stringify(push(`${(1_700_000_000_000 + index).toString(36)}-abcdef`)),
    );
    writeFileSync(shadowPaths(dir).intents, `${lines.join('\n')}\n`);
    const ledger = readLedger(dir);
    expect(ledger.intents).toHaveLength(MAX_INTENTS);
    expect(ledger.truncated).toBe(true);
  });

  it('withholds a value attached to a short flag too: -bs3cr3t is -b s3cr3t to gh', () => {
    expect(withholdValues(['secret', 'set', 'N', '-bs3cr3t'])).toEqual(['secret', 'set', '<withheld>', '-b<withheld>']);
  });

  it('withholds the values of a denied command, keeping what was attempted', () => {
    expect(withholdValues(['secret', 'set', 'NPM_TOKEN', '--body', 'hunter2', '--repo=o/r'])).toEqual([
      'secret',
      'set',
      '<withheld>',
      '--body',
      '<withheld>',
      '--repo',
    ]);
  });
});
