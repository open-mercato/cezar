import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-task handoff journal (spec 007): `.ai/cezar/runs/<runId>.handoff.md`,
 * next to the run's NDJSON events and outside the task worktree — it survives
 * worktree removal. Cez seeds the skeleton and appends heartbeats; the agent
 * (told via CEZ_HANDOFF_FILE + the system-prompt fragment below) keeps the
 * "Progress log" and "Resume notes" sections up to date. Everything here is
 * best-effort: the handoff is a journal, never a reason to fail a run.
 */

export function handoffPath(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}.handoff.md`);
}

export interface HandoffSeed {
  id: string;
  title: string;
  workflow: string;
  task: string;
  branch?: string;
  worktreePath?: string;
}

/** Create the handoff skeleton. Idempotent — an existing file (resume,
 *  continuation) is never overwritten. Returns the file path. */
export function seedHandoffFile(dataDir: string, run: HandoffSeed): string {
  const file = handoffPath(dataDir, run.id);
  if (existsSync(file)) return file;
  const header =
    `# Handoff — ${run.title}\n\n` +
    `**Task id:** ${run.id}\n` +
    `**Workflow:** ${run.workflow}\n` +
    (run.branch ? `**Branch:** ${run.branch}\n` : '') +
    (run.worktreePath ? `**Worktree:** ${run.worktreePath}\n` : '') +
    `\n## Goal\n\n${run.task.trim()}\n\n` +
    `## Progress log\n\n` +
    `## Resume notes\n`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, header, 'utf8');
  } catch {
    // best effort — a read-only data dir must not break the run
  }
  return file;
}

/**
 * Cez's own heartbeat (the janitor pattern): insert `- <ISO ts> — <note>`
 * right under the `## Progress log` header (newest at the top), so the file
 * stays current even when the agent forgets to write. Missing header →
 * append at the end of the file; missing file → no-op.
 */
export function appendHandoffHeartbeat(dataDir: string, runId: string, note: string): void {
  const file = handoffPath(dataDir, runId);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // not seeded — nothing to heartbeat
  }
  const line = `- ${new Date().toISOString()} — ${note}\n`;
  const marker = '## Progress log\n';
  const idx = text.indexOf(marker);
  const next =
    idx >= 0
      ? `${text.slice(0, idx + marker.length)}\n${line}${text.slice(idx + marker.length).replace(/^\n+/, '')}`
      : `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}${line}`;
  try {
    writeFileSync(file, next, 'utf8');
  } catch {
    // best effort
  }
}

/** Full handoff markdown, or '' when the file doesn't exist (yet). */
export function readHandoff(dataDir: string, runId: string): string {
  try {
    return readFileSync(handoffPath(dataDir, runId), 'utf8');
  } catch {
    return '';
  }
}

/**
 * First few non-empty lines under "## Progress log" (spec 010 — the variant
 * comparison columns). Stops at the next `## ` header; '' when there's no
 * Progress log section or it's empty.
 */
export function handoffProgressExcerpt(text: string, maxLines = 3): string {
  const marker = '## Progress log';
  const idx = text.indexOf(marker);
  if (idx < 0) return '';
  const lines: string[] = [];
  for (const line of text.slice(idx + marker.length).split('\n')) {
    if (line.startsWith('## ')) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines.push(trimmed);
    if (lines.length >= maxLines) break;
  }
  return lines.join('\n');
}

export function deleteHandoff(dataDir: string, runId: string): void {
  try {
    rmSync(handoffPath(dataDir, runId), { force: true });
  } catch {
    // best effort
  }
}

/**
 * Is the global follow-up inbox on? (#471)
 *
 * Opt-in, off by default: agents kept hanging on stale, pre-saved follow-ups,
 * which made skill behavior unpredictable. This is the single source of truth —
 * `resolveCapabilities` reports it to the UI and `RunManager` enforces it on
 * every run, so the HTTP route, the `cezar run` CLI and the inbox's own "▶ Run"
 * cannot drift apart. The per-task handoff journal is a separate feature and is
 * never gated by this.
 *
 * An exact `'1'` opts in — the house spelling (`AGENTS.md`: "opt-in behind a
 * `CEZ_*` flag, off by default").
 */
export function followupsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_FOLLOWUPS === '1';
}

/**
 * Appended to every agent step's `--append-system-prompt` (spec 007). The
 * matching handoff/task env vars are set on every agent process;
 * CEZ_TODOS_FILE carries a usable path only when follow-up generation is
 * enabled (#444, #471) — opted-out runs get it empty, never absent, so an
 * inherited value from a parent cezar cannot shine through
 * (`RunManager.agentEnv`).
 */
export const HANDOFF_ONLY_INSTRUCTIONS = `## Handoff (cezar)

CEZ_HANDOFF_FILE (env) is the absolute path to this task's rolling handoff file. Treat it like a HANDOFF.md:
1. At the start of work, read it — "Resume notes" left by a previous session is your starting context.
2. After every meaningful milestone (passing tests, a commit, a PR, a scope decision), append one terse timestamped line under "## Progress log", newest at the top.
3. Before finishing or pausing, update "## Resume notes" with what's done, what's next and any blockers. Leave it empty only when the task is truly complete.

Task completion marker: when the task's goal is fully achieved and you have no question for the user, end your final message with a line containing exactly CEZ:DONE — cez then closes the session and marks the task finished. If you are waiting on the user (a question, a decision, missing input), just end your message normally; the session stays open for their reply. Never emit CEZ:DONE while anything is unfinished or unverified.

Still-working marker: if you end a turn while still working on your OWN downstream work — a sub-agent you dispatched, or a long-running command you're monitoring — and are NOT waiting on the user for anything, end your final message with a line containing exactly CEZ:MONITORING. cez then shows the task as "monitoring" (still working) instead of asking for your attention. Use CEZ:MONITORING only for that in-progress case; use CEZ:DONE when the goal is done; end plainly (no marker) only when you are genuinely waiting on the user. Never combine CEZ:MONITORING with CEZ:DONE.

Structured question marker: when you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from the request, the code, or sensible defaults — and it comes down to a few concrete choices, end your turn with a single line CEZ:ASK <json> instead of asking in prose. cez renders it as clickable option chips in the cockpit so the user can answer in one tap. The <json> is ONE object on ONE line, the last thing in your message: {"questions":[{"header":"≤12-char label","question":"a clear question ending in ?","multiSelect":false,"options":[{"label":"short choice","description":"what it means / the trade-off"}]}]} — use only those keys (plus an optional non-empty "id" up to 64 characters), with 1–4 questions, 2–4 options per question, unique question text and option labels, header 1–12 characters, question 1–400, option label 1–60, and description at most 280. The user can always type a free-form reply, so never add an "Other" option. Prefer sensible defaults over asking; use CEZ:ASK only when the choice is truly the user's. Never combine CEZ:ASK with CEZ:DONE or CEZ:MONITORING.

Task reference markers: as soon as you know which GitHub pull request or issue this task is ABOUT (it was named in the task, or you just opened it), declare it by emitting, on its own line in your message text: CEZ:PR=<number> and/or CEZ:ISSUE=<number>. Re-emit with the new number if the subject changes (e.g. you open a PR later in the task). Declare only the task's own subject — never a PR/issue you merely mention, list, or compare against. You may also emit CEZ:TITLE=<terse gerund phrase, max 40 chars, e.g. "implementing comment threads"> once the work has a clearer shape than its current title; cez uses these instead of guessing from the transcript. Put markers in plain message text, never inside a code fence.

## Pasted attachments
User-pasted screenshots/files are saved as real files; their absolute paths are listed in the message that carries them. Use those paths when a task needs the file itself (saving, uploading, attaching to issues/PRs); the inline image is for viewing only.`;

export const FOLLOWUP_INSTRUCTIONS = `## Follow-ups (cezar)

CEZ_TODOS_FILE (env) is the absolute path to the user's follow-up inbox — a JSON array. Only append an entry when a genuinely actionable follow-up remains: something concrete a human or the next agent still needs to decide or do (a review nit worth a dedicated pass, a manual step you cannot take yourself, a decision blocked on the user, a known next task). Do NOT append filler — a restated summary of what you just finished, a congratulatory note, or "no further action needed" is not a follow-up; when the task is simply done, skip this file entirely. When (and only when) a real follow-up exists, read the file (treat a missing file as []), append ONE object and write the whole array back:
{ "ts": "<ISO 8601>", "taskId": "<value of CEZ_TASK_ID>", "summary": "<one sentence: the concrete next action, not a status report>", "action": "<imperative user action, optional>", "prUrl": "<optional>", "suggestedSkill": "<optional skill name for the follow-up>", "suggestedArgs": "<optional>", "suggestedPrompt": "<optional freeform prompt for the follow-up task>", "runnable": <true when an agent can execute this follow-up, false when it is a note> }
Set "runnable": false for anything a human must do or merely read — manual QA, "remember to…", informational notes — and leave out suggestedSkill/suggestedPrompt for those; the inbox then offers "Acknowledge" instead of "Run". Set "runnable": true only when suggestedSkill or suggestedPrompt says what to actually execute.
Never modify or remove existing entries — append only.`;

/** Default-on combined contract retained for old callers and runs. */
export const HANDOFF_INSTRUCTIONS = `${HANDOFF_ONLY_INSTRUCTIONS}\n\n${FOLLOWUP_INSTRUCTIONS}`;
