import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { canonicalPath } from '../canonical-path.ts';
import { botDirectory } from '../chat/ownership.ts';
import { ExtensionManager } from '../extensions/manager.ts';
import { retainProjectExtensions } from '../extensions/project-runtime.ts';
import { installShortName } from '../test-support/short-name.testkit.ts';
import { WebhookCoordinator } from './coordinator.ts';
import { prepareStorage } from './storage.ts';

// Two spellings of one root (Windows' C:\Users\RUNNER~1 vs C:\Users\runneradmin) must be ONE owner
// everywhere a root or cezar home is keyed: one service, one lock, one bot dir, one chat scope.
const spelling = installShortName(); afterAll(() => spelling.uninstall());
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
let n = 0;
function project(): { short: string; long: string } {
  const name = `project-${n++}`, long = join(spelling.long, name);
  mkdirSync(long); execFileSync('git', ['init', '-q'], { cwd: long });
  return { short: join(spelling.short, name), long };
}

it.skipIf(process.platform === 'win32')('simulates a spelling the JS realpath keeps and the native one expands', () => {
  const { short, long } = project();
  expect(realpathSync(short)).toBe(short);
  expect(canonicalPath(short)).toBe(long);
});

it('holds one webhook service and one owner lock for both spellings of a root', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); const { short, long } = project();
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [] });
  cleanups.push(() => coordinator.dispose());
  const first = await coordinator.get('spelling', short);
  await expect(coordinator.get('spelling', long)).resolves.toBe(first);
  expect(coordinator.count()).toBe(1);
  expect(existsSync(join(long, '.ai/cezar/webhooks/owner.lock'))).toBe(true);
});

it('prepares the same storage directory for both spellings', async () => {
  const { short, long } = project();
  const fromShort = await prepareStorage(short, join(short, '.ai/cezar'), false);
  expect(await prepareStorage(long, join(long, '.ai/cezar'), false)).toBe(fromShort);
  expect(fromShort).toBe(join(long, '.ai/cezar/webhooks'));
});

it('keys the bot directory, the extension chat scope and the project runtime by one spelling', async () => {
  const { short, long } = project();
  mkdirSync(join(long, 'home'));
  vi.stubEnv('CEZ_HOME', join(short, 'home')); const fromShort = botDirectory('bot', true);
  vi.stubEnv('CEZ_HOME', join(long, 'home')); expect(botDirectory('bot', true)).toBe(fromShort);
  const home = join(long, 'home');
  expect(new ExtensionManager(join(short, '.ai/cezar'), 'spelling', short, { home }).projectRoot)
    .toBe(new ExtensionManager(join(long, '.ai/cezar'), 'spelling', long, { home }).projectRoot);
  const a = await retainProjectExtensions({ root: short, dataDir: join(short, '.ai/cezar'), projectId: 'spelling' });
  cleanups.push(() => a.release());
  const b = await retainProjectExtensions({ root: long, dataDir: join(long, '.ai/cezar'), projectId: 'spelling' });
  cleanups.push(() => b.release());
  expect(b.manager).toBe(a.manager);
});
