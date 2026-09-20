/**
 * Backend-parity roll-up — the spec's hard rule made executable.
 *
 * The spec (`.ai/specs/2026-07-14-cockpit-ui-redesign.md` §"Backend parity
 * requirement") demands that every capability in the parity matrix is
 * emitted by EVERY backend, so the GUI degrades per-capability, never
 * per-backend. This table test asserts it over the golden fixtures' expected
 * outputs (the hand-verified wire-faithful contract for each mapper): if a
 * future mapper change drops a capability — or a new fixture set forgets to
 * cover one — a named row fails here.
 *
 * `BACKENDS` lists every backend that owns a wire mapper. Pi uses its documented
 * RPC protocol and therefore has its own wire-faithful fixture set; gemini's
 * fixtures are real `gemini --acp` transcripts (`__fixtures__/gemini/README.md`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UiEvent, UiItem } from './ui-events.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKENDS = ['claude', 'codex', 'opencode', 'pi', 'gemini'] as const;

/** Every event across every golden fixture of one backend. */
function fixtureEvents(backend: (typeof BACKENDS)[number]): UiEvent[] {
  const dir = join(HERE, '__fixtures__', backend);
  const events: UiEvent[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.expected.json')) continue;
    events.push(...(JSON.parse(readFileSync(join(dir, file), 'utf8')) as UiEvent[]));
  }
  return events;
}

function items(events: UiEvent[]): UiItem[] {
  return events
    .filter(
      (e): e is Extract<UiEvent, { type: 'item.started' | 'item.updated' | 'item.completed' }> =>
        e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed',
    )
    .map((e) => e.item);
}

function hasToolStatus(events: UiEvent[], status: string): boolean {
  return items(events).some((item) => item.kind === 'tool' && item.status === status);
}

/** The parity matrix (spec §"Backend parity requirement"): capability →
 *  predicate over a backend's full v2 fixture output. */
const CAPABILITIES: ReadonlyArray<[name: string, produced: (events: UiEvent[]) => boolean]> = [
  [
    'plan.updated with entries (TodoWrite / todoList / todowrite)',
    (events) => events.some((e) => e.type === 'plan.updated' && e.entries.length > 0),
  ],
  ['tool status: running', (events) => hasToolStatus(events, 'running')],
  ['tool status: completed', (events) => hasToolStatus(events, 'completed')],
  ['tool status: failed', (events) => hasToolStatus(events, 'failed')],
  // Non-empty is the point: a reasoning item with no text renders as a dead
  // "Thinking —" row, so presence alone is not parity (#528).
  [
    'reasoning items (thinking / reasoning items / reasoning parts)',
    (events) => items(events).some((item) => item.kind === 'reasoning' && item.text.trim() !== ''),
  ],
  [
    'structured diffs (Edit input / fileChange.changes / patch parts)',
    (events) => items(events).some((item) => item.kind === 'tool' && (item.diffs?.length ?? 0) > 0),
  ],
  [
    'sub-agent task items (Task / review-mode items / subtask parts)',
    (events) => items(events).some((item) => item.kind === 'tool' && item.toolKind === 'task'),
  ],
  [
    'usage.updated with raw token counts',
    (events) => events.some((e) => e.type === 'usage.updated' && e.usage.total > 0),
  ],
  [
    'turn.completed with per-turn directional usage',
    (events) =>
      events.some(
        (e) => e.type === 'turn.completed' && (e.usage?.input ?? 0) > 0 && (e.usage?.output ?? 0) > 0,
      ),
  ],
  ['turn.completed with a stopReason', (events) => events.some((e) => e.type === 'turn.completed' && e.stopReason !== undefined)],
] as const;

/**
 * A capability the upstream WIRE cannot carry — never one a mapper merely forgot. Each entry is
 * pinned in both directions below: every other capability still applies to that backend, and the
 * gap itself must still hold, so the fixture that one day carries the data fails here and forces
 * the exemption out.
 *
 * gemini / plan: Gemini CLI 0.60.0 sends no plan on the ACP wire. It never emits a `plan` update;
 * `write_todos` exists only for Gemini 2 models and its frames carry just the title "Set N todo(s)"
 * (no `rawInput`, empty `content`); Gemini 3 — the default routing — has no plan tool at all
 * (`__fixtures__/gemini/README.md`, `write-todos-quota.ndjson`). Spec 2026-09-19 Phase 2 assumed a
 * `write_todos` input to read; the real CLI does not provide one. Decided for #581: accept the gap
 * rather than read Gemini's private chat recording (Gemini-2-only, vendor-internal format) or add a
 * new cezar plan marker. The dock stays empty for Gemini until Gemini sends plans over ACP; the
 * shared mapper already maps an ACP `plan` update, so that day needs only this entry removed.
 */
const WIRE_GAPS: Partial<Record<(typeof BACKENDS)[number], readonly string[]>> = {
  gemini: ['plan.updated with entries (TodoWrite / todoList / todowrite)'],
};

describe('protocol v2 backend parity (every mapper emits every matrix capability)', () => {
  for (const backend of BACKENDS) {
    const events = fixtureEvents(backend);
    for (const [name, produced] of CAPABILITIES) {
      if (WIRE_GAPS[backend]?.includes(name)) {
        it(`${backend} cannot produce ${name} — a documented upstream wire gap, still true`, () => {
          expect(produced(events)).toBe(false);
        });
        continue;
      }
      it(`${backend} produces ${name}`, () => {
        expect(produced(events)).toBe(true);
      });
    }
  }

  it('every documented wire gap names a real capability', () => {
    const names = CAPABILITIES.map(([name]) => name);
    for (const gaps of Object.values(WIRE_GAPS)) for (const gap of gaps ?? []) expect(names).toContain(gap);
  });

  // Sub-agent NESTING rides on parentItemId where the wire attributes work
  // to its parent: claude `parent_tool_use_id` and opencode child-session
  // parts under a `subtask`. Codex's wire has no parent attribution — its
  // matrix cell is the review-mode task items asserted above. Gemini's ACP
  // wire has none either: its cell is the `invoke_agent` task item (one per
  // delegation, running → completed), asserted by the task row above.
  for (const backend of ['claude', 'opencode'] as const) {
    it(`${backend} nests sub-agent work via parentItemId`, () => {
      expect(items(fixtureEvents(backend)).some((item) => item.parentItemId !== undefined)).toBe(true);
    });
  }
});
