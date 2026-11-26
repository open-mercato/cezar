import * as childProcess from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { sendSystemNotification, systemNotificationsAvailable, systemNotifyCommand } from './system-notify.ts';

const hostile = `"; rm -rf ~ #' $(touch x)`;

describe('systemNotifyCommand', () => {
  it('keeps text out of the macOS script', () => {
    const command = systemNotifyCommand('Manager', hostile, 'darwin')!;
    expect(command.args.at(-1)).toBe(hostile);
    expect(command.args.slice(0, -2).join(' ')).not.toContain('rm -rf');
  });

  it('ends osascript options before the text: a dash-leading name is no script line', () => {
    const title = '-eproperty a:(do shell script "x")';
    expect(systemNotifyCommand(title, 'b', 'darwin')!.args.slice(-3)).toEqual(['--', title, 'b']);
  });

  it('delegates to the cockpit, browser, or System Events on macOS to avoid opening Finder', () => {
    const command = systemNotifyCommand('Manager', 'Settled', 'darwin')!;
    expect(command.file).toBe('osascript');
    const script = command.args[1]!;
    // Must target Cezar or a browser if running, or System Events as clean fallback
    expect(script).toContain('tell application "System Events"');
    expect(script).toContain('"Cezar"');
    expect(script).toContain('"Safari"');
    expect(script).toContain('"Google Chrome"');
    expect(script).toContain('tell application targetApp to display notification');
    // Must not invoke bare display notification at top level without an app target
    expect(script).not.toMatch(/^\s*display notification/m);
  });

  it.runIf(process.platform === 'darwin')('compiles the macOS notification AppleScript without syntax errors', () => {
    const command = systemNotifyCommand('Manager', 'Settled', 'darwin')!;
    // osacompile checks AppleScript syntax without displaying any notification
    const result = childProcess.spawnSync('osacompile', ['-e', command.args[1]!, '-o', '/dev/null']);
    expect(result.status).toBe(0);
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

describe('sendSystemNotification', () => {
  it('invokes the runner with timeout, unref, and correct arguments', () => {
    const unref = vi.fn();
    const mockRunner = vi.fn().mockReturnValue({ unref });
    sendSystemNotification('Title', 'Body', mockRunner as unknown as typeof childProcess.execFile);
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(mockRunner).toHaveBeenCalled();
      expect(unref).toHaveBeenCalled();
    }
  });

  it('swallows synchronous exceptions from runner without throwing', () => {
    const mockRunner = vi.fn().mockImplementation(() => {
      throw new Error('spawn error');
    });
    expect(() => sendSystemNotification('Title', 'Body', mockRunner as unknown as typeof childProcess.execFile)).not.toThrow();
  });
});

describe('systemNotificationsAvailable', () => {
  it('needs notify-send on Linux, and nothing on macOS or Windows', () => {
    expect(systemNotificationsAvailable('darwin', {})).toBe(true);
    expect(systemNotificationsAvailable('win32', {})).toBe(true);
    expect(systemNotificationsAvailable('linux', { PATH: '/nowhere-at-all' })).toBe(false);
  });
});
