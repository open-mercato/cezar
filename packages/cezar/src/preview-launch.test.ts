import { describe, expect, it } from 'vitest';
import { parsePreviewUrl, projectWorkspacePath } from './preview-launch.ts';

describe('parsePreviewUrl (#1608)', () => {
  it('keeps a non-default port, path and query exactly', () => {
    expect(parsePreviewUrl('http://127.0.0.1:3456/backend/login?x=1')).toEqual({ url: 'http://127.0.0.1:3456/backend/login?x=1' });
    expect(parsePreviewUrl(' https://app.test/a ')).toEqual({ url: 'https://app.test/a' });
  });
  it.each(['javascript:void(0)', 'file:///etc/passwd', 'data:text/html,hi', 'ftp://x.test', 'not a url', '', 'localhost:3000'])(
    'rejects %j', (raw) => {
      expect(parsePreviewUrl(raw)).toHaveProperty('error');
    },
  );
  it('rejects credentials', () => {
    expect(parsePreviewUrl('http://user:pw@127.0.0.1:3000/')).toHaveProperty('error');
  });
});

describe('projectWorkspacePath', () => {
  it('encodes the project and the address', () => {
    expect(projectWorkspacePath('my proj', 'http://127.0.0.1:3000/a?b=1')).toBe(
      '/p/my%20proj/workspace?preview=http%3A%2F%2F127.0.0.1%3A3000%2Fa%3Fb%3D1',
    );
    expect(projectWorkspacePath('p')).toBe('/p/p/workspace');
  });
});
