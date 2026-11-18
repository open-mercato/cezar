import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// The ONE spelling of a project root or cezar home for webhooks, chat and extensions. Always the
// native realpath, like the registry's fs.promises.realpath: the JS realpathSync keeps Windows 8.3
// names (C:\Users\RUNNER~1) the native one expands, and two spellings of one root become two owners.

/** The canonical path of an existing directory; throws (ENOENT, EACCES, …) when it cannot be resolved. */
export function canonicalPath(path: string): string {
  return realpathSync.native(path);
}

/** A trusted anchor (project root, cezar home) as its realpath: links ABOVE it are the machine's
 *  layout (macOS /var → /private/var, Silverblue /home → /var/home), not planted state. A missing
 *  leaf keeps its name under the canonical parent; never throws. */
export function canonicalAnchor(path: string): string {
  try { return canonicalPath(path); }
  catch { try { return join(canonicalPath(dirname(path)), basename(path)); } catch { return resolve(path); } }
}

/** The project root as its realpath and a project-relative data dir rebased onto it, so only links
 *  inside the project are refused. An external data dir stays as given. Throws when the root is gone. */
export function canonicalProjectPaths(root: string, dataDir: string): { root: string; dataDir: string } {
  const canonical = canonicalPath(root);
  const suffix = relative(resolve(root), resolve(dataDir));
  const inside = !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
  return { root: canonical, dataDir: inside ? resolve(canonical, suffix) : resolve(dataDir) };
}
