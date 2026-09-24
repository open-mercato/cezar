import { describe, expect, it, vi } from 'vitest';
import { CANCEL } from './types.ts';
import { createAutoUi, createClackUi, type PromptBackend } from './ui.ts';

const CANCEL_SYMBOL = Symbol('clack.cancel');

function fakeBackend(over: Partial<PromptBackend>): PromptBackend {
  const noop = () => undefined;
  return {
    intro: noop,
    outro: noop,
    note: noop,
    log: { info: noop, success: noop, warn: noop, error: noop, message: noop, step: noop } as never,
    select: vi.fn(),
    multiselect: vi.fn(),
    confirm: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    spinner: () => ({ start: noop, stop: noop, message: noop }) as never,
    isCancel: (v: unknown): v is symbol => v === CANCEL_SYMBOL,
    ...over,
  };
}

describe('createClackUi', () => {
  it('maps a cancelled prompt to the CANCEL sentinel, never throws', async () => {
    const ui = createClackUi(fakeBackend({ select: vi.fn().mockResolvedValue(CANCEL_SYMBOL) }));
    await expect(ui.select({ message: 'pick', options: [{ value: 'a', label: 'A' }] })).resolves.toBe(
      CANCEL,
    );
  });

  it('returns the value when the user answers', async () => {
    const ui = createClackUi(fakeBackend({ confirm: vi.fn().mockResolvedValue(true) }));
    await expect(ui.confirm({ message: 'ok?' })).resolves.toBe(true);
  });
});

describe('createClackUi non-TTY guard', () => {
  it('refuses a non-interactive terminal instead of hanging on a prompt', () => {
    // vitest runs without a TTY, so the real backend must throw the clean
    // preflight error (a piped/ssh run would otherwise hang holding the lock).
    expect(() => createClackUi()).toThrow(/not interactive.*--yes/s);
  });
});

describe('createAutoUi', () => {
  it('answers with initial values / first option and never blocks', async () => {
    const ui = createAutoUi();
    expect(await ui.confirm({ message: 'ok?', initialValue: false })).toBe(false);
    expect(await ui.select({ message: 'pick', options: [{ value: 'x', label: 'X' }] })).toBe('x');
    expect(await ui.multiselect({ message: 'many', options: [] })).toEqual([]);
  });

  it('never adopts a placeholder as an answer — it is a hint, not input', async () => {
    const ui = createAutoUi();
    expect(await ui.text({ message: 'name', placeholder: 'cezar.ngrok.app' })).toBe('');
    expect(await ui.text({ message: 'name', placeholder: 'def', initialValue: 'real' })).toBe('real');
  });

  it('strictValidate makes an invalid auto-answer abort instead of flowing on', async () => {
    const strict = createAutoUi({}, () => {}, { strictValidate: true });
    await expect(
      strict.text({ message: 'authtoken', validate: (v) => (v.trim() ? undefined : 'required') }),
    ).rejects.toThrow(/cannot auto-answer "authtoken".*required/s);
    await expect(
      strict.password({ message: 'pw', validate: (v) => (v.length >= 6 ? undefined : 'too short') }),
    ).rejects.toThrow(/too short/);
    // a valid answer (via overrides) passes
    const withAnswer = createAutoUi({ pw: 'longenough' }, () => {}, { strictValidate: true });
    expect(await withAnswer.password({ message: 'pw', validate: (v) => (v.length >= 6 ? undefined : 'too short') })).toBe('longenough');
    // lenient (dry-run) mode walks on with the placeholder-grade value
    const lenient = createAutoUi();
    expect(await lenient.password({ message: 'pw', validate: (v) => (v.length >= 6 ? undefined : 'too short') })).toBe('');
  });

  it('honors per-message answer overrides', async () => {
    const ui = createAutoUi({ 'pick tools': ['gh', 'codex'] });
    expect(await ui.multiselect({ message: 'pick tools', options: [] })).toEqual(['gh', 'codex']);
  });

  it('routes message() to the sink (plain output, no note box)', () => {
    const sink = vi.fn();
    const ui = createAutoUi({}, sink);
    ui.message('sudo bash -lc ...');
    expect(sink).toHaveBeenCalledWith('sudo bash -lc ...');
  });
});
