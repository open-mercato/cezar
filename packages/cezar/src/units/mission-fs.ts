/**
 * The mission directory — the unit hierarchy's FILESYSTEM channel
 * (spec `.ai/specs/2026-09-09-units-improvements-plan.md`; user decision: agents communicate
 * through files, not only through reports).
 *
 *     .ai/cezar/missions/<missionId>/
 *       brief.md                 the objective, constraints and resources — the goal every rank
 *                                is accountable to (written once, at mission start)
 *       plan.md                  the commander's order of battle (Caesar maintains it)
 *       ledger.jsonl             one line per engine event: spawn, settle, notice, refusal
 *       units/<id8>/order.md     the task order a unit was given (engine writes at spawn)
 *       units/<id8>/notes.md     the unit's own running notes: progress, findings, suggestions
 *       units/<id8>/report.md    what the unit reported when it settled (engine writes)
 *       inbox/<id8>/<file>.md    messages TO a unit — written by any unit, or by the engine
 *       inbox/root/<file>.md     messages to the mission root (Caesar), whoever wrote them
 *
 * Files are the CONTENT; the engine is the SIGNAL. Nothing here watches the filesystem or arms
 * a timer: the engine scans a mission's inboxes at every unit turn-end and settle and wakes a
 * parked recipient, and a session that opens is handed a digest of what arrived while it was
 * away (`listInbox` since the unit's persisted `inboxSeenAt`). "Who fires this?" therefore has
 * the same two answers every other unit transition has — a turn ending, a session opening.
 *
 * Written state, never required (AGENTS.md § Zero config): every reader degrades to "nothing
 * there" on a missing directory, and deleting the tree loses history, not function.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnitLadder } from '@open-mercato/cezar-contract';

/** The first eight characters of a run id — the same handle `cez/<id8>` branches use, so a unit
 *  can address a sibling from the branch name in a report. */
export function shortId(runId: string): string {
  return runId.slice(0, 8);
}

/** The recipient directory name for a run: `root` for the mission root, `<id8>` otherwise. */
export function inboxName(runId: string, missionId: string): string {
  return runId === missionId ? 'root' : shortId(runId);
}

export function missionDir(dataDir: string, missionId: string): string {
  return join(dataDir, 'missions', missionId);
}

export function unitDir(dataDir: string, missionId: string, runId: string): string {
  return join(missionDir(dataDir, missionId), 'units', shortId(runId));
}

export function inboxDir(dataDir: string, missionId: string, recipient: string): string {
  return join(missionDir(dataDir, missionId), 'inbox', recipient);
}

export function briefPath(dataDir: string, missionId: string): string {
  return join(missionDir(dataDir, missionId), 'brief.md');
}

/** The paths one unit needs to know about itself, spelled out for its task order and its env. */
export interface UnitPaths {
  missionDir: string;
  brief: string;
  plan: string;
  order: string;
  notes: string;
  report: string;
  inbox: string;
  rootInbox: string;
}

export function unitPaths(dataDir: string, missionId: string, runId: string): UnitPaths {
  const mission = missionDir(dataDir, missionId);
  const own = unitDir(dataDir, missionId, runId);
  return {
    missionDir: mission,
    brief: join(mission, 'brief.md'),
    plan: join(mission, 'plan.md'),
    order: join(own, 'order.md'),
    notes: join(own, 'notes.md'),
    report: join(own, 'report.md'),
    inbox: inboxDir(dataDir, missionId, inboxName(runId, missionId)),
    rootInbox: inboxDir(dataDir, missionId, 'root'),
  };
}

// ---- writes ---------------------------------------------------------------------------------

function writeText(path: string, text: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return path;
}

export interface MissionBriefInput {
  missionId: string;
  objective: string;
  constraints?: string[];
  budgetUsd?: number;
  parallel?: number;
  maxChildren?: number;
  ladder?: UnitLadder;
  rootRole: string;
}

/** `brief.md` — written once when a mission starts. The one file every rank is told to read
 *  first, because it is the user's actual ask, not a commander's paraphrase of it. */
export function writeBrief(dataDir: string, brief: MissionBriefInput): string {
  const lines = [
    `# Mission brief`,
    ``,
    `- Mission id: ${brief.missionId}`,
    `- Root: ${brief.rootRole} on run ${brief.missionId}`,
    `- Started: ${new Date().toISOString()}`,
    ...(brief.budgetUsd !== undefined ? [`- Budget: $${brief.budgetUsd.toFixed(2)} for the whole mission`] : [`- Budget: uncapped`]),
    ...(brief.parallel !== undefined ? [`- Parallel runs: up to ${brief.parallel} at once across the mission`] : []),
    ...(brief.maxChildren !== undefined ? [`- Children in flight per commander: up to ${brief.maxChildren}`] : []),
    ...(brief.ladder ? [`- Ladder: ${JSON.stringify(brief.ladder)}`] : []),
    ``,
    `## Objective`,
    ``,
    brief.objective.trim(),
    ``,
    ...(brief.constraints?.length
      ? [`## Constraints`, ``, ...brief.constraints.map((line) => `- ${line}`), ``]
      : []),
    `## How to use this directory`,
    ``,
    `- Read this file before planning. Every unit in the mission is accountable to THIS objective, whatever its own task order says.`,
    `- \`plan.md\` is the commander's order of battle. \`units/<id8>/order.md\` is what each unit was told; \`units/<id8>/notes.md\` is what it wrote as it worked; \`units/<id8>/report.md\` is what it reported when it settled.`,
    `- To message a unit, write a markdown file into \`inbox/<id8>/\` (the first eight characters of its run id, as in its branch name). \`inbox/root/\` reaches the mission root. cez wakes a parked recipient and hands an opening session a digest of what arrived while it was away.`,
    ``,
  ];
  return writeText(briefPath(dataDir, brief.missionId), lines.join('\n'));
}

/** `units/<id8>/order.md` — the task order, verbatim, so a unit (or its commander) can re-read it. */
export function writeOrder(
  dataDir: string,
  missionId: string,
  runId: string,
  order: { title: string; role: string; parentRunId?: string; text: string },
): string {
  const header = [
    `# Order — ${order.title}`,
    ``,
    `- Run: ${runId}`,
    `- Role: ${order.role}`,
    ...(order.parentRunId ? [`- Ordered by: ${order.parentRunId}`] : []),
    `- Issued: ${new Date().toISOString()}`,
    ``,
  ];
  return writeText(unitPaths(dataDir, missionId, runId).order, `${header.join('\n')}${order.text}`);
}

/** `units/<id8>/notes.md` — seeded ONCE with the sections the engine reads back; never
 *  overwritten, because it is the unit's own file from then on. */
export function seedNotes(dataDir: string, missionId: string, runId: string, title: string): string {
  const path = unitPaths(dataDir, missionId, runId).notes;
  if (existsSync(path)) return path;
  return writeText(
    path,
    [
      `# Notes — ${title}`,
      ``,
      `Your running notes. Write here as you work: what you found, what you decided, what you could not do. Your commander and your siblings can read this file at any time.`,
      ``,
      `## Progress`,
      ``,
      `## Findings`,
      ``,
      `## Suggestions for the mission`,
      ``,
      `Anything the mission root should know that is outside your order — a better split, a risk, a missing piece. cez forwards this section to the root's inbox when you settle. Suggest; never redefine the objective.`,
      ``,
    ].join('\n'),
  );
}

/** `units/<id8>/report.md` — the settle report as the parent received it, plus the structured one. */
export function writeReport(dataDir: string, missionId: string, runId: string, text: string, structured: unknown): string {
  return writeText(
    unitPaths(dataDir, missionId, runId).report,
    `# Report — ${shortId(runId)}\n\n- Settled: ${new Date().toISOString()}\n\n${text}\n\n## Structured\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\`\n`,
  );
}

/** `ledger.jsonl` — one appended line per engine event. Best-effort: a ledger write must never
 *  fail a turn end, and a missing ledger is a mission with no history, not a broken one. */
export function appendLedger(dataDir: string, missionId: string, entry: Record<string, unknown>): void {
  try {
    const dir = missionDir(dataDir, missionId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // best effort
  }
}

/** A message into a unit's inbox. `recipient` is an inbox directory name (`root` or an id8). */
export function writeInboxMessage(
  dataDir: string,
  missionId: string,
  recipient: string,
  message: { from: string; subject: string; body: string },
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = message.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'message';
  const path = join(inboxDir(dataDir, missionId, recipient), `${stamp}-${shortId(message.from)}-${slug}.md`);
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
export function listInbox(dataDir: string, missionId: string, recipient: string, since?: string): InboxItem[] {
  const dir = inboxDir(dataDir, missionId, recipient);
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
  return `## Mission inbox — ${items.length} new message${items.length === 1 ? '' : 's'} in ${inbox}\nRead each file before deciding your next step.\n${lines.join('\n')}`;
}

/** The `## Suggestions for the mission` section of a unit's notes, or `''` when it is only the seed. */
export function notesSuggestions(dataDir: string, missionId: string, runId: string): string {
  let text: string;
  try {
    text = readFileSync(unitPaths(dataDir, missionId, runId).notes, 'utf8');
  } catch {
    return '';
  }
  const header = '## Suggestions for the mission';
  const idx = text.indexOf(header);
  if (idx < 0) return '';
  const body = text.slice(idx + header.length).split(/\n## /)[0] ?? '';
  return body
    .split('\n')
    .filter((line) => !line.startsWith('Anything the mission root should know'))
    .join('\n')
    .trim();
}

/** The lines a task order carries about the mission directory (engine-composed, spec Mission 3
 *  item 1): where the brief is, where to write, where to listen. */
export function missionEnvelopeLines(paths: UnitPaths): string[] {
  return [
    `- Mission directory: ${paths.missionDir}`,
    `- Mission brief (read it FIRST — the objective you are ultimately accountable to): ${paths.brief}`,
    `- Your order, verbatim: ${paths.order}`,
    `- Your notes (write progress, findings and suggestions here as you go): ${paths.notes}`,
    `- Your inbox (messages to you; cez tells you when something new arrives): ${paths.inbox}`,
    `- To message another unit, write a markdown file into ${paths.missionDir}/inbox/<its id8>/ — the mission root is inbox/root/. Other units' orders, notes and reports are under ${paths.missionDir}/units/<id8>/.`,
  ];
}
