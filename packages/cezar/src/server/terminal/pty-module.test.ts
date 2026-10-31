import { afterEach, describe, expect, it } from 'vitest';

import { loadPty, resetPtyCache, setPtyBindingForTest, type PtyBinding } from './pty-module.ts';

afterEach(() => {
  resetPtyCache();
});

/** The whole job of this module is to never throw. Every case below is a way the optional
 *  dependency can be absent or broken on a user's machine, and each must come back as an ANSWER
 *  the cockpit can render — AGENTS.md § Zero config: "degrade to a smaller working cockpit, never
 *  fail the boot". */
describe('loadPty', () => {
  it('reports the real binding when the package is there', async () => {
    const spawn = () => {
      throw new Error('not called');
    };
    const binding = await loadPty(async () => ({ spawn }));
    expect(binding.available).toBe(true);
  });

  it('accepts the CommonJS `default` interop shape too', async () => {
    // Node may hand back the namespace, the interop object, or both, depending on how the CJS
    // package was written and on the Node version.
    const binding = await loadPty(async () => ({ default: { spawn: () => { throw new Error('x'); } } }));
    expect(binding.available).toBe(true);
  });

  it('is an honest unavailable, not a throw, when the package is not installed', async () => {
    const binding = await loadPty(async () => {
      throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' });
    });
    expect(binding.available).toBe(false);
    expect(binding.available === false && binding.reason).toContain('not installed for this platform');
  });

  it('carries the message when the binary itself will not load', async () => {
    // An installed package whose prebuilt binary is for another libc, or is corrupt.
    const binding = await loadPty(async () => {
      throw new Error('dlopen failed: wrong architecture');
    });
    expect(binding.available).toBe(false);
    expect(binding.available === false && binding.reason).toContain('wrong architecture');
  });

  it('refuses a module that loaded but exposes no spawn', async () => {
    const binding = await loadPty(async () => ({ somethingElse: 1 }));
    expect(binding.available).toBe(false);
    expect(binding.available === false && binding.reason).toContain('no spawn()');
  });

  it('survives a thrown non-Error', async () => {
    const binding = await loadPty(async () => {
      throw 'just a string';
    });
    expect(binding.available).toBe(false);
  });

  it('imports once, however many columns ask at the same tick', async () => {
    let calls = 0;
    const importer = async () => {
      calls += 1;
      return { spawn: () => { throw new Error('x'); } };
    };
    // Cached as the PROMISE, so a race cannot start two imports of a native module.
    await Promise.all([loadPty(importer), loadPty(importer), loadPty(importer)]);
    expect(calls).toBe(1);
  });

  it('can be told an answer outright, which is how the session tests avoid forking shells', async () => {
    const fake: PtyBinding = { available: false, reason: 'pretend' };
    setPtyBindingForTest(fake);
    expect(await loadPty()).toBe(fake);
  });
});
