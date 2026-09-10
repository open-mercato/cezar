/**
 * The tree directory — the FILESYSTEM channel between a task and the tasks it dispatched
 * (spec `.ai/specs/2026-09-10-dispatch.md`).
 *
 *     .ai/cezar/dispatch/<rootRunId>/
 *       brief.md                 the root's objective — what every task in the tree is accountable to
 *       ledger.jsonl             one line per engine event: dispatch, settle, notice, guard-ask
 *       units/<id8>/order.md     the task order a child was given (engine writes at dispatch)
 *       units/<id8>/notes.md     the task's own running notes: progress, findings, suggestions
 *       units/<id8>/report.md    what the task reported when it settled (engine writes)
 *       inbox/<id8>/<file>.md    messages TO a task — written by any task, or by the engine
 *       inbox/root/<file>.md     messages to the root, whoever wrote them
 *
 * Files are the CONTENT; the engine is the SIGNAL. Nothing here watches the filesystem or arms
 * a timer: the engine scans a tree's inboxes at every task turn-end and settle and wakes a
 * parked recipient, and a session that opens is handed a digest of what arrived while it was
 * away (`listInbox` since the task's persisted `inboxSeenAt`).
 *
 * Written state, never required (AGENTS.md § Zero config): every reader degrades to "nothing
 * there" on a missing directory, and deleting the tree loses history, not function.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The first eight characters of a run id — the same handle `cez/<id8>` branches use, so a unit
 *  can address a sibling from the branch name in a report. */
export function shortId(runId: string): string {
  return runId.slice(0, 8);
}

/** The recipient directory name for a run: `root` for the tree's root, `<id8>` otherwise. */
export function inboxName(runId: string, rootRunId: string): string {
  return runId === rootRunId ? 'root' : shortId(runId);
}

export function treeDir(dataDir: string, rootRunId: string): string {
  return join(dataDir, 'dispatch', rootRunId);
}

export function unitDir(dataDir: string, rootRunId: string, runId: string): string {
  return join(treeDir(dataDir, rootRunId), 'units', shortId(runId));
}

export function inboxDir(dataDir: string, rootRunId: string, recipient: string): string {
  return join(treeDir(dataDir, rootRunId), 'inbox', recipient);
}

export function briefPath(dataDir: string, rootRunId: string): string {
  return join(treeDir(dataDir, rootRunId), 'brief.md');
}

/** The paths one task needs to know about itself, spelled out for its task order and its env. */
export interface TaskPaths {
  treeDir: string;
  brief: string;
  order: string;
  notes: string;
  report: string;
  inbox: string;
  rootInbox: string;
}

export function taskPaths(dataDir: string, rootRunId: string, runId: string): TaskPaths {
  const tree = treeDir(dataDir, rootRunId);
  const own = unitDir(dataDir, rootRunId, runId);
  return {
    treeDir: tree,
    brief: join(tree, 'brief.md'),
    order: join(own, 'order.md'),
    notes: join(own, 'notes.md'),
    report: join(own, 'report.md'),
    inbox: inboxDir(dataDir, rootRunId, inboxName(runId, rootRunId)),
    rootInbox: inboxDir(dataDir, rootRunId, 'root'),
  };
}

// ---- writes ---------------------------------------------------------------------------------

function writeText(path: string, text: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return path;
}

/** `brief.md` — written once, at the root's FIRST dispatch, from the root's own task text: the
 *  objective every task in the tree is accountable to, in the user's words. */
export function writeBrief(dataDir: string, rootRunId: string, objective: string): string {
  const path = briefPath(dataDir, rootRunId);
  if (existsSync(path)) return path;
  const lines = [
    `# Brief`,
    ``,
    `- Root task: ${rootRunId}`,
    `- Written: ${new Date().toISOString()}`,
    ``,
    `## Objective`,
    ``,
    objective.trim(),
    ``,
    `## How to use this directory`,
    ``,
    `- Read this file before working on a dispatched task. Every task in the tree is accountable to THIS objective, whatever its own order says.`,
    `- \`units/<id8>/order.md\` is what each task was told; \`units/<id8>/notes.md\` is what it wrote as it worked; \`units/<id8>/report.md\` is what it reported when it settled.`,
    `- To message a task, write a markdown file into \`inbox/<id8>/\` (the first eight characters of its run id, as in its branch name). \`inbox/root/\` reaches the root. cezar wakes a parked recipient and hands an opening session a digest of what arrived while it was away.`,
    ``,
  ];
  return writeText(path, lines.join('\n'));
}

/** `units/<id8>/order.md` — the task order, verbatim, so a unit (or its commander) can re-read it. */
export function writeOrder(
  dataDir: string,
  rootRunId: string,
  runId: string,
  order: { title: string; kind: string; parentRunId?: string; text: string },
): string {
  const header = [
    `# Order — ${order.title}`,
    ``,
    `- Run: ${runId}`,
    `- Kind: ${order.kind}`,
    ...(order.parentRunId ? [`- Ordered by: ${order.parentRunId}`] : []),
    `- Issued: ${new Date().toISOString()}`,
    ``,
  ];
  return writeText(taskPaths(dataDir, rootRunId, runId).order, `${header.join('\n')}${order.text}`);
}

/** `units/<id8>/notes.md` — seeded ONCE with the sections the engine reads back; never
 *  overwritten, because it is the unit's own file from then on. */
export function seedNotes(dataDir: string, rootRunId: string, runId: string, title: string): string {
  const path = taskPaths(dataDir, rootRunId, runId).notes;
  if (existsSync(path)) return path;
  return writeText(
    path,
    [
      `# Notes — ${title}`,
      ``,
      `Your running notes. Write here as you work: what you found, what you decided, what you could not do. Your parent task and your siblings can read this file at any time.`,
      ``,
      `## Progress`,
      ``,
      `## Findings`,
      ``,
      `## Suggestions for the root`,
      ``,
      `Anything the root task should know that is outside your order — a better split, a risk, a missing piece. cez forwards this section to the root's inbox when you settle. Suggest; never redefine the objective.`,
      ``,
    ].join('\n'),
  );
}

/** `units/<id8>/report.md` — the settle report as the parent received it, plus the structured one. */
export function writeReport(dataDir: string, rootRunId: string, runId: string, text: string, structured: unknown): string {
  return writeText(
    taskPaths(dataDir, rootRunId, runId).report,
    `# Report — ${shortId(runId)}\n\n- Settled: ${new Date().toISOString()}\n\n${text}\n\n## Structured\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\`\n`,
  );
}

/** `ledger.jsonl` — one appended line per engine event. Best-effort: a ledger write must never
 *  fail a turn end, and a missing ledger is a tree with no history, not a broken one. */
export function appendLedger(dataDir: string, rootRunId: string, entry: Record<string, unknown>): void {
  try {
    const dir = treeDir(dataDir, rootRunId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // best effort
  }
}

/** A message into a unit's inbox. `recipient` is an inbox directory name (`root` or an id8). */
export function writeInboxMessage(
  dataDir: string,
  rootRunId: string,
  recipient: string,
  message: { from: string; subject: string; body: string },
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = message.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'message';
  const path = join(inboxDir(dataDir, rootRunId, recipient), `${stamp}-${shortId(message.from)}-${slug}.md`);
  return writeText(
    path,
    `# ${message.subject}\n\n- From: ${message.from}\n- At: ${new Date().toISOString()}\n\n${message.body}\n`,
  );
}

// ---- reads ----------------------------------------------------------------------------------

export interface InboxItem {
  path: string;
  name: string;
  /** Epoch ms of the file's last write. */
  mtimeMs: number;
}

/** Every file in a recipient's inbox newer than `since` (ISO instant), oldest first. A missing
 *  inbox is an empty one. Sub-directories are ignored — messages are files. */
export function listInbox(dataDir: string, rootRunId: string, recipient: string, since?: string): InboxItem[] {
  const dir = inboxDir(dataDir, rootRunId, recipient);
  const floor = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const items: InboxItem[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs > floor) items.push({ path, name, mtimeMs: stat.mtimeMs });
    } catch {
      // vanished between readdir and stat — nothing to deliver
    }
  }
  return items.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** The block a session is handed (or a parked one is woken with) for new inbox files. Paths,
 *  not contents: the agent reads them with its own tools, and a 40-file inbox must not become a
 *  40-file prompt. */
export function inboxDigest(items: readonly InboxItem[], inbox: string): string | undefined {
  if (items.length === 0) return undefined;
  const lines = items.map((item) => `- ${item.path}`);
  return `## Tree inbox — ${items.length} new message${items.length === 1 ? '' : 's'} in ${inbox}\nRead each file before deciding your next step.\n${lines.join('\n')}`;
}

/** The `## Suggestions for the root` section of a task's notes, or `''` when it is only the seed. */
export function notesSuggestions(dataDir: string, rootRunId: string, runId: string): string {
  let text: string;
  try {
    text = readFileSync(taskPaths(dataDir, rootRunId, runId).notes, 'utf8');
  } catch {
    return '';
  }
  const header = '## Suggestions for the root';
  const idx = text.indexOf(header);
  if (idx < 0) return '';
  const body = text.slice(idx + header.length).split(/\n## /)[0] ?? '';
  return body
    .split('\n')
    .filter((line) => !line.startsWith('Anything the root task should know'))
    .join('\n')
    .trim();
}

/** The lines a task order carries about the tree directory: where the brief is, where to
 *  write, where to listen. */
export function treeEnvelopeLines(paths: TaskPaths): string[] {
  return [
    `- Tree directory: ${paths.treeDir}`,
    `- Brief (read it FIRST — the objective you are ultimately accountable to): ${paths.brief}`,
    `- Your order, verbatim: ${paths.order}`,
    `- Your notes (write progress, findings and suggestions here as you go): ${paths.notes}`,
    `- Your inbox (messages to you; cez tells you when something new arrives): ${paths.inbox}`,
    `- To message another task, write a markdown file into ${paths.treeDir}/inbox/<its id8>/ — the root is inbox/root/. Other tasks' orders, notes and reports are under ${paths.treeDir}/units/<id8>/.`,
  ];
}
