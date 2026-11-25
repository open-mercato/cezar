import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushTelemetry, setTelemetryConsent } from './telemetry.ts';
import {
  cockpitLogPath, collectUncleanExits, hostId, logFacts, parseMarker, reportUncleanExits, startLiveMarker,
  uncleanShutdownError, type LiveMarker,
} from './unclean-exit.ts';

const NOW = Date.parse('2026-11-25T12:40:00Z');
const HOST = hostId('this-host');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-live-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function marker(over: Partial<LiveMarker> = {}): LiveMarker {
  return {
    pid: 87001, host: HOST, startedAt: Date.parse('2026-11-25T11:30:00.500Z'), beatAt: NOW - 30_000,
    version: '0.21.0', reportVersion: '0.21.0', runtime: 'app', rssMb: 412, runsRunning: 3, ...over,
  };
}
function put(m: LiveMarker): void {
  writeFileSync(join(dir, `${m.pid}-${m.host}.json`), JSON.stringify(m));
}
const dead = () => false;
const collect = (logTail = '', over: Parameters<typeof collectUncleanExits>[0] = {}) =>
  collectUncleanExits({ dir, logTail, now: NOW, hostUptimeS: 86_400, isAlive: dead, host: HOST, selfStartedAt: NOW, ...over });

/** The desktop shell's cockpit log (#2489) around a group SIGKILL that took the shell down too. */
const LOG = [
  '2026-11-25T11:30:00.000Z --- starting the cockpit: /Users/ann/.cezar/versions/0.21.0/x.js (port 4321)',
  '2026-11-25T11:30:00.010Z --- cockpit process pid 87001',
  '2026-11-25T11:30:01.000Z   cezar is running on http://127.0.0.1:4321',
  '2026-11-25T12:37:20.000Z [run] secret prompt text about acme-corp',
  '2026-11-25T12:41:00.000Z --- starting the cockpit: /Users/ann/.cezar/versions/0.21.0/x.js (port 4322)',
  '2026-11-25T12:41:00.010Z --- cockpit process pid 90001',
  '2026-11-25T12:41:02.000Z output of the new process',
].join('\n');

describe('collectUncleanExits', () => {
  it('reports a cockpit whose process is gone, once, with facts and no output text or path', () => {
    put(marker());
    const [exit, ...rest] = collect(LOG);
    expect(rest).toEqual([]);
    expect(exit!.context).toMatchObject({
      'unclean.previous_version': '0.21.0',
      'unclean.previous_runtime': 'app',
      'unclean.uptime_s': 4170,
      'unclean.last_beat_age_s': 30,
      'unclean.rss_mb': 412,
      'unclean.runs_running': 3,
      'unclean.foreign_host': false,
      'unclean.last_output_at': '2026-11-25T12:37:20.000Z',
      'unclean.cockpit_log': true,
      'unclean.log_lifecycle': '2026-11-25T11:30:00.000Z --- starting the cockpit (port 4321)\n2026-11-25T11:30:00.010Z --- cockpit process pid 87001',
    });
    expect(JSON.stringify(exit!.context)).not.toMatch(/secret prompt|acme-corp|cezar is running|new process|90001|Users|x\.js/);
    expect(readdirSync(dir)).toEqual([]);
    expect(collect(LOG)).toEqual([]);
  });

  it('works without the cockpit log (a CLI launch)', () => {
    put(marker({ runtime: 'cli', runsRunning: undefined }));
    const [exit] = collect('');
    expect(exit!.context['unclean.cockpit_log']).toBe(false);
    expect(exit!.context).not.toHaveProperty('unclean.log_lifecycle');
    expect(exit!.context).not.toHaveProperty('unclean.runs_running');
  });

  it('does not report a desktop quit: the shell logs that it stopped the cockpit itself', () => {
    put(marker());
    const quit = `${LOG.split('\n').slice(0, 4).join('\n')}\n2026-11-25T12:39:00.000Z --- cockpit process pid 87001 stopped by the app`;
    expect(collect(quit)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not report a death the desktop shell saw and reported itself', () => {
    put(marker());
    const log = `${LOG.split('\n').slice(0, 4).join('\n')}\n2026-11-25T12:37:33.100Z --- cockpit process pid 87001 ended: signal: 9 (SIGKILL)`;
    expect(collect(log)).toEqual([]);
  });

  it('finds the ending even when the pid line is older than the tail', () => {
    put(marker());
    expect(collect('2026-11-25T12:30:00.000Z noise\n2026-11-25T12:37:33.100Z --- cockpit process pid 87001 ended: signal: 9 (SIGKILL)')).toEqual([]);
  });

  it('ignores cockpit output that merely contains a shell line', () => {
    put(marker());
    const echo = `${LOG}\n2026-11-25T12:42:00.000Z echo:  --- cockpit process pid 87001 ended: signal: 9`;
    const [exit] = collect(echo);
    expect(exit).toBeDefined();
    expect(String(exit!.context['unclean.log_lifecycle'])).not.toContain('echo');
  });

  it('does not lend one process the ending of another under the same pid', () => {
    const older = '2026-11-25T09:00:00.000Z --- starting the cockpit: /x.js (port 4321)\n' +
      '2026-11-25T09:00:00.010Z --- cockpit process pid 87001\n' +
      '2026-11-25T10:00:00.000Z --- cockpit process pid 87001 ended: exit status: 1\n';
    put(marker());
    const [exit] = collect(older + LOG);
    expect(exit).toBeDefined();
    expect(exit!.context['unclean.last_output_at']).toBe('2026-11-25T12:37:20.000Z');
    // …and a later process under that pid does not lend its ending to the earlier one.
    const later = `${LOG}\n2026-11-25T13:00:00.000Z --- cockpit process pid 87001\n2026-11-25T13:10:00.000Z --- cockpit process pid 87001 stopped by the app`;
    put(marker());
    expect(collect(later)).toHaveLength(1);
  });

  it('reports a marker left under its own pid by an earlier start (a restarted container)', () => {
    put(marker({ pid: process.pid, startedAt: NOW - 600_000 }));
    expect(collect('', { selfStartedAt: NOW - 1_000 })).toHaveLength(1);
    put(marker({ pid: process.pid, startedAt: NOW - 500 }));
    expect(collect('', { selfStartedAt: NOW - 1_000 })).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('judges another host’s marker by its beat, not by a pid it cannot probe', () => {
    const other = hostId('other-container');
    put(marker({ host: other, pid: 1, beatAt: NOW - 60_000 }));
    expect(collect('', { isAlive: () => false })).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
    put(marker({ host: other, pid: 1, beatAt: NOW - 11 * 60_000 }));
    const [exit] = collect('', { isAlive: () => true });
    expect(exit!.context['unclean.foreign_host']).toBe(true);
  });

  it('leaves a live cockpit alone', () => {
    put(marker());
    expect(collect('', { isAlive: () => true })).toEqual([]);
    expect(existsSync(join(dir, `87001-${HOST}.json`))).toBe(true);
  });

  it('drops a marker under a pid reused for a month without reporting it', () => {
    put(marker({ beatAt: NOW - 31 * 86_400_000 }));
    expect(collect('', { isAlive: () => true, hostUptimeS: 90 * 86_400 })).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('drops a marker from before the host restarted, even under a pid now alive', () => {
    put(marker({ beatAt: NOW - 2 * 86_400_000 }));
    expect(collect('', { isAlive: () => true })).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('skips a marker another cockpit claimed first', () => {
    put(marker());
    expect(collect('', { claim: () => { throw new Error('ENOENT'); } })).toEqual([]);
  });

  it('removes malformed markers and leftovers, reporting none', () => {
    writeFileSync(join(dir, `123-${HOST}.json`), '{"pid":');
    put(marker({ pid: 0 }));
    writeFileSync(join(dir, `5-${HOST}.json.tmp`), '{}');
    writeFileSync(join(dir, `6-${HOST}.json.claimed-99`), '{}');
    expect(collect()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('parseMarker', () => {
  const name = (m: LiveMarker) => `${m.pid}-${m.host}.json`;
  it('accepts only a well-formed marker under its own name', () => {
    const m = marker();
    expect(parseMarker(JSON.stringify(m), name(m))).toEqual(m);
    expect(parseMarker(JSON.stringify(m), `1-${HOST}.json`)).toBeUndefined();
    for (const bad of [{ pid: -1 }, { pid: 0 }, { pid: 1.5 }, { runtime: 'x'.repeat(40) }, { version: '../../etc' }, { reportVersion: '1.2.3-nightly.4' }]) {
      const m2 = marker(bad as Partial<LiveMarker>);
      expect(parseMarker(JSON.stringify(m2), name(m2)), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('logFacts', () => {
  it('normalises an exit status it does not recognise', () => {
    const log = '2026-11-25T12:00:00.000Z --- cockpit process pid 5\n2026-11-25T12:01:00.000Z --- cockpit process pid 5 ended: /Users/ann/secret';
    const facts = logFacts(log, { pid: 5, startedAt: Date.parse('2026-11-25T12:00:00.500Z') });
    expect(facts.seenByShell).toBe(true);
    expect(facts.lifecycle).toContain('ended: other');
    expect(facts.lifecycle).not.toContain('secret');
  });

  it('knows nothing about a pid the log never names', () => {
    expect(logFacts(LOG, { pid: 4242, startedAt: NOW })).toEqual({});
  });
});

describe('reportUncleanExits', () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports every dead cockpit found at one start, each under its own version', async () => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('CEZ_TELEMETRY', '1');
    vi.stubEnv('CEZ_HOME', mkdtempSync(join(tmpdir(), 'cez-unclean-')));
    await setTelemetryConsent('granted');
    put(marker({ pid: 87001, reportVersion: '0.20.0' }));
    put(marker({ pid: 87002, reportVersion: '0.21.0-nightly' }));
    expect(reportUncleanExits(collect())).toBe(2);
    await flushTelemetry();
    const bodies = fetchMock.mock.calls
      .map((call) => call as unknown as [string, RequestInit])
      .filter(([url]) => url.endsWith('/track/error'))
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies.map((b) => b.version).sort()).toEqual(['0.20.0', '0.21.0-nightly']);
    expect(bodies.every((b) => b.error.type === 'UncleanShutdown' && b.error.code === 'unclean_shutdown' && !b.error.stack)).toBe(true);
  });
});

it('an unclean shutdown is reported without a stack that would point at the reporter', () => {
  const err = uncleanShutdownError();
  expect(err.name).toBe('UncleanShutdown');
  expect(err.stack).toBeUndefined();
});

it('reads the end of the real cockpit log when none is passed', () => {
  const path = cockpitLogPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${'x'.repeat(70_000)}\n${LOG}\n`);
  try {
    put(marker());
    const [exit] = collectUncleanExits({ dir, now: NOW, hostUptimeS: 86_400, isAlive: dead, host: HOST, selfStartedAt: NOW });
    expect(exit!.context['unclean.last_output_at']).toBe('2026-11-25T12:37:20.000Z');
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

describe('startLiveMarker', () => {
  const opts = { version: '1.2.3', reportVersion: '1.2.3', runtime: 'cli', host: HOST };

  it('keeps a marker while running, rewrites it each beat, and removes it when stopped', async () => {
    const live = join(dir, 'live');
    const stop = startLiveMarker({ ...opts, runsRunning: () => 2, dir: live, beatMs: 20 });
    const file = join(live, `${process.pid}-${HOST}.json`);
    const first = JSON.parse(readFileSync(file, 'utf8')) as LiveMarker;
    expect(first).toMatchObject({ pid: process.pid, host: HOST, version: '1.2.3', runtime: 'cli', runsRunning: 2 });
    await vi.waitFor(() => {
      expect((JSON.parse(readFileSync(file, 'utf8')) as LiveMarker).beatAt).toBeGreaterThan(first.beatAt);
    });
    stop();
    expect(readdirSync(live)).toEqual([]);
  });

  // The whole point: a graceful exit removes the marker, a SIGKILL leaves it for the next boot.
  it.skipIf(process.platform === 'win32')('survives SIGKILL and not a clean exit', async () => {
    const live = join(dir, 'live');
    mkdirSync(live);
    const module = fileURLToPath(new URL('./unclean-exit.ts', import.meta.url));
    const script = `const { startLiveMarker } = await import(${JSON.stringify(module)});
      startLiveMarker({ version: 'x', reportVersion: 'unknown', runtime: 'cli', dir: ${JSON.stringify(live)} });
      console.log('ready'); if (process.argv[1] === 'exit') process.exit(0); setInterval(() => {}, 1000);`;
    const run = async (mode: 'exit' | 'kill') => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      await Promise.race([new Promise<void>((resolve) => child.stdout.once('data', () => resolve())), exited]);
      if (mode === 'kill') child.kill('SIGKILL');
      await exited;
      return child.pid!;
    };
    await run('exit');
    expect(readdirSync(live)).toEqual([]);
    const killed = await run('kill');
    expect(readdirSync(live)).toEqual([`${killed}-${hostId()}.json`]);
  }, 30_000);
});
