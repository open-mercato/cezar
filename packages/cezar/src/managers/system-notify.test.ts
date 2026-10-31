import { describe, expect, it } from 'vitest';
import { systemNotificationsAvailable, systemNotifyCommand } from './system-notify.ts';

const hostile = `"; rm -rf ~ #' $(touch x)`;

describe('systemNotifyCommand', () => {
  it('keeps text out of the macOS script', () => {
    const command = systemNotifyCommand('Manager', hostile, 'darwin')!;
    expect(command.args.at(-1)).toBe(hostile);
    expect(command.args.slice(0, -2).join(' ')).not.toContain('rm -rf');
  });

  it('keeps text out of the PowerShell command line', () => {
    const command = systemNotifyCommand('Manager', hostile, 'win32')!;
    expect(command.args.join(' ')).not.toContain('rm -rf');
    expect(command.env?.CEZ_NOTIFY_BODY).toBe(hostile);
  });

  it('ends notify-send options before the text', () => {
    expect(systemNotifyCommand('--help', 'b', 'linux')!.args).toEqual(['--app-name=cezar', '--', '--help', 'b']);
  });

  it('has nothing to run elsewhere', () => {
    expect(systemNotifyCommand('t', 'b', 'aix')).toBeUndefined();
  });
});

describe('systemNotificationsAvailable', () => {
  it('needs notify-send on Linux, and nothing on macOS or Windows', () => {
    expect(systemNotificationsAvailable('darwin', {})).toBe(true);
    expect(systemNotificationsAvailable('win32', {})).toBe(true);
    expect(systemNotificationsAvailable('linux', { PATH: '/nowhere-at-all' })).toBe(false);
  });
});
