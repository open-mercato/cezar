import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative, sep } from 'node:path';

/**
 * Windows' os.tmpdir() is the 8.3 spelling C:\Users\RUNNER~1\… that the JS realpath keeps and the
 * native realpath (and so fs.promises.realpath and the project registry) expands. On POSIX a
 * symlinked tmp root plays the short name: os.tmpdir() and the JS realpathSync answer `short`,
 * the native realpaths answer `long`. Patches the builtins in place, so injection through
 * syncBuiltinESMExports keeps working. A no-op on win32, which has the real thing.
 */
export function installShortName(): { short: string; long: string; uninstall(): void } {
  const outer = fs.mkdtempSync(join(fs.realpathSync.native(os.tmpdir()), 'short-name-'));
  const long = join(outer, 'long'), short = join(outer, 'short');
  fs.mkdirSync(long); fs.symlinkSync(long, short, 'dir');
  if (process.platform === 'win32') return { short: long, long, uninstall: () => fs.rmSync(outer, { recursive: true, force: true }) };
  const { realpathSync, lstatSync } = fs, tmpdir = os.tmpdir;
  const under = (path: string) => path === short || path.startsWith(short + sep);
  fs.realpathSync = Object.assign((path: fs.PathLike, options?: unknown) => {
    const value = String(path);
    if (!under(value)) return realpathSync(path, options as never);
    // Like Windows: the target must exist, but the spelling comes back unexpanded.
    realpathSync(join(long, relative(short, value)));
    return value;
  }, { native: realpathSync.native }) as typeof fs.realpathSync;
  // A short name is not a link: lstat sees the directory it names.
  (fs as { lstatSync: typeof lstatSync }).lstatSync = ((path: fs.PathLike, options?: unknown) => lstatSync(String(path) === short ? long : path, options as never)) as typeof fs.lstatSync;
  os.tmpdir = () => short;
  syncBuiltinESMExports();
  return {
    short, long,
    uninstall() {
      fs.realpathSync = realpathSync; (fs as { lstatSync: typeof lstatSync }).lstatSync = lstatSync; os.tmpdir = tmpdir; syncBuiltinESMExports();
      fs.rmSync(outer, { recursive: true, force: true });
    },
  };
}
