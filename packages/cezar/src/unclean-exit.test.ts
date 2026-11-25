import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cockpitLogPath, collectUncleanExits, logFacts, startLiveMarker, uncleanShutdownError, type LiveMarker } from './unclean-exit.ts';

const NOW = Date.parse('2026-11-25T12:40:00Z');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-live-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function marker(over: Partial<LiveMarker> = {}): LiveMarker {
  return { pid: 87001, startedAt: NOW - 3_600_000, beatAt: NOW - 30_000, version: '0.21.0', runtime: 'app', rssMb: 412, runsRunning: 3, ...over };
}
function put(m: LiveMarker): void {
  writeFileSync(join(dir, `${m.pid}.json`), JSON.stringify(m));
}
const dead = () => false;
const collect = (logTail = '', isAlive: (pid: number) => boolean = dead) =>
  collectUncleanExits({ dir, logTail, now: NOW, hostUptimeS: 86_400, isAlive });

/** The desktop shell's cockpit log (#2489) around a group SIGKILL that took the shell down too. */
const LOG = [
  '2026-11-25T11:30:00.000Z --- starting the cockpit: /Users/ann/.cezar/versions/0.21.0/x.js (port 4321)',
  '2026-11-25T11:30:00.010Z --- cockpit process pid 87001',
  '2026-11-25T11:30:01.000Z   cezar is running on http://127.0.0.1:4321',
  '2026-11-25T12:37:20.000Z [run] secret prompt text about acme-corp',
  '2026-11-25T12:41:00.000Z --- starting the cockpit: /Users/ann/.cezar/versions/0.21.0/x.js (port 4321)',
  '2026-11-25T12:41:00.010Z --- cockpit process pid 90001',
  '2026-11-25T12:41:02.000Z output of the new process',
].join('\n');

describe('collectUncleanExits', () => {
  it('reports a cockpit whose process is gone, once, with facts and no output text', () => {
    put(marker());
    const [exit, ...rest] = collect(LOG);
    expect(rest).toEqual([]);
    expect(exit!.context).toMatchObject({
      'unclean.previous_version': '0.21.0',
      'unclean.previous_runtime': 'app',
      'unclean.uptime_s': 3570,
      'unclean.last_beat_age_s': 30,
      'unclean.rss_mb': 412,
      'unclean.runs_running': 3,
      'unclean.last_output_at': '2026-11-25T12:37:20.000Z',
      'unclean.cockpit_log': true,
    });
    const lifecycle = String(exit!.context['unclean.log_lifecycle']);
    expect(lifecycle).toContain('--- cockpit process pid 87001');
    expect(JSON.stringify(exit!.context)).not.toMatch(/secret prompt|acme-corp|cezar is running|new process|90001/);
    expect(readdirSync(dir)).toEqual([]);
    expect(collect(LOG)).toEqual([]);
  });

  it('works without the cockpit log (#2489 not merged, or a CLI launch)', () => {
    put(marker({ runtime: 'cli', runsRunning: undefined }));
    const [exit] = collect('');
    expect(exit!.context['unclean.cockpit_log']).toBe(false);
    expect(exit!.context).not.toHaveProperty('unclean.log_lifecycle');
    expect(exit!.context).not.toHaveProperty('unclean.runs_running');
  });

  it('reads the end of the real cockpit log when none is passed', () => {
    const path = cockpitLogPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${'x'.repeat(70_000)}\n${LOG}\n`);
    try {
      put(marker());
      const [exit] = collectUncleanExits({ dir, now: NOW, hostUptimeS: 86_400, isAlive: dead });
      expect(exit!.context['unclean.last_output_at']).toBe('2026-11-25T12:37:20.000Z');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('leaves a live cockpit alone', () => {
    put(marker());
    expect(collect('', () => true)).toEqual([]);
    expect(existsSync(join(dir, '87001.json'))).toBe(true);
  });

  it('drops a marker under a pid reused for a month without reporting it', () => {
    put(marker({ beatAt: NOW - 31 * 86_400_000 }));
    expect(collect('', () => true)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not report a host that restarted since the last beat', () => {
    put(marker({ beatAt: NOW - 2 * 86_400_000 }));
    expect(collect()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not report a death the desktop shell saw and reported itself', () => {
    put(marker());
    const log = `${LOG.split('\n').slice(0, 4).join('\n')}\n2026-11-25T12:37:33.100Z --- cockpit process pid 87001 ended: signal: 9 (SIGKILL)`;
    expect(collect(log)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes a malformed marker without reporting it', () => {
    writeFileSync(join(dir, '123.json'), '{"pid":');
    expect(collect()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never claims its own marker', () => {
    put(marker({ pid: process.pid }));
    expect(collect()).toEqual([]);
    expect(readdirSync(dir)).toEqual([`${process.pid}.json`]);
  });
});

describe('logFacts', () => {
  it('reads the signal the shell recorded', () => {
    const log = '2026-11-25T12:00:00.000Z --- cockpit process pid 5\n2026-11-25T12:01:00.000Z --- cockpit process pid 5 ended: signal: 9 (SIGKILL)';
    expect(logFacts(log, 5)).toMatchObject({ endedBy: 'signal: 9 (SIGKILL)', signal: 9 });
  });

  it('never takes cockpit output that looks like a shell line for one', () => {
    const log = [
      '2026-11-25T12:00:00.000Z --- starting the cockpit: /opt/x.js (port 4321)',
      '2026-11-25T12:00:00.010Z --- cockpit process pid 5',
      '2026-11-25T12:00:01.000Z --- secret heading from a prompt',
      '2026-11-25T12:00:02.000Z [run] acme-corp --- notes',
    ].join('\n');
    const facts = logFacts(log, 5);
    expect(facts.lifecycle).toBe(log.split('\n').slice(0, 2).join('\n'));
    expect(facts.lastOutputAt).toBe('2026-11-25T12:00:02.000Z');
  });

  it('knows nothing about a pid the log never names', () => {
    expect(logFacts(LOG, 4242)).toEqual({});
  });
});

it('an unclean shutdown is reported without a stack that would point at the reporter', () => {
  const err = uncleanShutdownError();
  expect(err.name).toBe('UncleanShutdown');
  expect(err.stack).toBeUndefined();
});

describe('startLiveMarker', () => {
  it('keeps a marker while running and removes it when stopped', () => {
    const live = join(dir, 'live');
    const stop = startLiveMarker({ version: '1.2.3', runtime: 'cli', runsRunning: () => 2, dir: live });
    const written = JSON.parse(readFileSync(join(live, `${process.pid}.json`), 'utf8')) as LiveMarker;
    expect(written).toMatchObject({ pid: process.pid, version: '1.2.3', runtime: 'cli', runsRunning: 2 });
    stop();
    expect(readdirSync(live)).toEqual([]);
  });

  // The whole point: a graceful exit removes the marker, a SIGKILL leaves it for the next boot.
  it.skipIf(process.platform === 'win32')('survives SIGKILL and not a clean exit', async () => {
    const live = join(dir, 'live');
    mkdirSync(live);
    const module = fileURLToPath(new URL('./unclean-exit.ts', import.meta.url));
    const script = `const { startLiveMarker } = await import(${JSON.stringify(module)});
      startLiveMarker({ version: 'x', runtime: 'cli', dir: ${JSON.stringify(live)} });
      console.log('ready'); if (process.argv[1] === 'exit') process.exit(0); setInterval(() => {}, 1000);`;
    const run = async (mode: 'exit' | 'kill') => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      if (mode === 'kill') child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      return child.pid!;
    };
    await run('exit');
    expect(readdirSync(live)).toEqual([]);
    const killed = await run('kill');
    expect(readdirSync(live)).toEqual([`${killed}.json`]);
  }, 30_000);
});
