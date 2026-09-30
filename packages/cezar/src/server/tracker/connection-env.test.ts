import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodeConnectionEnv, encodeConnectionEnv } from './connection-env.ts';

it.each([
  'dummy#=secret', 'dummy\\n\\r\\tail', 'dummy"quote', "dummy'quote", 'dummy`quote',
  'dummy${UNEXPANDED}', '$(touch /never-execute)', 'dummy"\'`all-quotes',
])('round trips literal credential characters: %s', key => {
  const record = { id: randomUUID(), projectRoot: '/tmp/project', credentials: { kind: 'linear' as const, key } };
  expect(decodeConnectionEnv(encodeConnectionEnv(record))).toEqual(record);
});
it('round trips Jira metadata and credentials', () => {
  const record = { id: randomUUID(), projectRoot: '/tmp/project', credentials: { kind: 'jira' as const,
    origin: 'https://example.atlassian.net', email: 'user+tag@example.com', token: 'dummy:#=token' } };
  expect(decodeConnectionEnv(encodeConnectionEnv(record))).toEqual(record);
});
it('rejects unsupported and control characters without printing input in errors', () => {
  for (const key of ['dummy\nINJECTED=value', 'dummy\rvalue', 'dummy\0value', 'dummy\tvalue', 'dummy"\'`#']) {
    expect(() => encodeConnectionEnv({ id: randomUUID(), projectRoot: '/tmp/project', credentials: { kind: 'linear', key } })).toThrow();
  }
});
it('rejects duplicate keys, invalid lines, unknown fields, two providers and unsupported versions', () => {
  const text = encodeConnectionEnv({ id: randomUUID(), projectRoot: '/tmp/project', credentials: { kind: 'linear', key: 'dummy' } });
  for (const extra of ['LINEAR_API_KEY=dummy\n', 'garbage\n', 'NODE_OPTIONS=--inspect\n', 'JIRA_API_TOKEN=dummy\n']) {
    expect(() => decodeConnectionEnv(text + extra)).toThrow();
  }
  expect(() => decodeConnectionEnv(text.replace("RECORD_VERSION='1'", "RECORD_VERSION='2'"))).toThrow();

});
it('accepts comments and CRLF without changing the credential revision', () => {
  const record = { id: randomUUID(), projectRoot: '/tmp/project', credentials: { kind: 'linear' as const, key: 'dummy' } };
  expect(decodeConnectionEnv('# comment\n' + encodeConnectionEnv(record).replaceAll('\n', '\r\n'))).toEqual(record);
});

it('uses the documented credential-only digest independent of revision and canonical root', () => {
  const record = { id: randomUUID(), projectRoot: '/tmp/project', credentials: { kind: 'linear' as const, key: 'dummy' } };
  const expected = createHash('sha256').update(JSON.stringify(['linear', 'dummy'])).digest('hex');
  expect(encodeConnectionEnv(record)).toContain(`CREDENTIAL_SHA256='${expected}'`);
  expect(encodeConnectionEnv({ ...record, id: randomUUID(), projectRoot: '/elsewhere' })).toContain(expected);
});
