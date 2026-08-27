#!/usr/bin/env node
// Mock `agent` binary for CEZ_DRY_RUN=1 — emits Cursor-shaped stream-json.

import { appendFileSync } from 'node:fs';

if (process.env.CEZ_MOCK_ARGS_FILE) {
  try {
    appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);
  } catch {
    /* ignore */
  }
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sessionId = 'mock-cursor-session';
// The prompt is always the final positional arg (see buildCursorArgs).
const prompt = process.argv.at(-1) ?? '';

emit({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'login',
  cwd: process.cwd(),
  session_id: sessionId,
  model: 'mock',
  permissionMode: 'default',
});

emit({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'mock: cursor dry-run completed the task.' }],
  },
  session_id: sessionId,
});

// `mock:error` — a real Cursor turn can report `is_error: true` while the process still
// exits 0 (a scripted/prompt-level failure, not a crash). Exercises the path where the
// stream, not the exit code, is the source of truth for whether the turn failed.
const isError = prompt.includes('mock:error');
emit({
  type: 'result',
  subtype: 'success',
  duration_ms: 10,
  duration_api_ms: 10,
  is_error: isError,
  result: isError ? 'mock: cursor dry-run reported a scripted failure.' : 'mock: cursor dry-run completed the task.',
  session_id: sessionId,
});

process.exit(0);
