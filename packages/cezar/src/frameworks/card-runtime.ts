import { execFile } from 'node:child_process';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join, relative } from 'node:path';
import { CARD_HISTORY_CAP, type CardStageStatus, type FrameworkFile, type RunCard } from '@open-mercato/cezar-contract';
import { globMatches, globStaticPrefix } from './artifacts.ts';
import { frameworkHash, FRAMEWORKS_SUBDIR, listBuiltinFrameworks, parseFrameworkYaml, type LoadedFramework } from './load.ts';
import { scrubbedEnv } from './state.ts';

/**
 * The engine half of framework cards (spec 2026-11-15-framework-board § Engine changes) that
 * does not need the RunManager: stage bookkeeping on the card, the Ready-order queue pick, the
 * stage precheck, and the framework-state watchers. `workflows/run.ts` wires them in.
 */

/** A refused card operation; `status` is what the HTTP route answers. */
export class CardOperationError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 422) {
    super(message);
    this.name = 'CardOperationError';
  }
}

/** The marker a conversation stage's agent ends a turn with to propose finishing it (D10). */
// Tolerates markdown emphasis and trailing punctuation around it (`**CEZ:STAGE-DONE**.`).
const STAGE_DONE_RE = /CEZ:STAGE-DONE[\s.!,;:*_`'")\]]*$/;
const STAGE_DONE_STRIP_RE = /\s*[*_`]*CEZ:STAGE-DONE[\s.!,;:*_`'")\]]*$/;
export function endsWithStageDoneMarker(turnText: string): boolean {
  return STAGE_DONE_RE.test(turnText.trimEnd());
}
export function stripStageDoneMarker(text: string): string {
  return text.includes('CEZ:STAGE-DONE') ? text.replace(STAGE_DONE_STRIP_RE, '') : text;
}

export const CONVERSATION_STAGE_INSTRUCTION =
  'This stage is a conversation with the user: after each of your turns they reply. Ask what you need, one round at a time. ' +
  'When you believe the stage is complete, end your turn with the line CEZ:STAGE-DONE and the user will confirm.';
export const LET_AGENT_DECIDE_PROMPT =
  'The user asked you to decide on your own from here. Finish this stage without waiting for answers, and list every assumption you made at the end.';
export const STAGE_DONE_HEADER = 'Finish stage';
export const STAGE_DONE_YES = 'Yes';
export const STAGE_DONE_NOT_YET = 'Not yet';

export function withHistory(card: RunCard, text: string, at = new Date().toISOString()): RunCard {
  return { ...card, history: [...(card.history ?? []), { at, text }].slice(-CARD_HISTORY_CAP) };
}

/**
 * The card after its walk reached a node of `stage` (D4): forward moves mark the stage it left
 * done, a back edge reopens every stage from the target on, and the stage itself shows `status`.
 */
export function tagCardStage(card: RunCard, stage: string, status: CardStageStatus = 'running'): RunCard {
  const order = card.stageOrder;
  const to = order.indexOf(stage);
  if (to === -1) return card;
  const stages = { ...card.stages };
  let next: RunCard = card;
  if (card.stage !== stage) {
    const from = order.indexOf(card.stage);
    if (from !== -1 && to > from) {
      if (stages[card.stage] !== 'skipped') stages[card.stage] = 'done';
    } else if (from !== -1 && to < from) {
      for (let i = to + 1; i <= from; i++) {
        const id = order[i]!;
        if (stages[id] !== 'skipped') stages[id] = 'pending';
      }
    }
    next = withHistory({ ...card, stage }, `${from !== -1 && to < from ? 'back to' : 'moved to'} ${stage}`);
  }
  stages[stage] = status;
  return { ...next, stages };
}

/** The card while parked at `node`: which gate holds it, or that a conversation waits for the user. */
export function cardParkedAt(card: RunCard, node: { type: string; approve?: string | null; mode?: string }): RunCard {
  const base = clearCardPark(card);
  if (node.type === 'gate.human') return { ...base, gate: { kind: 'approve' } };
  if (node.type === 'gate.framework') return { ...base, gate: { kind: 'framework', approve: node.approve ?? null } };
  if (node.type === 'agent' && node.mode === 'conversation') return { ...base, conversation: true };
  return base;
}

/** The card once it leaves a park: no gate, no conversation. Same object when there was neither. */
export function clearCardPark(card: RunCard): RunCard {
  if (card.gate === undefined && card.conversation === undefined) return card;
  const { gate: _gate, conversation: _conversation, ...rest } = card;
  return rest;
}

/** Ready order: `card.order`, then creation. */
export function readyOrder(a: { card?: RunCard; createdAt: string }, b: { card?: RunCard; createdAt: string }): number {
  const oa = a.card?.order ?? Number.POSITIVE_INFINITY;
  const ob = b.card?.order ?? Number.POSITIVE_INFINITY;
  return oa !== ob ? oa - ob : a.createdAt.localeCompare(b.createdAt);
}

/**
 * Take the next run off the queue (D2, engine step 7). Without cards this is exactly the old
 * `findIndex(startable)`. Cards fill the queue slots they occupy in Ready order: when the first
 * startable entry is a card, the lowest-`order` startable card takes THAT slot (the two swap),
 * so cards compete with ad-hoc runs by enqueue time and an ad-hoc run is never starved by a
 * reorder. `startable` already refuses held cards.
 */
export function takeNextQueued(
  queue: string[],
  startable: (id: string) => boolean,
  cardOf: (id: string) => RunCard | undefined,
): string | undefined {
  const first = queue.findIndex(startable);
  if (first === -1) return undefined;
  const head = cardOf(queue[first]!);
  if (head) {
    let best = first;
    let bestOrder = head.order ?? Number.POSITIVE_INFINITY;
    for (let i = first + 1; i < queue.length; i++) {
      const card = cardOf(queue[i]!);
      const order = card?.order ?? Number.POSITIVE_INFINITY;
      if (card && order < bestOrder && startable(queue[i]!)) {
        best = i;
        bestOrder = order;
      }
    }
    if (best !== first) [queue[first], queue[best]] = [queue[best]!, queue[first]!];
  }
  return queue.splice(first, 1)[0];
}

/** A framework by id, synchronously: built-ins, then `<dataDir>/frameworks/<id>.yaml`. */
export function loadFrameworkSync(dataDir: string, id: string): LoadedFramework | undefined {
  const builtin = listBuiltinFrameworks().find((f) => f.id === id);
  if (builtin) return builtin;
  for (const ext of ['.yaml', '.yml']) {
    const path = join(dataDir, FRAMEWORKS_SUBDIR, `${id}${ext}`);
    if (!existsSync(path)) continue;
    let yaml: string;
    try {
      yaml = readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
    const parsed = parseFrameworkYaml(yaml);
    const base = { id, source: 'project' as const, yaml, hash: frameworkHash(yaml), path };
    if ('framework' in parsed && parsed.framework.id !== id) return { ...base, error: `the file declares id "${parsed.framework.id}"` };
    return { ...base, ...parsed };
  }
  return undefined;
}

export interface PrecheckResult {
  ok: boolean;
  /** The command's last lines — the framework's blocker list. */
  output: string;
}

/** A stage's `precheck` (D13's framework pre-gate), in the worktree; scrubbed like a check node. */
export function runPrecheck(command: string, cwd: string, timeoutMs = 120_000): Promise<PrecheckResult> {
  const env = scrubbedEnv();
  return new Promise((resolve) => {
    execFile(command, [], { cwd, shell: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, env }, (err, stdout, stderr) => {
      const text = `${String(stdout ?? '')}\n${String(stderr ?? '')}`.trim();
      const lines = text.split('\n').filter((l) => l.trim()).slice(-20).join('\n');
      const output = lines.length > 2_000 ? `…${lines.slice(-2_000)}` : lines;
      if (!err) return resolve({ ok: true, output });
      const killed = (err as { killed?: boolean }).killed;
      resolve({ ok: false, output: killed ? `\`${command}\` timed out` : output || `\`${command}\` exited non-zero` });
    });
  });
}

/**
 * One debounced `fs.watch` on the directory a framework's `state.watch` glob lives under, in a
 * card's worktree (D7 trigger). Returns its close, or undefined when the directory does not exist
 * or the platform refuses a recursive watch — the focus and approve rechecks still apply.
 */
export function watchFrameworkState(worktree: string, glob: string, onChange: () => void, debounceMs = 400): (() => void) | undefined {
  const dir = join(worktree, ...globStaticPrefix(glob));
  if (!existsSync(dir)) return undefined;
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (filename) {
        const rel = relative(worktree, join(dir, String(filename)));
        if (!globMatches(glob, rel)) return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
      timer.unref?.();
    });
  } catch {
    return undefined;
  }
  watcher.on('error', () => undefined);
  watcher.unref?.();
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}

/** The `stages` map a new card starts with: every framework stage pending, skipped ones marked. */
export function initialCardStages(fw: FrameworkFile, skipped: readonly string[]): Record<string, CardStageStatus> {
  return Object.fromEntries(fw.stages.map((s) => [s.id, skipped.includes(s.id) ? 'skipped' : 'pending'] as const));
}
