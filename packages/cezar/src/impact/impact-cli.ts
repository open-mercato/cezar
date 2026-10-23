/**
 * `cez impact evidence|render` — the agent's local validate–fix loop for an impact review
 * (spec 2026-10-22-html-artifacts-and-impact, Q7). No server and no CEZ_API_URL: it must keep
 * working with CEZ_DISPATCH=0 and outside a cockpit. Paths default to `$CEZ_ARTIFACTS_DIR`, then
 * the current directory.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { collectEvidence, type CommandRunner, type EvidenceRequest } from './evidence.ts';
import { IMPACT_HTML, publishImpact, writeAtomic } from './publish.ts';
import { loadDemoReview, renderImpact } from './render.ts';
import { formatIssue, validateReview } from './validate.ts';

export interface ImpactCliContext {
  cwd: string;
  env: { CEZ_ARTIFACTS_DIR?: string };
  log: (line: string) => void;
  error: (line: string) => void;
  run?: CommandRunner;
}

export const IMPACT_USAGE = `cez impact — assess a change and render its impact report (local, no cockpit needed)

  cez impact evidence (--pr <n|url> | --spec <path> | --base <ref> --head <ref>) [--out <file>] [--repo <dir>]
                    commit-pinned git evidence as JSON (default: $CEZ_ARTIFACTS_DIR/evidence.json)
  cez impact render [--input <file>] [--out <file>] [--demo]
                    validate review.json (model v4) and render the report
                    (default: $CEZ_ARTIFACTS_DIR/review.json → impact.html; --demo renders the made-up example)

Exit codes: 0 ok · 1 invalid model or evidence failure (one issue per line) · 2 usage`;

function defaultDir(ctx: ImpactCliContext): string {
  return resolve(ctx.cwd, ctx.env.CEZ_ARTIFACTS_DIR || '.');
}

export async function runImpactCommand(argv: string[], ctx: ImpactCliContext): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '-h' || sub === '--help' || sub === 'help') {
    ctx.log(IMPACT_USAGE);
    return sub === undefined ? 2 : 0;
  }
  try {
    if (sub === 'evidence') return await evidenceCommand(rest, ctx);
    if (sub === 'render') return await renderCommand(rest, ctx);
  } catch (error) {
    // parseArgs rejects unknown flags with a TypeError; that is a usage problem, not a crash.
    ctx.error(`cez impact ${sub}: ${error instanceof Error ? error.message : String(error)}`);
    ctx.error(IMPACT_USAGE);
    return 2;
  }
  ctx.error(`cez impact: unknown subcommand ${sub}`);
  ctx.error(IMPACT_USAGE);
  return 2;
}

async function evidenceCommand(args: string[], ctx: ImpactCliContext): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      pr: { type: 'string' },
      spec: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      out: { type: 'string' },
      repo: { type: 'string' },
    },
    strict: true,
  });
  const modes = [values.pr !== undefined, values.spec !== undefined, values.base !== undefined || values.head !== undefined].filter(Boolean).length;
  let request: EvidenceRequest;
  if (modes !== 1) {
    ctx.error('cez impact evidence: pass exactly one of --pr, --spec, or --base with --head');
    return 2;
  }
  if (values.pr !== undefined) request = { mode: 'pr', pr: values.pr };
  else if (values.spec !== undefined) request = { mode: 'spec', path: values.spec };
  else if (values.base && values.head) request = { mode: 'range', base: values.base, head: values.head };
  else {
    ctx.error('cez impact evidence: --base and --head go together');
    return 2;
  }
  const result = await collectEvidence(resolve(ctx.cwd, values.repo ?? '.'), request, ctx.run);
  if (!result.ok) {
    ctx.error(`cez impact evidence: ${result.error}`);
    return 1;
  }
  const out = values.out ? resolve(ctx.cwd, values.out) : resolve(defaultDir(ctx), 'evidence.json');
  writeAtomic(out, `${JSON.stringify(result.evidence, null, 2)}\n`);
  const e = result.evidence;
  const what = e.spec ? `spec ${e.spec.path} (${e.spec.cited_paths.length} cited paths)` : `${e.changed_files.length} changed files`;
  ctx.log(`ok: ${out} — ${what} at ${e.comparison.head.slice(0, 12)}, ${e.public_surface_candidates.length} public surface candidates`);
  return 0;
}

async function renderCommand(args: string[], ctx: ImpactCliContext): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { input: { type: 'string' }, out: { type: 'string' }, demo: { type: 'boolean', default: false } },
    strict: true,
  });
  if (values.demo && values.input !== undefined) {
    ctx.error('cez impact render: --demo and --input are exclusive');
    return 2;
  }
  const dir = defaultDir(ctx);
  let model: unknown;
  let text: string | undefined;
  if (values.demo) model = loadDemoReview();
  else {
    const input = values.input ? resolve(ctx.cwd, values.input) : resolve(dir, 'review.json');
    try {
      text = readFileSync(input, 'utf8');
    } catch {
      ctx.error(`${input}: cannot read the review model`);
      return 1;
    }
    try {
      model = JSON.parse(text);
    } catch (error) {
      ctx.error(`${input}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      return 1;
    }
  }
  const result = validateReview(model);
  if (!result.ok) {
    for (const issue of result.issues) ctx.error(formatIssue(issue));
    return 1;
  }
  const out = values.out ? resolve(ctx.cwd, values.out) : resolve(dir, values.demo ? 'impact-demo.html' : 'impact.html');
  // The report itself is versioned (spec R4) exactly as the server's backstop does it.
  let since = '';
  if (basename(out) === IMPACT_HTML) {
    const { changes } = await publishImpact(dirname(out), result.model, text ?? `${JSON.stringify(model, null, 2)}\n`);
    if (changes) since = ` · ${changes.count} change${changes.count === 1 ? '' : 's'} since v${changes.since}`;
  } else writeAtomic(out, renderImpact(result.model));
  const views = result.model.architecture.views.length;
  ctx.log(`ok: ${out} (${views} view${views === 1 ? '' : 's'})${since}`);
  return 0;
}
