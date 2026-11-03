import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GH_NO_SESSION_BUS, ghEnv } from './gh-env.ts';

/** On Linux a `gh` call with no session bus address had `dbus-launch` start a bus that nothing
 *  stopped — one daemon per call, every five minutes, until the user's inotify instances were gone
 *  and no file watcher could start (cli/cli#7582). */
describe('ghEnv', () => {
  it('names a bus nothing listens on when Linux has no session bus address', () => {
    const env = ghEnv({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux');
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(GH_NO_SESSION_BUS);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('keeps a session bus the environment already names', () => {
    const base = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
    expect(ghEnv(base, 'linux')).toBe(base);
  });

  it('is the identity off Linux — gh reads the keychain there without D-Bus', () => {
    const base = { PATH: '/usr/bin' };
    expect(ghEnv(base, 'darwin')).toBe(base);
    expect(ghEnv(base, 'win32')).toBe(base);
  });

  it('does not write into the environment it was given', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    ghEnv(base, 'linux');
    expect(base.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.includes('.testkit.') ? [path] : [];
  });
}

/** A `gh` spawned anywhere in the service: `exec('gh', …)`, `execFile('gh', …)`, `spawn('gh', …)`,
 *  a poller's `run('gh', …)`, `execTool(…, 'gh', …)`, or a runner typed to take `'gh' | 'git'`. */
const GH_SPAWN = /\b(?:exec|execFile|execFileAsync|spawn|run)\(\s*'gh'|execTool\([^)]*'gh'|'git' \| 'gh'|'gh' \| 'git'/s;
const IMPORTS_HELPER = /from '(?:\.\.\/)*(?:\.\/)?(?:core\/)?gh-env\.ts'/;
/** The shared project runner applies `ghEnv` to every command it spawns (`create-project.ts`,
 *  which this guard checks itself), so a file whose `gh` calls go through it is covered too. */
const USES_SHARED_RUNNER = /import \{[^}]*\bspawnCommandRunner\b[^}]*\} from '(?:\.\.?\/)+(?:server\/)?create-project\.ts'/;

describe('every gh call site runs with ghEnv', () => {
  it('imports the helper in each file that spawns gh', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => [path.slice(SRC.length + 1), readFileSync(path, 'utf8')] as const)
      .filter(([, text]) => GH_SPAWN.test(text) && !IMPORTS_HELPER.test(text) && !USES_SHARED_RUNNER.test(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
