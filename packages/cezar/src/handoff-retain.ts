import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const references = /((?:src|href)\s*=\s*["'])([^"']+)(["'])|(url\(\s*["']?)([^\s"')]+)(["']?\s*\))/gi;

/** Exact source copies plus a flat preview: every relative image stays within Assets' depth limit. */
export function retainHandoffArtifact(artifactsRoot: string, name: string, why: string): string {
  const root = realpathSync(artifactsRoot);
  const source = resolve(root, name);
  const within = (path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
  if (!within(source) || !why.trim() || name.split(/[\\/]/).some(part => part.startsWith('handoff-retained-'))) throw new Error('Select an original artifact inside this task’s Assets and explain why to open it.');
  const destination = join(root, `handoff-retained-${randomUUID()}`);
  const files: { source: string; retained: string; sha256: string; preview: string }[] = [];
  const missing: string[] = [];
  const captured = new Map<string, Buffer>();
  let bytes = 0;
  const local = (file: string, ref: string): string | null => {
    if (!ref || ref.startsWith('#') || ref.startsWith('data:')) return null;
    if (/^[a-z][\w+.-]*:|^\/\//i.test(ref)) { missing.push(`External or temporary dependency: ${ref}`); return null; }
    return resolve(dirname(file), decodeURIComponent(ref.split(/[?#]/)[0]!));
  };
  const copy = (file: string) => {
    if (captured.has(file)) return;
    if (captured.size >= 100 || !within(file)) throw new Error('Artifact dependency set exceeds its safe boundary (100 files).');
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || !within(realpathSync(file))) throw new Error('Only regular files within Assets can be retained.');
    bytes += info.size;
    if (bytes > 25 * 1024 * 1024) throw new Error('Selected artifact and dependencies exceed 25 MiB; select a smaller artifact.');
    const data = readFileSync(file);
    captured.set(file, data);
    if (/\.(html?|css|svg)$/i.test(file)) {
      const text = data.toString('utf8');
      if (/\bsrcset\s*=|@import\s+["']/i.test(text)) missing.push(`${relative(root, file)}: srcset or quoted CSS imports need manual verification`);
      for (const match of text.matchAll(references)) {
        const ref = match[2] ?? match[5] ?? '';
        try { const dependency = local(file, ref); if (dependency) copy(dependency); }
        catch (error) { missing.push(`${ref}: ${(error as Error).message}`); }
      }
    }
  };
  copy(source);
  const previewName = (file: string) => `${hash(relative(root, file)).slice(0, 16)}-${basename(file)}`;
  for (const [file, data] of captured) {
    const target = join(destination, '.source', relative(root, file));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: 'wx' });
    const preview = join(destination, previewName(file));
    const presented = /\.(html?|css|svg)$/i.test(file)
      ? data.toString('utf8').replace(references, (whole, beforeAttr, attr, afterAttr, beforeCss, css, afterCss) => {
          const ref = (attr ?? css) as string;
          try {
            const dependency = local(file, ref);
            if (!dependency || !captured.has(dependency)) return whole;
            const suffix = /[?#].*$/.exec(ref)?.[0] ?? '';
            return `${beforeAttr ?? beforeCss}${previewName(dependency)}${suffix}${afterAttr ?? afterCss}`;
          } catch { return whole; }
        })
      : data;
    writeFileSync(preview, presented, { flag: 'wx' });
    files.push({ source: file, retained: target, sha256: hash(readFileSync(target)), preview });
  }
  const manifest = join(destination, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), why, source,
    entry: join(destination, previewName(source)), files, missing: [...new Set(missing)],
    verified: missing.length === 0, verification: 'Static dependencies and retained file hashes; open the entry to verify rendering.',
  }, null, 2), { flag: 'wx' });
  return manifest;
}
