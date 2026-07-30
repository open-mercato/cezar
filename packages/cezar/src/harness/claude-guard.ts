import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const GUARD_SCRIPT = `#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
let input = {}
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
const command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : ''
const filePath = typeof input?.tool_input?.file_path === 'string' ? input.tool_input.file_path : ''
const worktree = realpathSync(process.env.CEZ_HARNESS_WORKTREE)
const outputDir = realpathSync(process.env.CEZ_HARNESS_OUTPUT_DIR)

const refuse = (message) => {
  process.stderr.write(\`[cez-harness] \${message}\\n\`)
  process.exit(2)
}
const canonicalTarget = (raw) => {
  const target = resolve(worktree, raw)
  let cursor = target
  const suffix = []
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(cursor.slice(parent.length + 1))
    cursor = parent
  }
  return resolve(realpathSync(cursor), ...suffix)
}
const outside = (root, target) => {
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith(\`..\${process.platform === 'win32' ? '\\\\' : '/'}\`) || isAbsolute(rel)
}
const outsideEveryWritableRoot = (target) =>
  outside(worktree, target) && outside(outputDir, target)

// Match the binary wherever a shell can spell it (plain, absolute, command
// substitution) and tolerate global options with separate values (for example,
// git -C . push and gh --repo owner/repo pr create). Do not cross a shell command
// boundary: a later, unrelated word must not turn an innocent command into a
// refusal.
const gitWrite =
  /(?:^|[^A-Za-z0-9_.-])git(?:\\.exe)?(?=$|[^A-Za-z0-9_.-])[^;&|()\\n]{0,1000}\\b(?:commit|push)\\b/i.test(command)
const ghWrite =
  /(?:^|[^A-Za-z0-9_.-])gh(?:\\.exe)?(?=$|[^A-Za-z0-9_.-])[^;&|()\\n]{0,1000}\\b(?:issue\\s+(?:close|comment|create|delete|develop|edit|lock|pin|reopen|transfer|unlock|unpin)|pr\\s+(?:checkout|close|comment|create|edit|lock|merge|ready|reopen|review|unlock))\\b/i.test(command)
if (command && (gitWrite || ghWrite)) {
  refuse('stage-only boundary: git ref and GitHub tracker writes are disabled')
}
if (filePath) {
  const target = canonicalTarget(filePath)
  if (outsideEveryWritableRoot(target)) {
    refuse(\`write outside the run worktree and phase-output directory is disabled: \${filePath}\`)
  }
}
`;

// Claude Code appends `pwd -P >| /tmp/claude-<id>-cwd` to Bash commands so it
// can track directory changes across tool calls. Anthropic's standalone macOS
// sandbox sees that bookkeeping write as part of the command: denying it turns
// an otherwise successful command into a failed tool call. Keep the exception
// to the exact flat-file shape Claude owns; never make all of /tmp writable.
const CLAUDE_CWD_MARKER_GLOB = '/private/tmp/claude-*-cwd';

function sandboxRuntimeCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@anthropic-ai/sandbox-runtime')), 'cli.js');
}

function macosSandboxWrapper(cliPath: string, settingsPath: string): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'

const command = process.argv[2]
if (typeof command !== 'string') {
  process.stderr.write('[cez-harness] sandbox wrapper received no command\\n')
  process.exit(2)
}
const child = spawn(process.execPath, [
  ${JSON.stringify(cliPath)},
  '--settings',
  ${JSON.stringify(settingsPath)},
  '-c',
  command,
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
  process.stderr.write(\`[cez-harness] could not start sandbox runtime: \${error.message}\\n\`)
  process.exit(2)
})
child.on('exit', (code, signal) => {
  if (code !== null) process.exit(code)
  process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)
})
`;
}

/** Create an invocation-scoped Claude settings file outside the model-writable
 * worktree and phase-output directory. It affects harness sessions only;
 * ordinary repository users never inherit Cezar's hooks.
 *
 * Claude Code 2.1.193 on macOS fails every command in its native sandbox with
 * E2BIG before even `pwd` reaches the shell. On macOS, run Bash through
 * Anthropic's standalone sandbox runtime via Claude's shell-prefix seam. Other
 * platforms retain Claude's native sandbox. Both variants enforce the same two
 * writable roots; the hook adds explicit git/PR and built-in Edit/Write guards. */
export function createClaudeStageOnlySettings(
  artifactDir: string,
  worktree: string,
  outputDir: string,
  platform: NodeJS.Platform = process.platform,
): {
  settingsPath: string;
  env: Record<string, string>;
  sandboxWrapperPath?: string;
} {
  const guardDir = join(artifactDir, 'claude-guard');
  mkdirSync(guardDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  const guardPath = join(guardDir, 'guard.mjs');
  const settingsPath = join(guardDir, 'settings.json');
  writeFileSync(guardPath, GUARD_SCRIPT, { encoding: 'utf8', mode: 0o700 });
  const hooks = {
    PreToolUse: [
      {
        matcher: 'Bash|Edit|Write',
        hooks: [{ type: 'command', command: `node ${JSON.stringify(guardPath)}` }],
      },
    ],
  };
  const useStandaloneSandbox = platform === 'darwin';
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      useStandaloneSandbox
        ? { hooks }
        : {
            sandbox: {
              enabled: true,
              failIfUnavailable: true,
              autoAllowBashIfSandboxed: true,
              allowUnsandboxedCommands: false,
              filesystem: {
                allowWrite: [outputDir],
              },
              network: {
                allowedDomains: ['github.com', 'api.github.com'],
              },
            },
            hooks,
          },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const env: Record<string, string> = {
    CEZ_HARNESS_CLAUDE_SETTINGS: settingsPath,
    CEZ_HARNESS_WORKTREE: worktree,
    CEZ_HARNESS_OUTPUT_DIR: outputDir,
  };
  let sandboxWrapperPath: string | undefined;
  if (useStandaloneSandbox) {
    const sandboxSettingsPath = join(guardDir, 'sandbox-runtime.json');
    sandboxWrapperPath = join(guardDir, 'sandbox-wrapper.mjs');
    writeFileSync(
      sandboxSettingsPath,
      `${JSON.stringify(
        {
          network: {
            allowedDomains: ['github.com', 'api.github.com'],
            deniedDomains: [],
          },
          filesystem: {
            denyRead: [],
            allowWrite: [worktree, outputDir, CLAUDE_CWD_MARKER_GLOB],
            denyWrite: [],
          },
          credentials: {
            envVars: [
              { name: 'ANTHROPIC_API_KEY', mode: 'deny' },
              { name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'deny' },
              { name: 'GITHUB_TOKEN', mode: 'deny' },
              { name: 'GH_TOKEN', mode: 'deny' },
              { name: 'GH_ENTERPRISE_TOKEN', mode: 'deny' },
            ],
          },
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    writeFileSync(
      sandboxWrapperPath,
      macosSandboxWrapper(sandboxRuntimeCliPath(), sandboxSettingsPath),
      { encoding: 'utf8', mode: 0o700 },
    );
    env.CLAUDE_CODE_SHELL_PREFIX = sandboxWrapperPath;
  }
  return {
    settingsPath,
    env,
    ...(sandboxWrapperPath ? { sandboxWrapperPath } : {}),
  };
}
