import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * The OS's own notification, for a manager with something important and nobody looking
 * (spec 2026-10-31-managers). Text travels as argv or env, never into a script: a headline can
 * quote a pull request title. Never throws; a machine that cannot show one simply shows none.
 */

const TIMEOUT_MS = 5_000;

const WINDOWS_TOAST = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$n = New-Object System.Windows.Forms.NotifyIcon',
  '$n.Icon = [System.Drawing.SystemIcons]::Information',
  '$n.Visible = $true',
  '$n.ShowBalloonTip(10000, $env:CEZ_NOTIFY_TITLE, $env:CEZ_NOTIFY_BODY, [System.Windows.Forms.ToolTipIcon]::Info)',
  'Start-Sleep -Seconds 6',
  '$n.Dispose()',
].join('; ');

const onPath = (binary: string, env: NodeJS.ProcessEnv): boolean =>
  (env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, binary)));

export function systemNotificationsAvailable(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  return platform === 'linux' && onPath('notify-send', env);
}

export interface SystemCommand {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

export function systemNotifyCommand(title: string, body: string, platform: NodeJS.Platform = process.platform): SystemCommand | undefined {
  if (platform === 'darwin') {
    return {
      file: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body],
    };
  }
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_TOAST],
      env: { CEZ_NOTIFY_TITLE: title, CEZ_NOTIFY_BODY: body },
    };
  }
  if (platform === 'linux') return { file: 'notify-send', args: ['--app-name=cezar', '--', title, body] };
  return undefined;
}

export function sendSystemNotification(title: string, body: string): void {
  const command = systemNotifyCommand(title, body);
  if (!command) return;
  const timeout = command.env ? TIMEOUT_MS * 3 : TIMEOUT_MS;
  try {
    execFile(command.file, command.args, { timeout, windowsHide: true, env: { ...process.env, ...command.env } }, () => undefined).unref();
  } catch {
    // No notifier is not an error worth a line: the chat and the unread dot still carry it.
  }
}
