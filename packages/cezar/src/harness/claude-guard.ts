import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const GUARD_SCRIPT = `#!/usr/bin/env node
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
let input = {}
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
const toolName = typeof input?.tool_name === 'string' ? input.tool_name : ''
const command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : ''
const filePath = typeof input?.tool_input?.file_path === 'string' ? input.tool_input.file_path : ''
// Read, Grep and Glob run in-process, outside the Bash sandbox and its denyRead.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead'])
const readTool = READ_TOOLS.has(toolName)

const refuse = (message) => {
  process.stderr.write(\`[cez-harness] \${message}\\n\`)
  process.exit(2)
}
// MCP tools run outside the sandbox and this guard's path checks alike.
if (typeof input?.tool_name === 'string' && input.tool_name.startsWith('mcp__')) {
  refuse(\`\${input.tool_name} is not available in a stage-only harness phase\`)
}
let worktree
let outputDir
try {
  const worktreeInput = process.env.CEZ_HARNESS_WORKTREE
  const outputInput = process.env.CEZ_HARNESS_OUTPUT_DIR
  if (!worktreeInput || !outputInput) throw new Error('writable-root environment is incomplete')
  worktree = realpathSync.native(worktreeInput)
  outputDir = realpathSync.native(outputInput)
} catch (error) {
  refuse('guard initialization failed: ' + (error instanceof Error ? error.message : String(error)))
}
// lstat, not existsSync: a dangling symlink "did not exist", so its name was resolved back inside
// the worktree and the write went through it to any host path. Resolving it now throws, and the
// write is refused. The native realpath also restores the on-disk case.
const present = (path) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const canonicalTarget = (raw) => {
  const target = resolve(worktree, raw)
  let cursor = target
  const suffix = []
  while (!present(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(cursor.slice(parent.length + 1))
    cursor = parent
  }
  return resolve(realpathSync.native(cursor), ...suffix)
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
// \`gh api\` writes whenever it sends a body or a non-GET method.
const ghApiWrite =
  /(?:^|[^A-Za-z0-9_.-])gh(?:\\.exe)?(?=$|[^A-Za-z0-9_.-])[^;&|()\\n]{0,1000}\\bapi\\b[^;&|()\\n]{0,1000}(?:(?:-X|--method)[\\s=]*['"]?(?:POST|PUT|PATCH|DELETE)\\b|\\bmutation\\b|(?:^|\\s)(?:-[fF]|--field|--raw-field|--input)(?=[\\s=]|$))/i.test(command)
if (command && (gitWrite || ghWrite || ghApiWrite)) {
  refuse('stage-only boundary: git ref and GitHub tracker writes are disabled')
}
const contains = (root, target) => !outside(root, target)
if (readTool) {
  let denied = []
  try {
    denied = JSON.parse(process.env.CEZ_HARNESS_DENIED_READS || '[]').map((path) => canonicalTarget(path))
  } catch (error) {
    refuse('read guard initialization failed: ' + (error instanceof Error ? error.message : String(error)))
  }
  const raw = filePath || (typeof input?.tool_input?.path === 'string' ? input.tool_input.path : '') ||
    (typeof input?.tool_input?.notebook_path === 'string' ? input.tool_input.notebook_path : '') || '.'
  try {
    const target = canonicalTarget(raw)
    // A search rooted above a credential store reads it too.
    const searches = toolName === 'Grep' || toolName === 'Glob'
    if (denied.some((store) => contains(store, target) || (searches && contains(target, store)))) {
      refuse(\`reading host credential stores is disabled in a stage-only harness phase: \${raw}\`)
    }
  } catch (error) {
    refuse('read target could not be validated: ' + (error instanceof Error ? error.message : String(error)))
  }
  process.exit(0)
}
if (filePath) {
  try {
    const target = canonicalTarget(filePath)
    if (outsideEveryWritableRoot(target)) {
      refuse(\`write outside the run worktree and phase-output directory is disabled: \${filePath}\`)
    }
    // The worktree's .git is a pointer the host's git follows (git-pin.ts).
    // Case-folded where the filesystem usually is: \`.GIT\` is the pointer on APFS and NTFS.
    const rel = relative(worktree, target)
    const gitEntry = process.platform === 'darwin' || process.platform === 'win32' ? rel.toLowerCase() : rel
    if (gitEntry === '.git' || gitEntry.startsWith('.git/') || gitEntry.startsWith('.git\\\\')) {
      refuse(\`writes to the worktree's .git are disabled: \${filePath}\`)
    }
  } catch (error) {
    refuse('write target could not be validated: ' + (error instanceof Error ? error.message : String(error)))
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
/** Host credential stores sandboxed Bash must not read: a token there reaches GitHub without any
 * local ref moving. Agent auth is read by the agent process, outside the sandbox. */
export function stageOnlyDeniedReads(home: string = homedir()): string[] {
  return [
    '.ssh',
    '.config/gh',
    '.git-credentials',
    '.config/git/credentials',
    '.netrc',
    '.aws',
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.local/share/opencode/auth.json',
  ].map((path) => join(home, path));
}

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
  // Settings per output directory: each session's sandbox writes its own directory only, so one
  // reviewer cannot write another's result.
  const sessionDir = join(guardDir, 'sessions', createHash('sha256').update(outputDir).digest('hex').slice(0, 16));
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  const guardPath = join(guardDir, 'guard.mjs');
  const settingsPath = join(sessionDir, 'settings.json');
  writeFileSync(guardPath, GUARD_SCRIPT, { encoding: 'utf8', mode: 0o700 });
  const hooks = {
    PreToolUse: [
      {
        matcher: 'Bash|Edit|Write|Read|Grep|Glob|NotebookRead|mcp__.*',
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
                denyRead: stageOnlyDeniedReads(),
                // Host-side git follows the .git pointer, and the hook runs unsandboxed.
                denyWrite: [join(worktree, '.git'), guardDir],
              },
              // No egress: a stage-only phase has nothing to fetch.
              network: {
                allowedDomains: [],
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
    CEZ_HARNESS_DENIED_READS: JSON.stringify(stageOnlyDeniedReads()),
  };
  let sandboxWrapperPath: string | undefined;
  if (useStandaloneSandbox) {
    const sandboxSettingsPath = join(sessionDir, 'sandbox-runtime.json');
    sandboxWrapperPath = join(sessionDir, 'sandbox-wrapper.mjs');
    writeFileSync(
      sandboxSettingsPath,
      `${JSON.stringify(
        {
          network: {
            allowedDomains: [],
            deniedDomains: [],
          },
          filesystem: {
            denyRead: stageOnlyDeniedReads(),
            allowWrite: [worktree, outputDir, CLAUDE_CWD_MARKER_GLOB],
            // Host-side git follows the worktree's .git pointer (git-pin.ts), and the hook runs
            // unsandboxed.
            denyWrite: [join(worktree, '.git'), guardDir],
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
