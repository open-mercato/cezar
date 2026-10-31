/**
 * OS-verified process and boot identity for webhook ownership fencing
 * (spec `.ai/specs/2026-10-12-outbound-webhooks.md` §"Single owner and lazy projects").
 *
 * A heartbeat, a bare PID or process age never proves death. Linux reads `/proc`; macOS and
 * Windows ask the OS (`ps`/`sysctl`, PowerShell). Every probe is fail-closed: a probe that
 * cannot run throws, so an unverifiable owner is never declared dead and never double-owned.
 *
 * The returned `start` is an opaque, platform-local token that is stable for the life of one
 * process and different for a later process that reuses its PID.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { webhookPlatformSupported, WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE } from './platform.ts';

// A cold Windows PowerShell + CIM spawn can exceed 10s on a loaded or emulated host. Timing out
// still fails closed, but the bound must leave enough room for a valid probe to complete.
const PROBE_TIMEOUT_MS = 30000;
/** Linux `pid_max` max is 2^22; a larger requested pid cannot be live there. */
const MAX_LINUX_PID = 4_194_304;
/** macOS `ps` refuses any pid at or above 100000 (kernel PID_MAX is 99999; 100000 is NO_PID). */
const MAX_DARWIN_PID = 99_999;
/** Windows pids are full 32-bit values, so applying the Linux ceiling would declare a live owner dead. */
const MAX_WIN32_PID = 0xffff_ffff;
const VERIFY_ERROR = 'Cannot verify process identity';
/** Printed last by the Windows probe so a script that died mid-way is never read as "no such pid". */
const WINDOWS_PROBE_SENTINEL = 'cez-probe-complete';
/** Printed last by the combined own-process probe; start and boot must come from one complete run. */
const WINDOWS_OWN_PROBE_SENTINEL = 'cez-own-probe-complete';

async function probe(command: string, args: string[], partial = false, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', env: environment, windowsHide: true }, (error, stdout) => {
      // execFile reports a normal nonzero exit with a numeric code. Spawn errors,
      // signals, timeouts and output-limit kills must never be read as an absent PID.
      const normalExit = error && !error.killed && error.signal == null && typeof error.code === 'number';
      if (!error || (partial && normalExit)) resolve(stdout);
      else reject(new Error(VERIFY_ERROR));
    });
  });
}

function linuxProcessStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error(VERIFY_ERROR);
    return fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(VERIFY_ERROR);
  }
}

/** Parses `ps -o pid=,state=,lstart=` output; exported so the macOS parse is pinned without a Mac. */
export function parseDarwinProcessStarts(output: string): Map<number, string> {
  const starts = new Map<number, string>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    // Match the C-locale tail `Www Mmm dd hh:mm:ss yyyy` by shape rather than a fixed 24-column
    // slice: a widened field must fail closed, never silently drop a live owner's row.
    const match = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\d{4})\s*$/.exec(line);
    const rawPid = match?.[1], state = match?.[2], rawStart = match?.[3];
    if (rawPid === undefined || state === undefined || rawStart === undefined) throw new Error(VERIFY_ERROR);
    if (state.startsWith('Z') || state.startsWith('X')) continue;
    // `lstart` under TZ=UTC is UTC wall time without a zone suffix, so pin GMT when parsing.
    const seconds = Math.floor(new Date(`${rawStart.replace(/\s+/g, ' ')} GMT`).getTime() / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(VERIFY_ERROR);
    starts.set(Number(rawPid), String(seconds));
  }
  return starts;
}

async function darwinProcessStarts(pids: number[]): Promise<Map<number, string>> {
  // `LC_ALL`/`TZ` must be pinned on BOTH writer and reader: a locale- or zone-dependent
  // `lstart` string would make a live owner look dead and authorize an unsafe takeover. The
  // binaries are absolute: a GUI/launchd PATH has /usr/bin but sysctl lives in /usr/sbin.
  return parseDarwinProcessStarts(await probe('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,state=,lstart='], true, { ...process.env, LC_ALL: 'C', TZ: 'UTC' }));
}

/**
 * Parses the Windows probe output. A pid counts as absent only when the probe ran to the end
 * (sentinel present) and did not report it; a pid that exists but whose start time is unreadable
 * (`unknown`) fails closed — dropping it would declare a live owner dead and authorize takeover.
 */
export function parseWindowsProcessStarts(output: string): Map<number, string> {
  const lines = output.split('\n').map(line => line.trim());
  if (!lines.includes(WINDOWS_PROBE_SENTINEL)) throw new Error(VERIFY_ERROR);
  const starts = new Map<number, string>();
  for (const line of lines) {
    if (!line || line === WINDOWS_PROBE_SENTINEL) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(line);
    const rawPid = match?.[1], ticks = match?.[2];
    if (rawPid === undefined || ticks === undefined) throw new Error(VERIFY_ERROR);
    starts.set(Number(rawPid), ticks);
  }
  return starts;
}

async function windowsProcessStarts(pids: number[]): Promise<Map<number, string>> {
  // `Get-Process -Id` conflates "no such process" with a failed lookup, and only an unreadable
  // `StartTime` fails closed — so one full listing is taken instead, where a pid's absence from the
  // snapshot is the only way to read it as gone. A listing that fails kills the script before the
  // sentinel, which the parser rejects. `StartTime` throws for a process this user cannot open
  // (protected/elevated/other-user), so that case is reported as `unknown`, never as absent.
  return parseWindowsProcessStarts(await probe(powershellCommand(), ['-NoProfile', '-NonInteractive', '-Command', windowsProbeScript(pids)]));
}

/**
 * Windows PowerShell lives at a fixed system path; a service or scheduled-task context can have a
 * trimmed PATH, where a bare `powershell` would ENOENT and leave webhooks unavailable. Exported so
 * the resolution is pinned on a host that cannot run PowerShell.
 */
export function powershellCommand(environment: NodeJS.ProcessEnv = process.env): string {
  const root = environment.SystemRoot ?? environment.windir;
  const absolute = root ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined;
  return absolute && existsSync(absolute) ? absolute : 'powershell';
}

/** Exported so the Windows-only hardening is pinned on a host that cannot run PowerShell. */
export function windowsProbeScript(pids: number[]): string {
  return `$all = @(Get-Process -ErrorAction Stop); foreach ($id in @(${pids.join(',')})) { $p = $all | Where-Object { $_.Id -eq $id } | Select-Object -First 1; if ($null -eq $p) { continue }; try { "$id $($p.StartTime.ToUniversalTime().Ticks)" } catch { "$id unknown" } }; '${WINDOWS_PROBE_SENTINEL}'`;
}

/** Windows-only combined probe: one cold PowerShell start supplies the start token and diagnostic boot timestamp. */
async function windowsOwnProcessIdentity(pid: number): Promise<OwnProcessIdentity> {
  const script = `$all = @(Get-Process -ErrorAction Stop); $p = $all | Where-Object { $_.Id -eq ${pid} } | Select-Object -First 1; if ($null -eq $p) { throw 'own process missing' }; $start = $p.StartTime.ToUniversalTime().Ticks; $boot = ${WINDOWS_BOOT_SCRIPT}; "${pid} $start $boot"; '${WINDOWS_OWN_PROBE_SENTINEL}'`;
  const lines = (await probe(powershellCommand(), ['-NoProfile', '-NonInteractive', '-Command', script]))
    .split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.at(-1) !== WINDOWS_OWN_PROBE_SENTINEL || lines.length !== 2) throw new Error(VERIFY_ERROR);
  const match = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(lines[0]!);
  if (!match || Number(match[1]) !== pid) throw new Error(VERIFY_ERROR);
  return { pid, start: match[2]!, boot: match[3]! };
}

/** Largest pid that can be live on this platform; a larger requested pid is provably absent. */
export function maxProbePid(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return MAX_WIN32_PID;
  // macOS `ps` rejects any pid >= 100000 with "process id too large" and aborts the WHOLE call,
  // so a pid above its ceiling must be dropped before the probe, never sent to `ps`.
  if (platform === 'darwin') return MAX_DARWIN_PID;
  return MAX_LINUX_PID;
}

/** Start tokens for the requested PIDs. A PID absent from the result is provably not running. */
export async function processStarts(pids: number[]): Promise<Map<number, string>> {
  const ceiling = maxProbePid();
  const candidates = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0 && pid <= ceiling);
  if (!candidates.length) return new Map();
  if (!webhookPlatformSupported()) throw new Error(WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE);
  if (process.platform === 'linux') {
    const starts = new Map<number, string>();
    for (const pid of candidates) { const start = linuxProcessStart(pid); if (start !== undefined) starts.set(pid, start); }
    return starts;
  }
  return process.platform === 'darwin' ? darwinProcessStarts(candidates) : windowsProcessStarts(candidates);
}

let bootCache: string | undefined;
/** Windows-only, exported so the boot-token choice is pinned without a Windows host. */
export const WINDOWS_BOOT_SCRIPT = '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks';
async function bootIdentity(): Promise<string> {
  if (bootCache !== undefined) return bootCache;
  if (process.platform === 'linux') bootCache = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  else if (process.platform === 'darwin') bootCache = (await probe('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).trim();
  // `LastBootUpTime` arrives as a Local-kind DateTime (MMI zone-converts the WMI instant), so raw
  // `.Ticks` would be that instant re-rendered in the CURRENT zone. `ToUniversalTime()` is the exact
  // inverse. That was measured on .NET 8 only; the shipped Windows PowerShell 5.1 runs on .NET
  // Framework and is unmeasured. It no longer matters for safety: the value derives from KeBootTime,
  // which the kernel shifts whenever system time is SET (NTP step, manual change), so a Windows boot
  // mismatch never authorizes a takeover on its own (`bootIsStableId`) and only pid+start decide.
  else if (process.platform === 'win32') bootCache = (await probe(powershellCommand(), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_BOOT_SCRIPT])).trim();
  else throw new Error(WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE);
  if (!bootCache) throw new Error(VERIFY_ERROR);
  return bootCache;
}

/**
 * Whether a boot token is a random per-boot ID (Linux `boot_id`, macOS `kern.bootsessionuuid`),
 * so that two different tokens prove two different boots. The Windows token is a derived boot
 * INSTANT that moves with clock steps; a mismatch there proves nothing and the owner's pid and
 * absolute start time must decide instead.
 */
export function bootIsStableId(boot: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(boot);
}

/** Linux PID namespace (`pid:[<inode>]`): a pid read from /proc means nothing outside its namespace. */
function linuxPidNamespace(): string {
  try {
    const link = readlinkSync('/proc/self/ns/pid');
    if (/^pid:\[\d+\]$/.test(link)) return link;
  } catch { /* fall through: an unreadable namespace cannot be fenced */ }
  throw new Error(VERIFY_ERROR);
}

export interface OwnProcessIdentity { pid: number; start: string; boot: string; pidNamespace?: string }
let ownCache: OwnProcessIdentity | undefined;
/**
 * This process's own identity, memoized: it cannot change while the process lives, and
 * re-probing on every ownership check would shell out on the hot path (`valid()`).
 */
async function loadOwnProcessIdentity(): Promise<OwnProcessIdentity> {
  if (ownCache) return ownCache;
  if (process.platform === 'win32') return ownCache = await windowsOwnProcessIdentity(process.pid);
  const start = (await processStarts([process.pid])).get(process.pid);
  if (start === undefined) throw new Error(VERIFY_ERROR);
  const boot = await bootIdentity();
  ownCache = { pid: process.pid, start, boot, ...(process.platform === 'linux' ? { pidNamespace: linuxPidNamespace() } : {}) };
  return ownCache;
}

// Coalesce concurrent first opens; a failed probe is retryable rather than cached forever.
let ownPending: Promise<OwnProcessIdentity> | undefined;
export async function ownProcessIdentity(): Promise<OwnProcessIdentity> {
  if (ownCache) return ownCache;
  if (!ownPending) ownPending = loadOwnProcessIdentity().finally(() => { ownPending = undefined; });
  return ownPending;
}
