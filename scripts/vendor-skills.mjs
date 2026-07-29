#!/usr/bin/env node
// Vendors the harness skill set from an open-mercato/skills checkout into
// vendor/skills/ under cezar-unique cez-* names (spec
// .ai/specs/2026-07-24-vendored-cez-skills.md). The rename is a uniform
// token map applied to every text file so the runtime's self-references —
// sibling dir resolution in harness.mjs, contract-name checks, schema
// constants — stay consistent. Uppercase env names (OM_HARNESS_*,
// OM_AGENT_HARNESS_CONFIG) and non-vendored skill names (om-fix-issue,
// om-auto-*) are untouched by construction: the map is lowercase and each
// token is matched with a (?![a-z0-9-]) lookahead.
//
// Mirrored skills are generated — never edit those by hand; rerun this script:
//   node scripts/vendor-skills.mjs --source <skills-checkout> [--ref <sha>]
// The exception is CEZAR_OWNED (below): skills cezar authors itself, preserved
// verbatim across regeneration. Edit those directly.
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The vendored tree lives INSIDE the cezar package (2026-07-27, after the
// packages/* split): `bundledSkillsDir()` resolves `<package>/vendor/skills`
// from `packages/cezar/src` in dev and from `dist/` in the tarball alike, so
// the generator has to write where that resolution looks.
const CEZAR_PKG = join(ROOT, 'packages', 'cezar');
const DEST = join(CEZAR_PKG, 'vendor', 'skills');
const HOLD = join(CEZAR_PKG, 'vendor', '.skills-hold');
const NAME_MAP = [
  ['om-setup-agent-harness', 'cez-setup-harness'],
  ['om-setup-agent-pipeline', 'cez-setup-pipeline'],
  ['om-harness-review', 'cez-harness-review'],
  ['om-verify-in-repo', 'cez-verify-in-repo'],
  ['om-spec-writing', 'cez-spec-writing'],
  ['om-code-review', 'cez-code-review'],
  ['om-root-cause', 'cez-root-cause'],
  ['om-harness', 'cez-harness'],
  ['om-fix', 'cez-fix'],
];
const REQUIRES = {
  'cez-setup-harness': ['cez-harness'],
  'cez-harness': ['cez-code-review'],
};

// Skills cezar AUTHORS rather than mirrors (2026-07-25). cezar and
// open-mercato/skills are separate implementations that share an approach, not
// code: where cezar's product shape diverges, cezar's copy is canonical and
// upstream has no say. `cez-setup-harness` is the first — the om version opens
// by routing the user through `om-setup-agent-pipeline` (tracker descriptor,
// labels, base branch) before they may bind a model, which is exactly right for
// the om PR pipeline and exactly wrong for cezar, where a Multi-model run needs
// none of it.
//
// These directories are preserved verbatim across regeneration: the script
// restores them after the wipe, and never copies over them from upstream.
const CEZAR_OWNED = new Set(['cez-setup-harness']);
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.sh', '.yaml', '.yml', '.txt']);

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const source = get('--source');
if (!source) {
  console.error('usage: vendor-skills.mjs --source <skills-checkout> [--ref <sha>]');
  process.exit(2);
}
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const expected = get('--ref');
if (expected && !commit.startsWith(expected)) {
  console.error(`checkout is at ${commit}, expected ${expected}`);
  process.exit(1);
}
const ref = execFileSync('git', ['-C', source, 'rev-parse', '--abbrev-ref', 'HEAD'], {
  encoding: 'utf8',
}).trim();

const rename = (text) =>
  NAME_MAP.reduce((out, [from, to]) => out.replace(new RegExp(`${from}(?![a-z0-9-])`, 'g'), to), text);

const injectRequires = (skillMd, names) => {
  const close = skillMd.indexOf('\n---', 4);
  if (close === -1) throw new Error('SKILL.md has no frontmatter to inject requires into');
  return `${skillMd.slice(0, close)}\nrequires: [${names.join(', ')}]${skillMd.slice(close)}`;
};

const replaceRequired = (text, before, after, label) => {
  if (!text.includes(before)) throw new Error(`cannot apply cezar harness patch (${label}): upstream anchor changed`);
  return text.replace(before, after);
};

const patchCezarHarnessFile = (skill, relativePath, input) => {
  if (skill !== 'cez-harness') return input;
  if (relativePath === 'hooks/freeze-tests.sh') {
    return replaceRequired(
      input,
      "grep -qE '(\\.spec\\.|\\.test\\.|/__tests__/|/__integration__/)'",
      "grep -qE '(\\.spec\\.|\\.test\\.|/__tests__/|/__integration__/|/(test|tests|spec)/|/(test_[^/]+|[^/]+_test)\\.[^/]+$)'",
      'language-agnostic test freeze',
    );
  }
  if (relativePath === 'references/stage-only-contract.md') {
    return replaceRequired(
      input,
      `   - current \`HEAD\`, refs, and reflogs equal the captured starting state;
   - the staged diff is non-empty;
   - the staged diff passes whitespace/error checking;
   - no non-ignored unstaged or untracked files remain;
   - every staged path came from the allowlist.`,
      `   - current \`HEAD\`, refs, and reflogs equal the captured starting state;
   - the staged diff is non-empty;
   - every staged path came from the allowlist.
   Whitespace findings in the staged diff and non-ignored unstaged or
   untracked leftovers are reported as WARNINGS on the stage result, never as
   refusals: the staged handoff feeds a human gate, and that gate judges
   cosmetic and completeness questions better than a fatal last-step check
   that hands it nothing.`,
      'advisory stage findings contract wording',
    );
  }
  if (relativePath !== 'scripts/harness.mjs') return input;
  let text = replaceRequired(
    input,
    'const LEDGER_OUTPUT_LIMIT = 20000',
    'const LEDGER_OUTPUT_LIMIT = 20000\nconst MODEL_OUTPUT_LIMIT = 2_000_000',
    'model output cap constant',
  );
  text = replaceRequired(
    text,
    `function extractJson(text) {
  const trimmed = text.trim()
  try { return JSON.parse(trimmed) } catch {}
  for (let start = trimmed.indexOf('{'); start >= 0; start = trimmed.indexOf('{', start + 1)) {
    for (let end = trimmed.lastIndexOf('}'); end > start; end = trimmed.lastIndexOf('}', end - 1)) {
      try { return JSON.parse(trimmed.slice(start, end + 1)) } catch {}
    }
  }
  throw new Error('No valid JSON object in model output')
}`,
    `function extractJson(text) {
  const trimmed = text.trim()
  if (trimmed.length > MODEL_OUTPUT_LIMIT) throw new Error(\`Model output exceeds \${MODEL_OUTPUT_LIMIT} bytes\`)
  try { return JSON.parse(trimmed) } catch {}
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char !== '}' || depth === 0) continue
    depth -= 1
    if (depth !== 0 || start < 0) continue
    try { return JSON.parse(trimmed.slice(start, index + 1)) } catch {}
    start = -1
  }
  throw new Error('No valid JSON object in model output')
}`,
    'linear bounded JSON extraction',
  );
  text = replaceRequired(
    text,
    `    let stderr = ''
    let timedOut = false
    let settled = false`,
    `    let stderr = ''
    let outputOverflow = false
    let timedOut = false
    let settled = false`,
    'model output overflow state',
  );
  text = replaceRequired(
    text,
    `    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })`,
    `    const collect = (target, chunk) => {
      const current = target === 'stdout' ? stdout : stderr
      const incoming = chunk.toString()
      const remaining = MODEL_OUTPUT_LIMIT - current.length
      if (remaining <= 0 || incoming.length > remaining) outputOverflow = true
      const next = current + incoming.slice(0, Math.max(0, remaining))
      if (target === 'stdout') stdout = next
      else stderr = next
    }
    child.stdout.on('data', (chunk) => collect('stdout', chunk))
    child.stderr.on('data', (chunk) => collect('stderr', chunk))`,
    'bounded model output collection',
  );
  text = replaceRequired(
    text,
    `      resolvePromise({ code, stdout, stderr, error: null, timedOut, durationMs: Date.now() - started })`,
    `      resolvePromise({
        code,
        stdout,
        stderr,
        error: outputOverflow ? new Error(\`Model output exceeds \${MODEL_OUTPUT_LIMIT} bytes\`) : null,
        timedOut,
        durationMs: Date.now() - started
      })`,
    'model output overflow result',
  );
  text = replaceRequired(
    text,
    `function sanitizedCliEnvironment(additions) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !SECRET_ENV_PATTERN.test(key))), ...additions }
}`,
    `const SAFE_CLI_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR',
  'FORCE_COLOR', 'CI', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'HTTP_PROXY', 'HTTPS_PROXY',
  'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'SSL_CERT_DIR'
])

function sanitizedCliEnvironment(additions, trustedNames = []) {
  const names = new Set([...SAFE_CLI_ENV_NAMES, ...trustedNames])
  return {
    ...Object.fromEntries(
      [...names]
        .filter((key) => /^[A-Z_][A-Z0-9_]*$/.test(key) && process.env[key] !== undefined)
        .map((key) => [key, process.env[key]])
    ),
    ...additions
  }
}`,
    'explicit subprocess environment allowlist',
  );
  text = replaceRequired(
    text,
    `import { createHash } from 'node:crypto'`,
    `import { createHash, randomUUID } from 'node:crypto'`,
    'atomic packet ledger nonce',
  );
  text = replaceRequired(
    text,
    `function savePacketLedger(ledgerPath, ledger) {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  writeFileSync(ledgerPath, \`\${JSON.stringify(ledger, null, 2)}\\n\`)
}`,
    `function savePacketLedger(ledgerPath, ledger) {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  const temp = \`\${ledgerPath}.\${process.pid}.\${randomUUID()}.tmp\`
  writeFileSync(temp, \`\${JSON.stringify(ledger, null, 2)}\\n\`)
  renameSync(temp, ledgerPath)
}`,
    'atomic packet ledger write',
  );
  text = replaceRequired(
    text,
    `async function runCommandReviewer(id, model, prompt, worktree, timeoutMs = null) {
  const before = captureGitState(worktree)
  const { result, provenance } = await runCommandAdapter(model, 'review', { worktree, prompt, timeoutMs: timeoutMs ?? undefined })
  const after = captureGitState(worktree)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return { status: 'failed', durationMs: result.durationMs, error: 'reviewer changed Git refs or reflogs; reviewer commands must be read-only' }
  }`,
    `function captureReviewerMutationState(worktree) {
  return {
    git: captureGitState(worktree),
    cached: git(['diff', '--cached', '--binary', '--no-ext-diff', '--full-index', '--'], worktree),
    unstaged: git(['diff', '--binary', '--no-ext-diff', '--full-index', '--'], worktree),
    untracked: git(['ls-files', '--others', '--exclude-standard'], worktree).split(/\\r?\\n/).filter(Boolean).sort()
      .map((path) => {
        const absolute = resolve(worktree, path)
        const stat = lstatSync(absolute)
        if (stat.isSymbolicLink()) return [path, sha256(\`symlink:\${readlinkSync(absolute)}\`)]
        if (stat.isFile()) {
          return [path, stat.size <= MODEL_OUTPUT_LIMIT
            ? sha256(readFileSync(absolute))
            : git(['hash-object', '--no-filters', '--', path], worktree).trim()]
        }
        return [path, sha256(\`mode:\${stat.mode}\`)]
      })
  }
}

async function runCommandReviewer(id, model, prompt, worktree, timeoutMs = null) {
  const before = captureReviewerMutationState(worktree)
  const { result, provenance } = await runCommandAdapter(model, 'review', { worktree, prompt, timeoutMs: timeoutMs ?? undefined })
  const after = captureReviewerMutationState(worktree)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return { status: 'failed', durationMs: result.durationMs, error: 'reviewer changed the worktree, index, refs, or reflogs; reviewer commands must be read-only' }
  }`,
    'reviewer full mutation capture',
  );
  text = replaceRequired(
    text,
    `function workerEnvironment(additions) {
  return sanitizedCliEnvironment({`,
    `function workerEnvironment(additions, trustedNames = []) {
  return sanitizedCliEnvironment({`,
    'worker trusted environment signature',
  );
  text = replaceRequired(
    text,
    `    ...additions
  })
}

function runProcess`,
    `    ...additions
  }, trustedNames)
}

function runProcess`,
    'worker trusted environment forwarding',
  );
  text = replaceRequired(
    text,
    `      env: env === 'worker' ? workerEnvironment(additions) : sanitizedCliEnvironment(additions),`,
    `      env: env === 'worker'
        ? workerEnvironment(additions, [model.credentialEnv, model.binaryEnv].filter(Boolean))
        : sanitizedCliEnvironment(additions, [model.credentialEnv, model.binaryEnv].filter(Boolean)),`,
    'trusted command credential environment',
  );
  text = replaceRequired(
    text,
    `  const allow = new Set(paths)
  const unexpected = stagedPaths.filter((entry) => !allow.has(entry))`,
    `  const allowed = (entry) => paths.some((scope) => entry === scope || entry.startsWith(\`\${scope}/\`))
  const unexpected = stagedPaths.filter((entry) => !allowed(entry))`,
    'directory-aware final stage allowlist',
  );
  text = replaceRequired(
    text,
    `function captureGitState(worktree) {
  return {
    head: git(['rev-parse', 'HEAD'], worktree).trim(),
    refs: git(['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/tags', 'refs/stash'], worktree).trim().split(/\\r?\\n/).filter(Boolean).sort(),
    reflogs: git(['reflog', 'show', '--all', '--format=%H%x09%gD'], worktree).trim().split(/\\r?\\n/).filter(Boolean)
      .filter((line) => !(line.split('\\t')[1] || '').startsWith('refs/remotes/')).sort()
  }
}
`,
    `/** Bumped whenever the snapshot's shape or scope changes, so a \`stage\` can tell
 *  a start-state it can compare field-by-field from one it can only trust for
 *  \`head\`. */
const GIT_STATE_VERSION = 2

function refLines(worktree, ref) {
  return git(['for-each-ref', '--format=%(refname)%09%(objectname)', ref], worktree).trim().split(/\\r?\\n/).filter(Boolean)
}

function reflogLines(worktree, ref) {
  let out = ''
  try {
    out = git(['reflog', 'show', '--format=%H%x09%gs', ref], worktree)
  } catch {
    return [] // no reflog for this ref (or reflogs disabled) — same on both sides
  }
  return out.trim().split(/\\r?\\n/).filter(Boolean)
}

function captureGitState(worktree) {
  const branch = git(['branch', '--show-current'], worktree).trim()
  const branchRef = branch ? \`refs/heads/\${branch}\` : null
  return {
    version: GIT_STATE_VERSION,
    head: git(['rev-parse', 'HEAD'], worktree).trim(),
    branch,
    refs: branchRef ? refLines(worktree, branchRef) : [],
    reflogs: {
      HEAD: reflogLines(worktree, 'HEAD'),
      ...(branchRef ? { [branchRef]: reflogLines(worktree, branchRef) } : {})
    }
  }
}

function gitStateDrift(startState, currentState) {
  const drift = []
  if (startState.head !== currentState.head) {
    drift.push(\`HEAD moved \${String(startState.head).slice(0, 12)} → \${String(currentState.head).slice(0, 12)} — this run created or reset a commit\`)
  }
  if (Number(startState.version) !== GIT_STATE_VERSION) return drift
  if (startState.branch !== currentState.branch) {
    drift.push(\`checked-out branch changed \${startState.branch || '(detached)'} → \${currentState.branch || '(detached)'}\`)
  }
  const startRefs = new Set(startState.refs || [])
  const currentRefs = new Set(currentState.refs || [])
  for (const line of currentRefs) if (!startRefs.has(line)) drift.push(\`ref now at \${line.replace('\\t', ' → ')}\`)
  for (const line of startRefs) if (!currentRefs.has(line)) drift.push(\`ref no longer at \${line.replace('\\t', ' → ')}\`)
  const startLogs = startState.reflogs || {}
  for (const [ref, current] of Object.entries(currentState.reflogs || {})) {
    const before = Array.isArray(startLogs[ref]) ? startLogs[ref] : []
    const addedCount = current.length - before.length
    if (addedCount <= 0) continue
    const tail = current.slice(addedCount)
    if (tail.join('\\n') !== before.join('\\n')) {
      drift.push(\`\${ref} reflog was rewritten during the run\`)
      continue
    }
    for (const entry of current.slice(0, Math.min(addedCount, 5))) {
      drift.push(\`\${ref} reflog entry added: \${entry.split('\\t').slice(1).join(' ')}\`)
    }
    if (addedCount > 5) drift.push(\`…and \${addedCount - 5} more \${ref} reflog entries\`)
  }
  return drift
}
`,
    "worktree-scoped git state snapshot",
  );
  text = replaceRequired(
    text,
    "  if (JSON.stringify(currentState) !== JSON.stringify(startState)) throw new Error('Git refs or reflogs changed during staged-only run')",
    `  const drift = gitStateDrift(startState, currentState)
  if (drift.length) throw new Error(\`Git refs or reflogs changed during staged-only run:\\n- \${drift.join('\\n- ')}\`)`,
    "diagnostic stage drift message",
  );
  text = replaceRequired(
    text,
    "function validateStagePath(worktree, entry) {",
    `/**
 * The same check \`stage\` makes, cheap and on demand, so a caller can run it
 * between phases instead of discovering at handoff that hour one invalidated
 * hours two through six. Exits 2 on drift; the drift list is the whole point of
 * the output.
 */
function commandVerify(args) {
  const worktree = resolve(String(args.worktree || process.cwd()))
  if (!args['start-state'] || args['start-state'] === true) throw new Error('--start-state <path> is required')
  const startState = readJson(resolve(String(args['start-state'])))
  const drift = gitStateDrift(startState, captureGitState(worktree))
  const result = { status: drift.length ? 'drifted' : 'clean', worktree, drift }
  if (args.output && args.output !== true) {
    const output = resolve(String(args.output))
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, \`\${JSON.stringify(result, null, 2)}\\n\`)
  }
  process.stdout.write(\`\${JSON.stringify(result, null, 2)}\\n\`)
  if (drift.length) process.exitCode = 2
}

function validateStagePath(worktree, entry) {`,
    "standalone verify command",
  );
  text = replaceRequired(
    text,
    "    if (command === 'stage') return commandStage(args)",
    `    if (command === 'verify') return commandVerify(args)
    if (command === 'stage') return commandStage(args)`,
    "verify command dispatch",
  );
  text = replaceRequired(
    text,
    "capture|worker|prepare-review",
    "capture|verify|worker|prepare-review",
    "verify command usage line",
  );
  text = replaceRequired(
    text,
    `async function runReviewer(id, model, criteria, subject, worktree, workerFamilies, maxInputBytes, lens = null, reviewContract = null, retry = null) {
  const built = buildReviewerPrompts(model, criteria, subject, maxInputBytes, lens)
  const envelope = {
    id,
    family: model.family,
    requestedModel: model.model,
    role: 'reviewer',
    lens,
    selfCheck: workerFamilies.includes(model.family),
    policyEligible: true,
    freshContext: true,
    reviewContract: reviewContract || { name: 'cez-code-review', version: CODE_REVIEW_CONTRACT_VERSION, rubricSha256: codeReviewRubric().sha256, subjectSha256: sha256(subject) },
    parts: built.prompts.length
  }`,
    `/** Safe, recognizable filename component for a model id like \`opencode/deepseek/v4\`. */
function fileToken(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'reviewer'
}

async function runReviewer(id, model, criteria, subject, worktree, workerFamilies, maxInputBytes, lens = null, reviewContract = null, retry = null, promptDir = null) {
  const built = buildReviewerPrompts(model, criteria, subject, maxInputBytes, lens)
  const envelope = {
    id,
    family: model.family,
    requestedModel: model.model,
    role: 'reviewer',
    lens,
    selfCheck: workerFamilies.includes(model.family),
    policyEligible: true,
    freshContext: true,
    reviewContract: reviewContract || { name: 'cez-code-review', version: CODE_REVIEW_CONTRACT_VERSION, rubricSha256: codeReviewRubric().sha256, subjectSha256: sha256(subject) },
    parts: built.prompts.length
  }
  if (promptDir) {
    try {
      mkdirSync(promptDir, { recursive: true })
      const promptPath = join(promptDir, \`reviewer-prompt-\${fileToken(id)}.txt\`)
      writeFileSync(promptPath, built.prompts.length === 1
        ? built.prompts[0]
        : built.prompts.map((prompt, index) => \`=== part \${index + 1} of \${built.prompts.length} ===\\n\${prompt}\`).join('\\n\\n'))
      envelope.promptPath = promptPath
    } catch {
    }
  }`,
    "reviewer prompt transcript capture",
  );
  text = replaceRequired(
    text,
    `  const providerReviewers = await pool(profile.reviewers, profile.maxParallel, (id) => runReviewer(id, config.agentHarness.models[id], criteria, subject, worktree, profile.workerFamilies, profile.maxInputBytes, null, reviewContract, profile.retry))`,
    `  const promptDir = args['prompt-dir'] && args['prompt-dir'] !== true ? resolve(String(args['prompt-dir'])) : null
  const providerReviewers = await pool(profile.reviewers, profile.maxParallel, (id) => runReviewer(id, config.agentHarness.models[id], criteria, subject, worktree, profile.workerFamilies, profile.maxInputBytes, null, reviewContract, profile.retry, promptDir))`,
    "reviewer prompt-dir plumbing",
  );
  // --- advisory stage findings (cezar) ----------------------------------------
  // Whitespace nits and out-of-handoff leftovers refuse nothing anymore (run
  // aad28178: two green hours refused over trailing whitespace in a spec .md).
  // They become warnings on the stage result; the human gate judges them.
  text = replaceRequired(
    text,
    `  git(['add', '--', ...paths.map((path) => \`:(literal)\${path}\`)], worktree)
  const staged = git(['diff', '--cached', '--name-status'], worktree).trim()
  if (!staged) throw new Error('Staged diff is empty')
  git(['diff', '--cached', '--check'], worktree)
  const stagedPaths = git(['diff', '--cached', '--name-only'], worktree).trim().split(/\\r?\\n/).filter(Boolean)
  const allowed = (entry) => paths.some((scope) => entry === scope || entry.startsWith(\`\${scope}/\`))
  const unexpected = stagedPaths.filter((entry) => !allowed(entry))
  if (unexpected.length) throw new Error(\`Staged paths outside allowlist: \${unexpected.join(', ')}\`)
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], worktree).split(/\\r?\\n/).filter(Boolean)
  const residual = status.filter((line) => {
    const index = line.slice(0, 2)
    return index === '??' || index[1] !== ' '
  })
  if (residual.length) throw new Error(\`Unstaged or untracked files remain:\\n\${residual.join('\\n')}\`)
  const result = { status: 'ready', startHead, currentHead, branch: git(['branch', '--show-current'], worktree).trim(), worktree, stagedPaths }`,
    `  // The allowlist is a UNION across every implement/fix round, so it can name
  const tracked = new Set(git(['ls-files', '-z', '--'], worktree).toString().split('\\0').filter(Boolean))
  const ghosts = paths.filter((path) => !existsSync(join(worktree, path)) && !tracked.has(path))
  const addable = paths.filter((path) => !ghosts.includes(path))
  if (!addable.length) throw new Error('Stage allowlist is empty after dropping entries that no longer exist')
  try {
    git(['add', '--', ...addable.map((path) => \`:(literal)\${path}\`)], worktree)
  } catch (error) {
    if (!/index\\.lock|unable to create/i.test(String(error.message || ''))) throw error
    git(['add', '--', ...addable.map((path) => \`:(literal)\${path}\`)], worktree)
  }
  const staged = git(['diff', '--cached', '--name-status'], worktree).trim()
  if (!staged) throw new Error('Staged diff is empty')
  // Cosmetic and completeness findings are WARNINGS, not refusals (run
  // aad28178, 2026-07-28): a two-hour run — councils passed, three fix rounds,
  // full validation green — was refused at handoff over trailing whitespace in
  // a spec markdown file and blank lines at EOF. The human gate this staging
  // feeds exists precisely to judge such things; a fatal check at the last
  // step hands them nothing instead. Only genuine integrity failures still
  // refuse: git-state drift, an empty diff, and staged paths escaping the
  // allowlist.
  const warnings = []
  if (ghosts.length) {
    warnings.push(\`allowlist entries dropped — created during the run, deleted again before the handoff:\\n\${ghosts.join('\\n')}\`)
  }
  try {
    git(['diff', '--cached', '--check'], worktree)
  } catch (error) {
    warnings.push(\`whitespace findings in the staged diff (cosmetic — clean before committing if your CI checks them):\\n\${String(error.message || '').trim()}\`)
  }
  const stagedPaths = git(['diff', '--cached', '--name-only'], worktree).trim().split(/\\r?\\n/).filter(Boolean)
  const allowed = (entry) => paths.some((scope) => entry === scope || entry.startsWith(\`\${scope}/\`))
  const unexpected = stagedPaths.filter((entry) => !allowed(entry))
  if (unexpected.length) throw new Error(\`Staged paths outside allowlist: \${unexpected.join(', ')}\`)
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], worktree).split(/\\r?\\n/).filter(Boolean)
  const residual = status.filter((line) => {
    const index = line.slice(0, 2)
    return index === '??' || index[1] !== ' '
  })
  if (residual.length) {
    warnings.push(\`files changed by the run but NOT part of the staged handoff — review whether they belong:\\n\${residual.join('\\n')}\`)
  }
  const result = { status: 'ready', startHead, currentHead, branch: git(['branch', '--show-current'], worktree).trim(), worktree, stagedPaths, ...(warnings.length ? { warnings } : {}) }`,
    "advisory whitespace and residual stage findings",
  );
  return text;
};

const preserved = new Map();
for (const name of CEZAR_OWNED) {
  const dir = join(DEST, name);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    continue; // not yet authored — nothing to preserve
  }
  if (!stat.isDirectory()) continue;
  cpSync(dir, join(HOLD, name), { recursive: true });
  preserved.set(name, join(HOLD, name));
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
const vendored = [];
for (const [name, held] of preserved) {
  cpSync(held, join(DEST, name), { recursive: true });
  vendored.push(name);
}
rmSync(HOLD, { recursive: true, force: true });

for (const [from, to] of NAME_MAP) {
  if (CEZAR_OWNED.has(to)) continue; // cezar authors this one; upstream has no say
  const srcDir = join(source, 'skills', from);
  let stat;
  try {
    stat = statSync(srcDir);
  } catch {
    continue; // map entries like om-harness-review are filenames, not skill dirs
  }
  if (!stat.isDirectory()) continue;
  const destDir = join(DEST, to);
  cpSync(srcDir, destDir, { recursive: true });
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const renamedName = rename(entry.name);
      const renamedPath = join(dir, renamedName);
      if (renamedName !== entry.name) {
        cpSync(path, renamedPath, { recursive: true });
        rmSync(path, { recursive: true });
      }
      if (entry.isDirectory()) {
        walk(renamedPath);
        continue;
      }
      if (!TEXT_EXT.has(extname(renamedName).toLowerCase())) continue;
      let text = rename(readFileSync(renamedPath, 'utf8'));
      if (renamedName === 'SKILL.md' && REQUIRES[to]) text = injectRequires(text, REQUIRES[to]);
      text = patchCezarHarnessFile(to, renamedPath.slice(destDir.length + 1), text);
      writeFileSync(renamedPath, text, { mode: statSync(renamedPath).mode });
    }
  };
  walk(destDir);
  vendored.push(to);
}
writeFileSync(
  join(DEST, 'MANIFEST.json'),
  `${JSON.stringify(
    {
      source: { repo: 'open-mercato/skills', ref, commit },
      generatedAt: new Date().toISOString(),
      generatedBy: 'scripts/vendor-skills.mjs',
      nameMap: Object.fromEntries(NAME_MAP),
      requires: REQUIRES,
      cezarOwned: [...CEZAR_OWNED],
      skills: [...vendored].sort(),
    },
    null,
    2,
  )}\n`,
);
console.log(
  `vendored ${vendored.length - preserved.size} skills from ${ref}@${commit.slice(0, 7)} into packages/cezar/vendor/skills/` +
    (preserved.size ? ` (preserved cezar-authored: ${[...preserved.keys()].join(', ')})` : ''),
);
