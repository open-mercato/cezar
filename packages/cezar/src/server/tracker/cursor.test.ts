import { describe, expect, it } from 'vitest';
import { encodeCursor, decodeCursor } from './cursor.ts';
import { trackerCredentialsSchema } from '@open-mercato/cezar-contract';

describe('tracker source configuration and cursors', () => {
  it('rejects attacker endpoints and credentials embedded in Jira URL', () => {
    const valid = (origin: string) => trackerCredentialsSchema.safeParse({ kind: 'jira', origin, email: 'a@b.test', token: 'test-token' }).success;
    for (const url of ['http://team.atlassian.net', 'https://team.atlassian.net.evil.test', 'https://u:p@team.atlassian.net', 'https://team.atlassian.net:444', 'https://team.atlassian.net/rest', 'https://team.atlassian.net?x=y']) expect(valid(url)).toBe(false);
    expect(valid('https://team.atlassian.net/')).toBe(true);
  });
  it('rejects vendor cursors that cannot fit the public contract', () => {
    expect(() => encodeCursor({ source: 'one' }, 'x'.repeat(4000))).toThrow('pagination token exceeded');
  });
  it('binds pagination to query and source, authenticating all positions', () => {
    const scope = { source: 'one', query: 'login' };
    const cursor = encodeCursor(scope, 'next-page');
    expect(decodeCursor(scope, cursor)).toBe('next-page');
    expect(() => decodeCursor({ source: 'two', query: 'login' }, cursor)).toThrow();
    expect(() => decodeCursor({ source: 'one', query: 'logout' }, cursor)).toThrow();
    expect(() => decodeCursor(scope, cursor.slice(1))).toThrow();
    expect(decodeCursor(scope, undefined)).toBeUndefined();
  });
});
