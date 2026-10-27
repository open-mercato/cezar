import { afterEach, expect, it, vi } from 'vitest';
const child = vi.hoisted(() => ({ async: vi.fn(), sync: vi.fn(() => '4242 123\ncez-probe-complete\n') }));
vi.mock('node:child_process', () => ({ execFile: child.async, execFileSync: child.sync }));
import { processStarts } from './process-identity.ts';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); });
it('leaves the event loop available while a Windows process probe is pending', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let finish!: () => void;
  child.async.mockImplementation((_command, _args, _options, callback) => {
    finish = () => callback(null, '4242 123\ncez-probe-complete\n', '');
  });
  let settled = false;
  const pending = Promise.resolve(processStarts([4242])).then(result => { settled = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(child.sync.mock.calls.length).toBe(0);
  expect(settled).toBe(false);
  finish();
  expect((await pending).get(4242)).toBe('123');
});
