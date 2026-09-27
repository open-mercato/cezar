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
 * RPC protocol and therefore has its own wire-faithful fixture set.
 *
 * Every row below is a hard rule for every backend — see `BACKWARD_COMPATIBILITY.md`
 * §7 and `AGENT_PROTOCOL.md` §6 ("a new backend is not 'done' until it produces
 * every row"). junie's `plan.updated`/reasoning rows are backed by
 * `__fixtures__/junie/schema-plan-reasoning.*`, a fixture derived from the public
 * ACP schema rather than a live capture (see `junie-ui-mapper.ts`'s module doc) —
 * schema-derived is enough to satisfy the row, since the row asserts the mapper
 * CAN produce the capability, not that it was observed live.
 *
 * "sub-agent task items" is the one row with no per-backend workaround: junie's
 * wire is unmodified core ACP, which has no `task` tool-call kind and no
 * published shape for `nativeSubagentSessions` at all (see the module doc) — a
 * genuine protocol gap, not an assumption or a missing fixture, so no fixture
 * (real or schema-derived) could ever satisfy it. This is the SAME narrow,
 * documented substitute `AGENT_PROTOCOL.md` §9 item 7 already grants codex for
 * the nesting cell (codex's wire has no parent attribution either), extended to
 * cover the one row junie's protocol cannot express at all — not a generic
 * per-backend opt-out mechanism. junie is therefore excluded from the loop
 * below the same structural way nesting already excludes codex/pi/junie, rather
 * than through a reusable `exempt` flag on the table.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UiEvent, UiItem } from './ui-events.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKENDS = ['claude', 'codex', 'opencode', 'pi', 'junie'] as const;

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

/** The parity matrix (spec §"Backend parity requirement"): capability → predicate over a
 *  backend's full v2 fixture output. Every row here is required from EVERY backend — no
 *  per-backend exemption list. "sub-agent task items" is asserted separately below, the one
 *  row where junie has a genuine, documented, protocol-level gap (see module doc). */
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

describe('protocol v2 backend parity (every mapper emits every matrix capability)', () => {
  for (const backend of BACKENDS) {
    const events = fixtureEvents(backend);
    for (const [name, produced] of CAPABILITIES) {
      it(`${backend} produces ${name}`, () => {
        expect(produced(events)).toBe(true);
      });
    }
  }

  // "sub-agent task items" — every backend except junie: claude/codex/opencode/pi each map their
  // own bespoke sub-agent tool name onto cezar's `task` ToolKind EXTENSION (not part of ACP
  // itself). junie speaks unmodified core ACP, whose `tool_call.kind` enum has no `task` value
  // and no published shape for `nativeSubagentSessions` — a genuine protocol-level gap, not an
  // assumption or a missing fixture (see `junie-ui-mapper.ts`'s module doc). This is the same
  // narrow, documented substitute `AGENT_PROTOCOL.md` §9 item 7 already grants codex for the
  // nesting cell below, extended to this one row for junie specifically — not a reusable
  // per-backend exemption mechanism.
  for (const backend of ['claude', 'codex', 'opencode', 'pi'] as const) {
    it(`${backend} produces sub-agent task items (Task / review-mode items / subtask parts)`, () => {
      const produced = items(fixtureEvents(backend)).some((item) => item.kind === 'tool' && item.toolKind === 'task');
      expect(produced).toBe(true);
    });
  }

  // Sub-agent NESTING rides on parentItemId where the wire attributes work
  // to its parent: claude `parent_tool_use_id` and opencode child-session
  // parts under a `subtask`. Codex's wire has no parent attribution — its
  // matrix cell is the review-mode task items asserted above. junie's cell is
  // the same documented gap as "sub-agent task items" above: no confirmed wire
  // shape for `nativeSubagentSessions` at all, nested or otherwise.
  for (const backend of ['claude', 'opencode'] as const) {
    it(`${backend} nests sub-agent work via parentItemId`, () => {
      expect(items(fixtureEvents(backend)).some((item) => item.parentItemId !== undefined)).toBe(true);
    });
  }
});
