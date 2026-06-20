import { spawn, type ChildProcess } from 'node:child_process';
import type { DevServerHandle, ProjectEnvSpec, RunEnv, ShellResult } from './run-env.js';
import { waitForHttp } from './run-env.js';

/**
 * Runs project commands directly on the host, inside the worktree. The trust
 * boundary is the same as a CI script — the worktree is a clone of the user's
 * own repo and the command list is configured by the workspace admin.
 */
export class NativeShellEnv implements RunEnv {
  readonly kind = 'native' as const;
  private devServer: { child: ChildProcess; handle: DevServerHandle } | null = null;

  constructor(
    private readonly worktreePath: string,
    private readonly spec: ProjectEnvSpec,
  ) {}

  install(onLine?: (line: string) => void): Promise<ShellResult | null> {
    return this.maybeRun(this.spec.install, onLine);
  }
  build(onLine?: (line: string) => void): Promise<ShellResult | null> {
    return this.maybeRun(this.spec.build, onLine);
  }
  test(onLine?: (line: string) => void): Promise<ShellResult | null> {
    return this.maybeRun(this.spec.test, onLine);
  }

  private maybeRun(command: string, onLine?: (line: string) => void): Promise<ShellResult | null> {
    const trimmed = command.trim();
    if (!trimmed) return Promise.resolve(null);
    return this.run(trimmed, onLine);
  }

  run(command: string, onLine?: (line: string) => void): Promise<ShellResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: this.worktreePath,
        shell: true,
        env: { ...process.env, ...this.spec.envVars },
      });
      let stdout = '';
      let stderr = '';
      const onChunk =
        (kind: 'out' | 'err') =>
        (chunk: Buffer): void => {
          const text = chunk.toString();
          if (kind === 'out') stdout += text;
          else stderr += text;
          if (onLine) {
            for (const line of text.split('\n')) {
              const trimmed = line.trimEnd();
              if (trimmed) onLine(trimmed);
            }
          }
        };
      child.stdout?.on('data', onChunk('out'));
      child.stderr?.on('data', onChunk('err'));
      child.on('error', (err) => {
        resolve({
          command,
          ok: false,
          exitCode: null,
          stdout,
          stderr: `${stderr}\n${err.message}`,
          durationMs: Date.now() - started,
        });
      });
      child.on('close', (code) => {
        resolve({
          command,
          ok: code === 0,
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - started,
        });
      });
    });
  }

  async startDevServer(onLine?: (line: string) => void): Promise<DevServerHandle | null> {
    if (this.devServer) return this.devServer.handle;
    const ds = this.spec.devServer;
    if (!ds.enabled || !ds.command.trim()) return null;
    if (!ds.port)
      throw new Error('projectEnv.devServer.port is required for the native dev server');

    // detached so we can signal the whole process group on stop (yarn → node → …).
    const child = spawn(ds.command, {
      cwd: this.worktreePath,
      shell: true,
      detached: true,
      env: { ...process.env, ...this.spec.envVars },
    });
    child.stdout?.on('data', (c: Buffer) => onLine?.(`[dev] ${c.toString().trimEnd()}`));
    child.stderr?.on('data', (c: Buffer) => onLine?.(`[dev] ${c.toString().trimEnd()}`));

    const url = `http://127.0.0.1:${ds.port}`;
    const status = await waitForHttp(`${url}${ds.readyPath}`, ds.readyTimeoutSec * 1000);

    const handle: DevServerHandle = {
      url,
      ready: status != null,
      stop: async () => {
        if (this.devServer?.child.pid && !this.devServer.child.killed) {
          try {
            process.kill(-this.devServer.child.pid, 'SIGTERM');
          } catch {
            /* group may be gone */
          }
        }
        this.devServer = null;
      },
    };
    this.devServer = { child, handle };
    return handle;
  }

  async dispose(): Promise<void> {
    await this.devServer?.handle.stop();
  }
}
