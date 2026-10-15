import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UiEvent } from './ui-events.ts';
import {
  GEMINI_AUTH_FAILURE_MESSAGE,
  createGeminiUiState,
  geminiToolName,
  isGeminiAuthFailure,
  mapGeminiFrame,
  type GeminiUiMapperState,
} from './gemini-ui-mapper.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'gemini');

/** Replay a captured transcript exactly as the runner drives the mapper: every frame, both
 *  directions, in wire order (the header line is metadata, not wire). */
function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: GeminiUiMapperState = createGeminiUiState();
  const events: UiEvent[] = [];
  for (const line of lines) {
    const value = JSON.parse(line) as Record<string, unknown>;
    if ('fixture' in value) continue;
    const mapped = mapGeminiFrame(value, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  // Round-trip: these events get persisted as NDJSON, so a stray `undefined` must fail here.
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

const FIXTURE_NAMES = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.ndjson'))
  .map((file) => file.replace(/\.ndjson$/, ''))
  .sort();

describe('gemini --acp → v2 golden fixtures (real Gemini CLI 0.60.0 transcripts)', () => {
  it('has a fixture for every scenario Step 2.1 captured', () => {
    expect(FIXTURE_NAMES).toEqual([
      'cancel',
      'invalid-api-key',
      'load-replay',
      'load-same-minute',
      'permission',
      'session-controls',
      'subagent',
      'tool-lifecycle',
      'unsupported-client',
      'write-todos-quota',
    ]);
  });

  for (const name of FIXTURE_NAMES) {
    it(`maps ${name} exactly`, () => {
      const expected = JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8')) as UiEvent[];
      expect(replay(name)).toStrictEqual(expected);
    });

    it(`${name}: every fixture line cites the CLI version and the ACP docs in its header`, () => {
      const header = JSON.parse(readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8').split('\n')[0]!) as {
        fixture?: { cli?: string; docs?: string };
      };
      expect(header.fixture?.cli).toBe('@google/gemini-cli 0.60.0');
      expect(header.fixture?.docs).toContain('docs/cli/acp-mode.md');
    });
  }

  it('does not re-render a session/load replay: only the live turn after it reaches the cockpit', () => {
    const events = replay('load-replay');
    const texts = events.flatMap((e) => (e.type === 'item.completed' && e.item.kind === 'message' ? [e.item.text] : []));
    expect(texts).toEqual(['3']);
    expect(events.some((e) => e.type === 'item.started' && e.item.kind === 'tool')).toBe(false);
  });

  it('keeps the vendor’s Google-login migration text out of the thread (U11)', () => {
    const events = replay('unsupported-client');
    expect(events).toEqual([{ type: 'session.error', message: GEMINI_AUTH_FAILURE_MESSAGE, fatal: true }]);
    expect(JSON.stringify(events)).not.toContain('Antigravity');
  });

  it('names tools from the toolCallId prefix, since the wire carries no name and no rawInput', () => {
    expect(geminiToolName({ toolCallId: 'read_file__call_769873', kind: 'read' })).toBe('read_file');
    expect(geminiToolName({ toolCallId: 'run_shell_command__call_703733' })).toBe('run_shell_command');
    expect(geminiToolName({ toolCallId: 'opaque-id', kind: 'edit' })).toBe('edit');
    expect(geminiToolName({})).toBe('tool');
  });

  it('recognizes the auth failures seen on this host, and nothing else', () => {
    expect(isGeminiAuthFailure('This client is no longer supported for Gemini Code Assist for individuals.')).toBe(true);
    expect(isGeminiAuthFailure('IneligibleTierError: … reasonCode: UNSUPPORTED_CLIENT')).toBe(true);
    expect(isGeminiAuthFailure('"reason": "API_KEY_INVALID"')).toBe(true);
    expect(isGeminiAuthFailure('Authentication required')).toBe(true);
    expect(isGeminiAuthFailure('You have exhausted your daily quota on this model.')).toBe(false);
  });

  it('ignores malformed and unknown frames without throwing', () => {
    let state = createGeminiUiState();
    state = mapGeminiFrame({ dir: 'out', frame: { jsonrpc: '2.0', id: 0, method: 'session/prompt', params: {} } }, state).state;
    for (const value of [
      null,
      42,
      'text',
      [],
      {},
      { dir: 'sideways', frame: {} },
      { dir: 'in' },
      { dir: 'in', frame: null },
      { dir: 'in', frame: { method: 'session/update' } },
      { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'future_kind', x: 1 } } } },
      { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: null } } } },
      { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'tool_call' } } } },
      { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'plan', entries: 'nope' } } } },
      { dir: 'in', frame: { id: 12345, result: {} } },
      { dir: 'in', frame: { method: 'some/future_notification', params: {} } },
    ]) {
      const mapped = mapGeminiFrame(value, state);
      expect(mapped.events).toEqual([]);
    }
  });
});
