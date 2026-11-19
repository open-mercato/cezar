import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RelayKeepAwake } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * Keep this computer awake for your phone: while a phone is paired, a `caffeinate -i -w <pid>` holds
 * off IDLE system sleep (never display sleep), so a screen-locked Mac stays reachable through the
 * relay. `-w` ends it with this process, whatever way that goes. `CEZ_RELAY_KEEP_AWAKE=0` turns it off.
 */

/** The one child this needs: started, and killed. `onExit` fires once, also for a spawn error. */
export interface KeepAwakeChild {
  kill(): void;
  onExit(listener: (error?: Error) => void): void;
}
export type KeepAwakeSpawn = (pid: number) => KeepAwakeChild | null;

const spawnCaffeinate: KeepAwakeSpawn = (pid) => {
  // A test process never holds a power assertion on the developer's machine.
  if (process.env.VITEST) return null;
  const child = spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' });
  child.unref();
  child.on('error', () => {}); // ENOENT is reported through `onExit`; never an uncaught `error`.
  return {
    kill: () => { child.kill(); },
    onExit: (listener) => {
      let done = false;
      const once = (error?: Error) => { if (!done) { done = true; listener(error); } };
      child.once('error', (error) => once(error));
      child.once('exit', () => once());
    },
  };
};

export interface KeepAwakeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: KeepAwakeSpawn;
  onChange?(): void;
}

export class KeepAwake {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly spawn: KeepAwakeSpawn;
  private child: KeepAwakeChild | undefined;
  /** `caffeinate` was not there; looking again would fail the same way until a restart. */
  private missing = false;
  onChange: () => void;

  constructor(options: KeepAwakeOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.spawn = options.spawn ?? spawnCaffeinate;
    this.onChange = options.onChange ?? (() => {});
  }

  get unavailable(): RelayKeepAwake['unavailable'] {
    if (this.env.CEZ_RELAY_KEEP_AWAKE === '0') return 'switched-off';
    if (this.env.CEZ_DRY_RUN === '1') return 'dry-run';
    if (this.platform !== 'darwin') return 'not-macos';
    return this.missing ? 'missing' : undefined;
  }

  get active(): boolean {
    return this.child !== undefined;
  }

  /** Holds the assertion while `want`, releases it otherwise. Idempotent; never throws. */
  update(want: boolean): void {
    if (!want || this.unavailable) {
      this.release();
      return;
    }
    if (this.child) return;
    let child: KeepAwakeChild | null;
    try {
      child = this.spawn(this.pid);
    } catch {
      child = null;
    }
    if (!child) {
      this.missing = true;
      return;
    }
    this.child = child;
    child.onExit((error) => {
      if (this.child !== child) return;
      this.child = undefined;
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') this.missing = true;
      this.onChange();
    });
  }

  release(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}

const preferenceSchema = z.looseObject({ keepAwake: z.boolean().optional().catch(undefined) });

/** `~/.cezar/relay/settings.json`: the user's choices for the relay. Absent means every default. */
export class RelayPreferences {
  private readonly path: string;
  private state: z.infer<typeof preferenceSchema> | undefined;

  constructor(directory: string) {
    this.path = join(directory, 'settings.json');
  }

  private read(): z.infer<typeof preferenceSchema> {
    if (this.state) return this.state;
    let parsed: z.infer<typeof preferenceSchema> = {};
    try {
      const result = preferenceSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (result.success) parsed = result.data;
    } catch {
      // Missing or corrupt: the defaults.
    }
    this.state = parsed;
    return parsed;
  }

  /** On unless the user switched it off. */
  get keepAwake(): boolean {
    return this.read().keepAwake !== false;
  }

  setKeepAwake(enabled: boolean): void {
    const next = { ...this.read(), keepAwake: enabled };
    atomicWriteJsonSync(this.path, { version: 1, ...next });
    this.state = next;
  }
}
