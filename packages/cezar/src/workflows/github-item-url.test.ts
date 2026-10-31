import { describe, expect, it } from 'vitest';
import { parseGithubItemUrl } from './run.ts';

describe('parseGithubItemUrl', () => {
  it.each([
    ['https://github.com/acme/demo/pull/7', { repo: 'acme/demo', number: 7 }],
    ['https://company.ghe.com/acme/demo/issues/9#issuecomment-1', { repo: 'acme/demo', number: 9 }],
    ['https://github.corp.example:8443/acme/demo/pull/3', { repo: 'acme/demo', number: 3 }],
  ])('parses %s', (url, expected) => {
    expect(parseGithubItemUrl(url)).toEqual(expected);
  });

  it('rejects non-item URLs', () => {
    expect(parseGithubItemUrl('http://github.com/acme/demo/pull/7')).toBeUndefined();
    expect(parseGithubItemUrl('https://github.com/acme/demo/pull/0')).toBeUndefined();
  });
});
