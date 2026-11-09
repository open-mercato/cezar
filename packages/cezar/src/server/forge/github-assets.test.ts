import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubAssetInputSchema, githubAssetResponseSchema, isGithubAttachmentUrl } from '@open-mercato/cezar-contract';
import { GITHUB_ASSET_MAX_BYTES, loadGithubAsset } from './github-assets.ts';

const SOURCE = 'https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc';
const CDN = 'https://private-user-images.githubusercontent.com/1/test.png?jwt=private-signed-value';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const png = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });
const token = vi.fn(async () => 'test-secret-token');

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); token.mockClear(); });

describe('GitHub attachment loading', () => {
  it.each([SOURCE, CDN, 'https://user-images.githubusercontent.com/1/a.png'])('accepts only attachment sources: %s', (url) => {
    expect(githubAssetInputSchema.safeParse({ url }).success).toBe(true);
  });
  it.each([
    'http://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc',
    'https://github.com/login', 'https://github.com/api/v3', 'https://github.com.evil.test/a',
    'https://evil.test/a', 'https://127.0.0.1/a', 'http://169.254.169.254/latest/meta-data',
    'https://user-images.githubusercontent.com.evil.test/a', 'https://user-images.githubusercontent.com:444/a',
    'https://user:password@github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc',
    'https://private-user-images.githubusercontent.com/a#fragment', 'file:///etc/passwd',
    'https://github-production-user-asset-6210df.s3.amazonaws.com/a',
  ])('refuses untrusted initial URLs before credentials/network: %s', async (url) => {
    const fetch = vi.fn();
    expect(isGithubAttachmentUrl(url)).toBe(false);
    expect(await loadGithubAsset('/repo', url, { fetch, token })).toEqual({ available: false });
    expect(fetch).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
  });
  it('authenticates only github.com; follows approved redirect without credentials and returns raster data only', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: CDN } }))
      .mockResolvedValueOnce(png());
    const result = await loadGithubAsset('/repo', SOURCE, { fetch, token });
    expect(result).toEqual({ available: true, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(githubAssetResponseSchema.safeParse(result).success).toBe(true);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', headers: { Authorization: 'Bearer test-secret-token' } });
    expect(fetch.mock.calls[1]?.[1]?.headers).not.toHaveProperty('Authorization');
    expect(JSON.stringify(result)).not.toMatch(/test-secret-token|jwt=|private-signed-value/);
  });
  it('loads public CDN attachments without reading a token', async () => {
    expect((await loadGithubAsset('/repo', 'https://user-images.githubusercontent.com/1/a.png', { fetch: vi.fn().mockResolvedValue(png()), token })).available).toBe(true);
    expect(token).not.toHaveBeenCalled();
  });
  it.each(['http://127.0.0.1/secret', 'https://evil.test/a', 'https://github.com/settings/tokens',
    'https://other-bucket.s3.amazonaws.com/a', 'https://user:pass@private-user-images.githubusercontent.com/a'])('rejects redirect before requesting %s', async (location) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    expect(await loadGithubAsset('/repo', SOURCE, { fetch, token })).toEqual({ available: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds redirect loops', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 302, headers: { location: SOURCE } }));
    expect((await loadGithubAsset('/repo', SOURCE, { fetch, token })).available).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it.each([
    ['image/svg+xml', '<svg onload="alert(1)"/>'], ['text/html', '<script>alert(1)</script>'],
    ['image/png', '<svg/>'], ['image/jpeg', PNG],
  ])('rejects executable or mismatched content (%s)', async (type, body) => {
    const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': type } }));
    expect(await loadGithubAsset('/repo', SOURCE, { fetch, token })).toEqual({ available: false });
  });
  it('rejects declared and streamed oversize responses', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(PNG, { headers: { 'content-length': String(GITHUB_ASSET_MAX_BYTES + 1) } }));
    expect((await loadGithubAsset('/repo', SOURCE, { fetch, token })).available).toBe(false);
    fetch.mockResolvedValue(new Response(new Uint8Array(GITHUB_ASSET_MAX_BYTES + 1), { headers: { 'content-type': 'image/png' } }));
    expect((await loadGithubAsset('/repo', SOURCE, { fetch, token })).available).toBe(false);
  });
  it('contains token/fetch failures without serializing their messages', async () => {
    const result = await loadGithubAsset('/repo', SOURCE, { token: async () => { throw new Error('test-secret-token'); } });
    expect(result).toEqual({ available: false });
  });
  it('stays offline in dry-run', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const fetch = vi.fn();
    expect((await loadGithubAsset('/repo', SOURCE, { fetch, token })).available).toBe(false);
    expect(fetch).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
  });
  it('caps concurrent downloads and frees every slot', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async () => { await pending; return png(); });
    const jobs = Array.from({ length: 4 }, () => loadGithubAsset('/repo', CDN, { fetch, token }));
    expect(await loadGithubAsset('/repo', CDN, { fetch, token })).toEqual({ available: false, retryable: true });
    release();
    expect((await Promise.all(jobs)).every((result) => result.available)).toBe(true);
    expect((await loadGithubAsset('/repo', CDN, { fetch, token })).available).toBe(true);
  });
});
