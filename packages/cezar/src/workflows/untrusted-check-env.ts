/**
 * Fork checks must not inherit cockpit credentials or shell/runtime startup hooks.
 * Agent environments deliberately include backend and GitHub auth, so buildChildEnv
 * is not suitable here. Keep this exact-name list independent of passthrough flags.
 * This curates the environment; it does not sandbox filesystem or network access.
 */
const ESSENTIAL_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY',
  'LC_NUMERIC', 'LC_TIME', 'LC_ADDRESS', 'LC_IDENTIFICATION',
  'LC_MEASUREMENT', 'LC_NAME', 'LC_PAPER', 'LC_TELEPHONE',
  // Windows uses mixed-case names; preserve the spelling from the source.
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
]);

export function untrustedCheckEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(
    ([name, value]) => value !== undefined && ESSENTIAL_NAMES.has(name.toUpperCase()),
  ));
}
