import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * The OS's own notification, for a manager with something important and nobody looking
 * (spec 2026-10-31-managers). Text travels as argv or env, never into a script: a headline can
 * quote a pull request title. Never throws; a machine that cannot show one simply shows none.
 */

const TIMEOUT_MS = 5_000;

/**
 * On macOS, notifications posted directly from an unbundled CLI process like osascript cause
 * Notification Center to activate Finder when clicked. Delegating to a running cockpit app (Cezar),
 * a running browser, or System Events ensures clicking/activating the notification focuses the
 * cockpit/browser or stays clean, never opening Finder.
 */
const MACOS_NOTIFY = [
  'on run argv',
  '  set targetApp to "System Events"',
  '  try',
  '    tell application "System Events"',
  '      set frontApp to name of first process whose frontmost is true',
  '      set runningApps to name of every process whose background only is false',
  '    end tell',
  '    set candidateApps to {"Cezar", "Google Chrome", "Safari", "Brave Browser", "Arc", "Microsoft Edge", "Firefox", "Opera", "Vivaldi", "Orion", "Chromium"}',
  '    if candidateApps contains frontApp then',
  '      set targetApp to frontApp',
  '    else',
  '      repeat with cand in candidateApps',
  '        if runningApps contains cand then',
  '          set targetApp to contents of cand',
  '          exit repeat',
  '        end if',
  '      end repeat',
  '    end if',
  '  end try',
  '  try',
  '    tell application targetApp to display notification (item 2 of argv) with title (item 1 of argv)',
  '  on error',
  '    tell application "System Events" to display notification (item 2 of argv) with title (item 1 of argv)',
  '  end try',
  'end run',
].join('\n');

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
      // `--` is load-bearing: a title starting `-e` would otherwise compile as AppleScript.
      args: ['-e', MACOS_NOTIFY, '--', title, body],
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

export function sendSystemNotification(title: string, body: string, runner: typeof execFile = execFile): void {
  const command = systemNotifyCommand(title, body);
  if (!command) return;
  const timeout = command.env ? TIMEOUT_MS * 3 : TIMEOUT_MS;
  try {
    runner(command.file, command.args, { timeout, windowsHide: true, env: { ...process.env, ...command.env } }, () => undefined).unref();
  } catch {
    // No notifier is not an error worth a line: the chat and the unread dot still carry it.
  }
}
