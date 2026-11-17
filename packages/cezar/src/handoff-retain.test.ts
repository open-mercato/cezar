import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { retainHandoffArtifact } from './handoff-retain.ts';

describe('retained predecessor outputs', () => {
  it('preserves a selected early mockup and its images after the original is overwritten', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-retain-'));
    try {
      mkdirSync(join(root, 'shots'));
      writeFileSync(join(root, 'mockup.html'), '<img src="shots/a.png">early layout');
      writeFileSync(join(root, 'shots/a.png'), 'early image');
      const manifest = JSON.parse(readFileSync(retainHandoffArtifact(root, 'mockup.html', 'accepted starting layout'), 'utf8'));
      writeFileSync(join(root, 'mockup.html'), 'new layout'); writeFileSync(join(root, 'shots/a.png'), 'new image');
      expect(manifest.verified).toBe(true); expect(manifest.files).toHaveLength(2);
      expect(readFileSync(manifest.entry, 'utf8')).toContain('early layout');
      const image = manifest.files.find((file: { source: string }) => file.source.endsWith('a.png'));
      expect(readFileSync(image.preview, 'utf8')).toBe('early image');
      expect(readFileSync(manifest.entry, 'utf8')).toContain(image.preview.split('/').pop());
      expect(manifest.files.every((file: { sha256: string }) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('marks missing dependencies and refuses paths and symlinks outside Assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-retain-'));
    try {
      writeFileSync(join(root, 'mockup.html'), '<img src="missing.png">');
      const manifest = JSON.parse(readFileSync(retainHandoffArtifact(root, 'mockup.html', 'reference'), 'utf8'));
      expect(manifest.verified).toBe(false); expect(manifest.missing[0]).toContain('missing.png');
      expect(() => retainHandoffArtifact(root, '../outside.html', 'reference')).toThrow();
      symlinkSync(join(root, 'mockup.html'), join(root, 'link.html'));
      expect(() => retainHandoffArtifact(root, 'link.html', 'reference')).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
