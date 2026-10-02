#!/usr/bin/env node
// Mock `kilo` binary for CEZ_DRY_RUN=1 — emits Kilo-shaped `run --format json`.

import { appendFileSync } from 'node:fs';

if (process.env.CEZ_MOCK_ARGS_FILE) {
  try {
    appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);
  } catch {
    /* ignore */
  }
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sessionId = 'mock-kilo-session';
// The prompt is always the final positional arg (see buildKiloArgs).
const prompt = process.argv.at(-1) ?? '';

emit({ type: 'step_start', timestamp: 1, sessionID: sessionId, part: { id: 'prt_mock_1', sessionID: sessionId, messageID: 'msg_mock_1', type: 'step-start' } });
emit({
  type: 'text',
  timestamp: 2,
  sessionID: sessionId,
  part: { id: 'prt_mock_2', sessionID: sessionId, messageID: 'msg_mock_1', type: 'text', text: 'mock: kilo dry-run completed the task.' },
});

// `mock:error` — a real Kilo turn can report an `error` frame while the process
// still exits 0 (a scripted/prompt-level failure, not a crash). Exercises the path where the
// stream, not the exit code, is the source of truth for whether the turn failed.
const isError = prompt.includes('mock:error');
if (isError) {
  emit({ type: 'error', timestamp: 3, sessionID: sessionId, error: { name: 'MockError', data: { message: 'mock: kilo dry-run reported a scripted failure.' } } });
} else {
  emit({
    type: 'step_finish',
    timestamp: 3,
    sessionID: sessionId,
    part: {
      id: 'prt_mock_3',
      sessionID: sessionId,
      messageID: 'msg_mock_1',
      type: 'step-finish',
      reason: 'stop',
      tokens: { total: 10, input: 8, output: 2 },
      cost: 0,
    },
  });
}

process.exit(0);
