import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteUpload, readUpload, UPLOAD_TTL_MS, uploadsDir, writeUpload } from './uploads.ts';

describe('staged uploads (telemetry 7054e5f2)', () => {
  let home: string;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-uploads-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const stage = (data = 'AAAA', name?: string) => {
    const result = writeUpload({ mediaType: 'image/png', data, ...(name ? { name } : {}) });
    if (!result.ok) throw new Error(result.error);
    return result.upload;
  };

  it('round-trips an upload, name included, and reports its decoded size', () => {
    const upload = stage('AAAAAA==', 'shot.png');
    expect(upload).toEqual({ uploadId: expect.stringMatching(/^[a-f0-9]{24}$/), mediaType: 'image/png', bytes: 4 });
    expect(readUpload(upload.uploadId)).toEqual({ mediaType: 'image/png', data: 'AAAAAA==', name: 'shot.png' });
  });

  it('forgets a deleted upload, and deleting twice is fine', () => {
    const { uploadId } = stage();
    deleteUpload(uploadId);
    deleteUpload(uploadId);
    expect(readUpload(uploadId)).toBeNull();
  });

  it('treats an expired upload as gone, and the next write prunes it', () => {
    const { uploadId } = stage();
    const path = join(uploadsDir(), `${uploadId}.json`);
    const old = (Date.now() - UPLOAD_TTL_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    expect(readUpload(uploadId)).toBeNull();
    stage();
    expect(existsSync(path)).toBe(false);
  });

  /** The file sits on disk between write and read, so what comes back is validated again. */
  it('refuses a stored upload that was altered on disk', () => {
    const { uploadId } = stage();
    const path = join(uploadsDir(), `${uploadId}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...stored, mediaType: 'application/x-sh' }));
    expect(readUpload(uploadId)).toBeNull();
    writeFileSync(path, 'not json');
    expect(readUpload(uploadId)).toBeNull();
  });

  it('never reads outside the store for an id that is not one', () => {
    expect(readUpload('../config')).toBeNull();
    expect(() => deleteUpload('../config')).not.toThrow();
  });
});
