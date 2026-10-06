import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
// Dependency-free by design (no imports of its own), so the shim can share the exact redaction
// the run's event log uses (#427) without pulling anything else into the agent's process tree.
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { classifyGh, ghFileReferences } from './gh-policy.ts';
import {
  CAPTURE_MAX_FILES,
  LEDGER_VERSION,
  MAX_ARGV_TOKENS,
  MAX_ARG_CHARS,
  appendIntent,
  captureContent,
  newIntentId,
  readShadowConfig,
  withholdValues,
  type CapturedFile,
  type ShadowConfig,
} from './ledger.ts';

/**
 * The program behind a shadow run's `gh` and behind its shadow remotes' `pre-receive` hooks
 * (spec `2026-10-06-shadow-runs` § The shim).
 *
 *   node shim-main.js gh <shadowDir> <gh args...>
 *   node shim-main.js pre-receive <shadowDir> <remote name>     (stdin: "<old> <new> <ref>" lines)
 *
 * It runs INSIDE the agent's process tree, under a bare `node`, so it imports Node builtins and
 * its two siblings only. Everything it does is local: classify, record, pass a read through, or
 * refuse. It never talks to the cockpit, which may not be listening (a headless `cezar run`).
 *
 * Its output is written for the agent: one line that says what happened, that nothing left the
 * machine, and that retrying or working around it is pointless.
 */

export interface ShimIo {
  argv: readonly string[];
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Buffer;
  readFile(path: string): Buffer;
  /** Run the real gh with inherited stdio; its exit code. */
  runReal(bin: string, args: readonly string[]): number;
  /** Synchronous git with a scrubbed environment (see `nodeShimIo`). */
  git(cwd: string, args: readonly string[]): { ok: boolean };
  /** The secret values to redact before anything reaches the ledger. */
  secrets(): readonly string[];
  now(): Date;
}

const ZERO_SHA = /^0+$/;

export function runShim(io: ShimIo): number {
  const [mode, dir, ...rest] = io.argv;
  if (!mode || !dir) {
    io.stderr('cezar shadow: the shim was started without its arguments\n');
    return 2;
  }
  const config = readShadowConfig(dir);
  if (!config) {
    // Fail closed: without its state the shim cannot record anything, so it executes nothing.
    io.stderr('cezar shadow: this task runs in shadow mode but its shadow state is missing; nothing was executed\n');
    return 1;
  }
  if (mode === 'gh') return runGh(io, dir, config, rest);
  if (mode === 'pre-receive') return runPreReceive(io, dir, config, rest[0] ?? 'origin');
  io.stderr(`cezar shadow: unknown shim mode "${mode}"\n`);
  return 2;
}

function runGh(io: ShimIo, dir: string, config: ShadowConfig, args: readonly string[]): number {
  const verdict = classifyGh(args);
  if (verdict.effect === 'read') {
    if (!config.realGh) {
      io.stderr('gh: not installed on this machine (in shadow mode cezar passes read-only gh commands through to the real gh)\n');
      return 127;
    }
    return io.runReal(config.realGh, args);
  }
  const id = newIntentId(io.now());
  const at = io.now().toISOString();
  if (verdict.effect === 'deny') {
    appendIntent(dir, {
      v: LEDGER_VERSION,
      type: 'intent',
      id,
      at,
      kind: 'denied',
      tool: 'gh',
      argv: withholdValues(args),
      cwd: io.cwd,
      files: [],
    });
    io.stderr(
      `cezar shadow: refused "gh ${verdict.command}" (${verdict.reason}). This task runs in shadow mode; nothing was executed and nothing will be.\n`,
    );
    return 1;
  }
  // Cut to the bounds the server enforces, then redact: what reaches the ledger is never a line
  // the server would skip, and never a secret ("no secrets in state files", CODE_REVIEW.md).
  const capped = args.slice(0, MAX_ARGV_TOKENS).map((token) => token.slice(0, MAX_ARG_CHARS));
  const truncated = args.length > MAX_ARGV_TOKENS || args.some((token) => token.length > MAX_ARG_CHARS);
  const secrets = io.secrets();
  const argv = capped.map((token) => redactSecrets(token, secrets));
  const captured = captureFiles(io, args);
  const files = captured.map((file) => ({ ...file, content: redactSecrets(file.content, secrets) }));
  const redacted = argv.some((token, i) => token !== capped[i]) || files.some((file, i) => file.content !== captured[i]?.content);
  appendIntent(dir, {
    v: LEDGER_VERSION,
    type: 'intent',
    id,
    at,
    kind: 'forge',
    tool: 'gh',
    argv,
    cwd: io.cwd,
    files,
    ...(redacted ? { redacted: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  });
  const next = verdict.promotable === 'click'
    ? 'A human reviews it in the cockpit and can promote it.'
    : 'A human reviews it in the cockpit and runs it by hand if wanted.';
  io.stdout(
    `cezar shadow: recorded "gh ${verdict.command}" as intent ${id}. Nothing was sent to GitHub. ${next} Do not retry it or work around it; mention it in your final summary.\n`,
  );
  return 0;
}

/** Capture the files a write reads, so its intent outlives the agent's temp directory. */
function captureFiles(io: ShimIo, args: readonly string[]): CapturedFile[] {
  const refs = ghFileReferences(args).slice(0, CAPTURE_MAX_FILES);
  let stdinTaken = false;
  return refs.map((ref) => {
    const fromStdin = ref.value === '-';
    const read = fromStdin
      ? () => {
          if (stdinTaken) return Buffer.alloc(0);
          stdinTaken = true;
          return io.readStdin();
        }
      : () => io.readFile(ref.value);
    return { flag: ref.flag, index: ref.index, inline: ref.inline, ...captureContent(ref.value, read) };
  });
}

/**
 * A push reached a shadow remote. Record every ref update, pin each commit in the user's
 * repository so `git gc` cannot collect it before a human decides, then REJECT the push: a
 * rejected push leaves no remote-tracking ref behind, so the agent's `origin/<branch>` - and
 * through it the base every later task forks from (`resolveBaseRef`) - never claims a commit the
 * real remote does not have.
 */
function runPreReceive(io: ShimIo, dir: string, config: ShadowConfig, remote: string): number {
  const lines = io.readStdin().toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const [oldSha, newSha, ref] = line.split(' ');
    if (!oldSha || !newSha || !ref) continue;
    const id = newIntentId(io.now());
    const deleting = ZERO_SHA.test(newSha);
    const pinned = !deleting && io.git(config.repoRoot, ['update-ref', `refs/cezar/shadow/${config.runId}/${id}`, newSha]).ok;
    appendIntent(dir, {
      v: LEDGER_VERSION,
      type: 'intent',
      id,
      at: io.now().toISOString(),
      kind: 'push',
      remote,
      ref,
      sha: newSha,
      oldSha,
      pinned,
    });
    const what = deleting ? `the deletion of ${ref}` : `the push of ${ref} (${newSha.slice(0, 8)})`;
    io.stderr(
      `cezar shadow: recorded ${what} as intent ${id}. Nothing was sent to ${remote}. A human promotes it from the cockpit; do not retry, force or reroute this push.\n`,
    );
  }
  return 1;
}

/**
 * The real IO. `git` runs with every `GIT_*` variable removed: inside a `pre-receive` hook git sets
 * `GIT_DIR`, `GIT_QUARANTINE_PATH` and the object-directory variables for the SHADOW repository,
 * and a `git -C <repoRoot> update-ref` that inherited them would pin into the shadow repo instead
 * of the user's.
 */
export function nodeShimIo(argv: readonly string[]): ShimIo {
  return {
    argv,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: () => {
      try {
        return readFileSync(0);
      } catch {
        return Buffer.alloc(0);
      }
    },
    readFile: (path) => readFileSync(path),
    runReal: (bin, args) => {
      const result = spawnSync(bin, args, { stdio: 'inherit' });
      return result.status ?? 1;
    },
    git: (cwd, args) => {
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
      }
      const result = spawnSync('git', ['-C', cwd, ...args], { env, stdio: 'ignore', timeout: 30_000 });
      return { ok: result.status === 0 };
    },
    secrets: () => collectSecretValues(process.env),
    now: () => new Date(),
  };
}
