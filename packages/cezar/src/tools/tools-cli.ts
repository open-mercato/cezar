import { parseArgs } from 'node:util';
import { emulatorStart, emulatorStop } from './android.ts';
import { simulatorBoot, simulatorShutdown } from './ios.ts';
import {
  ENABLE_HINT,
  TOOL_IDS,
  type ToolReport,
  applyToolsEnv,
  composeToolsEnv,
  ensureTools,
  statusAll,
} from './registry.ts';
import { type ToolEnv, type ToolId, type ToolsContext, defaultContext } from './runtime.ts';

/**
 * `cezar tools …` — provision and drive the toolchains a task needs to test mobile apps (spec
 * `.ai/specs/2026-10-21-tool-provisioning.md`). In-process: no cockpit needed, so an agent runs
 * `node "$CEZ_BIN" tools ensure flutter` exactly like `cez task`, and a person can run it by hand.
 * Progress goes to stderr; stdout is the answer (a table, JSON, or shell exports).
 */

const USAGE = `cezar tools — install and drive the toolchains a task needs (installs are opt-in: CEZ_TOOL_INSTALL=1)

  cezar tools list [--json]                 what is installed (alias: status)
  cezar tools ensure <id…> [--install] [--json] [--shell bash|powershell]
                                            detect; install what is missing when allowed; print env exports
  cezar tools env [--shell bash|powershell] [--json]
                                            the PATH/ANDROID_HOME/JAVA_HOME/FLUTTER_ROOT exports for installed tools
  cezar tools emulator start|stop [--port 5554] [--timeout <s>]   headless Android emulator "cezar"
  cezar tools simulator boot|shutdown [--device <name|udid>]      iOS Simulator (macOS + Xcode)

ids: ${TOOL_IDS.join(' · ')}
Tools install under ~/.cezar/tools (no sudo). Inside a task: node "$CEZ_BIN" tools ensure <id>`;

export interface ToolsCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

type Shell = 'bash' | 'powershell';

const bashPath = (p: string): string => p.replace(/^([A-Za-z]):[\\/]/, (_, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
const bashQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Shell lines that put `env` in effect; empty when there is nothing to add. */
export function formatExports(env: ToolEnv, shell: Shell, platform: NodeJS.Platform): string[] {
  const lines: string[] = [];
  if (shell === 'powershell') {
    if (env.path.length) lines.push(`$env:PATH = ${psQuote(env.path.join(';') + ';')} + $env:PATH`);
    for (const [k, v] of Object.entries(env.vars)) lines.push(`$env:${k} = ${psQuote(v)}`);
  } else {
    // Git Bash on Windows wants /c/... in PATH, not C:\... (the colon is the separator).
    const entries = platform === 'win32' ? env.path.map(bashPath) : env.path;
    if (entries.length) lines.push(`export PATH=${entries.map(bashQuote).join(':')}:"$PATH"`);
    for (const [k, v] of Object.entries(env.vars)) lines.push(`export ${k}=${bashQuote(v)}`);
  }
  return lines;
}

function pickShell(value: string | undefined, ctx: ToolsContext): Shell | undefined {
  if (value === 'bash' || value === 'powershell') return value;
  if (value !== undefined) return undefined;
  return ctx.platform === 'win32' && !ctx.env.SHELL && !ctx.env.MSYSTEM ? 'powershell' : 'bash';
}

function describe(report: ToolReport): string {
  const detail = [report.version, report.source && `(${report.source})`, report.path].filter(Boolean).join(' ');
  return `${report.id.padEnd(17)}${report.status.padEnd(12)}${detail}${report.message ? `${detail ? '  ' : ''}${report.message}` : ''}`;
}

const READY = new Set(['ready', 'installed']);

export async function runToolsCommand(
  args: string[],
  baseCtx: ToolsContext = defaultContext(),
  io: ToolsCliIo = { log: console.log, error: console.error },
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        install: { type: 'boolean' },
        shell: { type: 'string' },
        port: { type: 'string' },
        timeout: { type: 'string' },
        device: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    io.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (!command || values.help || command === 'help') {
    io.log(USAGE);
    return command || values.help ? 0 : 2;
  }
  const ctx: ToolsContext = { ...baseCtx, install: baseCtx.install || values.install === true, log: io.error };
  const shell = pickShell(values.shell, ctx);
  if (!shell) {
    io.error('--shell must be bash or powershell');
    return 2;
  }
  const json = values.json === true;
  const print = (value: unknown): void => io.log(JSON.stringify(value, null, 2));
  const childEnv = (): NodeJS.ProcessEnv => applyToolsEnv(ctx.env, composeToolsEnv(ctx), ctx.platform);

  switch (command) {
    case 'list':
    case 'status': {
      const tools = await statusAll(ctx);
      if (json) print({ install: ctx.install, tools });
      else {
        for (const report of tools) io.log(describe(report));
        io.log(ctx.install ? '\ninstalls: enabled' : `\ninstalls: disabled — ${ENABLE_HINT}`);
      }
      return 0;
    }
    case 'env': {
      const env = composeToolsEnv(ctx);
      if (json) print(env);
      else for (const line of formatExports(env, shell, ctx.platform)) io.log(line);
      return 0;
    }
    case 'ensure': {
      const unknown = rest.filter((id) => !TOOL_IDS.includes(id as ToolId));
      if (rest.length === 0 || unknown.length) {
        io.error(`${unknown.length ? `unknown tool: ${unknown.join(', ')}` : 'name at least one tool'} (ids: ${TOOL_IDS.join(', ')})`);
        return 2;
      }
      const tools = await ensureTools(ctx, rest as ToolId[]);
      const env = composeToolsEnv(ctx);
      if (json) print({ install: ctx.install, tools, env });
      else {
        for (const report of tools) io.log(describe(report));
        const lines = formatExports(env, shell, ctx.platform);
        if (lines.length) {
          io.log(`\n# environment for these tools — eval it, or run: tools env --shell ${shell}`);
          for (const line of lines) io.log(line);
        }
      }
      return tools.every((t) => READY.has(t.status)) ? 0 : 1;
    }
    case 'emulator': {
      const action = rest[0];
      if (action !== 'start' && action !== 'stop') {
        io.error('usage: cezar tools emulator start|stop');
        return 2;
      }
      try {
        if (action === 'stop') {
          const stopped = await emulatorStop(ctx, childEnv());
          json ? print({ stopped }) : io.log(stopped.length ? `stopped ${stopped.join(', ')}` : 'no emulator running');
          return 0;
        }
        const notReady = (await ensureTools(ctx, ['android-emulator'])).find((t) => !READY.has(t.status));
        if (notReady) {
          io.error(`${notReady.id} is not ready: ${notReady.message ?? notReady.status}`);
          return 1;
        }
        const timeout = values.timeout ? Number(values.timeout) * 1000 : undefined;
        const result = await emulatorStart(ctx, childEnv(), { port: values.port ? Number(values.port) : undefined, timeoutMs: timeout });
        json ? print(result) : io.log(`${result.serial} booted${result.reused ? ' (already running)' : ''} — e.g. flutter test integration_test -d ${result.serial}`);
        return 0;
      } catch (error) {
        io.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    case 'simulator': {
      const action = rest[0];
      if (action !== 'boot' && action !== 'shutdown') {
        io.error('usage: cezar tools simulator boot|shutdown');
        return 2;
      }
      try {
        if (action === 'shutdown') {
          await simulatorShutdown(ctx, childEnv());
          json ? print({ shutdown: true }) : io.log('simulators shut down');
          return 0;
        }
        const notReady = (await ensureTools(ctx, ['ios-simulator'])).find((t) => !READY.has(t.status));
        if (notReady) {
          io.error(`${notReady.id} is not ready: ${notReady.message ?? notReady.status}`);
          return 1;
        }
        const result = await simulatorBoot(ctx, childEnv(), { device: values.device });
        json ? print(result) : io.log(`${result.name} ${result.udid} booted${result.reused ? ' (already running)' : ''} — e.g. flutter test -d ${result.udid}`);
        return 0;
      } catch (error) {
        io.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    default:
      io.error(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}
