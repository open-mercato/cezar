import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ghEnv } from '../../core/gh-env.ts';
import { isGithubAttachmentUrl, type GithubAssetResponse } from '@open-mercato/cezar-contract';

const exec = promisify(execFile);
export const GITHUB_ASSET_MAX_BYTES = 5 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// GitHub's attachment CDN and its fixed S3 bucket, never arbitrary *.amazonaws.com.
const CDN_HOSTS = new Set(['user-images.githubusercontent.com', 'private-user-images.githubusercontent.com',
  'github-production-user-asset-6210df.s3.amazonaws.com']);
let active = 0;

function allowedHop(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    (isGithubAttachmentUrl(url.href) || CDN_HOSTS.has(url.hostname));
}

function rasterType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(bytes.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}

/** Kept injectable for credential/redirect tests; production always uses gh's existing identity. */
export async function loadGithubAsset(root: string, source: string, deps: {
  fetch?: typeof fetch;
  token?: () => Promise<string>;
} = {}): Promise<GithubAssetResponse> {
  const unavailable = { available: false as const };
  if (!isGithubAttachmentUrl(source) || process.env.CEZ_DRY_RUN === '1') return unavailable;
  if (active >= 4) return { available: false, retryable: true };
  active++;
  const signal = AbortSignal.timeout(15_000);
  try {
    let url = new URL(source);
    let token: string | undefined;
    const fetchImage = deps.fetch ?? fetch;
    for (let hop = 0; hop <= 3; hop++) {
      if (!allowedHop(url)) return unavailable;
      const headers: Record<string, string> = { Accept: 'image/png,image/jpeg,image/gif,image/webp,image/avif' };
      if (url.hostname === 'github.com') {
        token ??= (await (deps.token?.() ?? exec('gh', ['auth', 'token', '--hostname', 'github.com'],
          { cwd: root, env: ghEnv(), timeout: 5_000, maxBuffer: 16 * 1024 }).then(({ stdout }) => stdout).catch(() => ''))).trim();
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetchImage(url, { headers, redirect: 'manual', signal });
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || hop === 3) return unavailable;
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > GITHUB_ASSET_MAX_BYTES) {
        await response.body?.cancel();
        return unavailable;
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > GITHUB_ASSET_MAX_BYTES) { await reader.cancel(); return unavailable; }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      const mime = rasterType(bytes);
      // A claimed raster containing HTML/SVG, or a mismatched MIME, is never published.
      if (!mime || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== mime) return unavailable;
      return { available: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    }
    return unavailable;
  } catch {
    // gh/fetch errors can contain credentials, signed URLs or private paths. Never serialize them.
    return unavailable;
  } finally { active--; }
}
