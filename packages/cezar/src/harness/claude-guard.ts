import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
const outside = (target) => {
  const rel = relative(worktree, target)
  return rel === '..' || rel.startsWith(\`..\${process.platform === 'win32' ? '\\\\' : '/'}\`) || isAbsolute(rel)
}

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
  if (outside(target)) refuse(\`write outside the run worktree is disabled: \${filePath}\`)
}
`;

/** Create an invocation-scoped Claude settings file outside the model-writable
 * worktree. It affects harness sessions only; ordinary repository users never
 * inherit Cezar's hooks. Native Claude sandboxing provides the Bash filesystem
 * boundary; the hook adds explicit git/PR and built-in Edit/Write guards. */
export function createClaudeStageOnlySettings(
  artifactDir: string,
  worktree: string,
): { settingsPath: string; env: Record<string, string> } {
  const guardDir = join(artifactDir, 'claude-guard');
  mkdirSync(guardDir, { recursive: true });
  const guardPath = join(guardDir, 'guard.mjs');
  const settingsPath = join(guardDir, 'settings.json');
  writeFileSync(guardPath, GUARD_SCRIPT, { encoding: 'utf8', mode: 0o700 });
  writeFileSync(
    settingsPath,
    `${JSON.stringify({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: {
          allowedDomains: ['github.com', 'api.github.com'],
        },
      },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|Edit|Write',
            hooks: [{ type: 'command', command: `node ${JSON.stringify(guardPath)}` }],
          },
        ],
      },
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return {
    settingsPath,
    env: {
      CEZ_HARNESS_CLAUDE_SETTINGS: settingsPath,
      CEZ_HARNESS_WORKTREE: worktree,
    },
  };
}
