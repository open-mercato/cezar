#!/usr/bin/env node
// Mock `claude` binary for CEZ_DRY_RUN=1 — emits a plausible stream-json
// session so the engine / store / GUI can be exercised without tokens.
// Mirrors the real CLI's contract in SESSION mode: keeps reading {type:user}
// NDJSON lines from stdin, answers each with a scripted turn (assistant
// events + a terminal `result`), and exits when stdin closes (EOF).

import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// Testability hook: CEZ_MOCK_ARGS_FILE=<path> appends the argv this mock was
// spawned with (one JSON array per line), so tests and dry-run proofs can
// assert exactly what reached the CLI (e.g. `--append-system-prompt …`).
if (process.env.CEZ_MOCK_ARGS_FILE) {
  try {
    appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);
  } catch {
    // best effort — never break the mock over the hook
  }
}

emit({ type: 'system', subtype: 'init' });

let turn = 0;

// A tiny generated PNG (320x200) standing in for a browser screenshot.
const MOCK_SCREENSHOT_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAACMklEQVR42u3csQnAIBRFUQdJY+b4tfvP4AhCLKyyghAMMRw4Ezz/bU0RBdhUMgEIGBAwIGAQMCBgQMCAgEHAgIABAYOAAQEDAgYEDAIGBAwsCLhfDdiUgEHAgIABAYOAAQEDAgYEDAIGBAwIGAT8vlEr/ImAQcACBgELGAQsYAQsYBCwgEHAAgYBe3IELGAQsIBBwAJGwAIGAQsYBCxgELCAEbCAQcACBgELGAQMAhYwCFjAIGABI2D/QgMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIBBwCYAAQMCBgQMAgYEDAgYEDAIGBAwIGAQMCBgQMCAgEHAgIABAQMCBgEDAgYEDAIGBAwIGBAwCBgQMCBgQMAgYEDAgIBBwICAAQEDAgYBAwIGBAwCtgIIGBAwIGAQMCBgQMCAgEHAgIABAYOAeejMB/McjIAFLGABW0HAAhYwmhSwgAUsYAQsYAELGAELWMACRsACFrCAEbCABSxgBCxgAQtYwAhYwAIWMAIWsIAFjIAFLGABI2ABC1jACFjAAhYwAhawgAWMgAUsYAEjYAELWMACRsACFrCAEbCABSxgBCxgAQsYAQtYwAJGwAIWMCBgQMAgYEDAgIBBwICAAQEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCBgEDAgYEDAIGBAwIGBAwCBgQMCAgAEBg4ABAQMCBgEDAgYEDAgYBAx8xQ1bxBr9kelHqgAAAABJRU5ErkJggg==';


// Spec 007: behave like an agent that read the handoff/todos instructions —
// append a progress line to CEZ_HANDOFF_FILE and a follow-up entry to
// CEZ_TODOS_FILE, so the inbox loop is testable without tokens.
function writeHandoffAndTodo() {
  try {
    const handoff = process.env.CEZ_HANDOFF_FILE;
    if (handoff) {
      const text = readFileSync(handoff, 'utf8');
      const line = `- ${new Date().toISOString()} — mock: implemented the change (dry run)\n`;
      const marker = '## Progress log\n';
      const idx = text.indexOf(marker);
      const next =
        idx >= 0
          ? text.slice(0, idx + marker.length) + '\n' + line + text.slice(idx + marker.length).replace(/^\n+/, '')
          : text + line;
      writeFileSync(handoff, next, 'utf8');
    }
  } catch {
    // best effort — the mock still answers without a handoff file
  }
  try {
    const todosFile = process.env.CEZ_TODOS_FILE;
    if (todosFile) {
      let items = [];
      try {
        items = JSON.parse(readFileSync(todosFile, 'utf8'));
      } catch {
        items = []; // missing or broken file — start fresh, append-only
      }
      if (!Array.isArray(items)) items = [];
      items.push({
        ts: new Date().toISOString(),
        taskId: process.env.CEZ_TASK_ID,
        summary: 'Follow up: verify the mock change',
        suggestedPrompt: 'Verify the change from the previous task',
      });
      writeFileSync(todosFile, JSON.stringify(items, null, 2), 'utf8');
    }
  } catch {
    // best effort
  }
}

async function respond(userText, imageCount) {
  turn += 1;
  await sleep(250);
  // `mock:done` anywhere in the message → the reply ends with the CEZ:DONE
  // completion marker (#347), so the auto-close path is testable dry.
  const doneMarker = userText.includes('mock:done') ? '\n\nCEZ:DONE' : '';
  // `mock:monitoring` → the reply ends with CEZ:MONITORING, the "still working
  // on downstream work" marker (#490), so the monitoring-status path is testable dry.
  const monitoringMarker = userText.includes('mock:monitoring') ? '\n\nCEZ:MONITORING' : '';
  // `mock:ask` → the reply ends with a valid CEZ:ASK marker (#473), so the
  // AskUser card path (park `waiting` + emit `ask.requested`) is testable dry.
  // `mock:ask-bad` → a MALFORMED marker (invalid JSON), to prove graceful
  // degradation: the run still parks `waiting`, no ask card, prose preserved.
  // `mock:ask-invalid` → syntactically valid JSON that FAILS the ask schema
  // (empty questions) — the shape behind the blank-question bug: no card will
  // ever render it, so the marker must survive in the v1 text.
  // `mock:ask-near` → bounded presentation drift: harmless extra keys plus
  // an overlong header/description. It should normalize into exactly one card.
  const askMarker = userText.includes('mock:ask-bad')
    ? '\n\nCEZ:ASK {not valid json'
    : userText.includes('mock:ask-invalid')
      ? '\n\nCEZ:ASK {"questions":[]}'
      : userText.includes('mock:ask-near')
        ? '\n\nCEZ:ASK ' +
          JSON.stringify({
            transportHint: 'render as chips',
            questions: [
              {
                header: 'Implementation path',
                question: 'Which implementation should I use?',
                presentation: 'compact',
                options: [
                  { label: 'Minimal', description: 'd'.repeat(300), recommended: true },
                  { label: 'Expanded', description: 'Touch the wider surface' },
                ],
              },
            ],
          })
      : userText.includes('mock:ask')
      ? '\n\nCEZ:ASK ' +
        JSON.stringify({
          questions: [
            {
              header: 'Library',
              question: 'Which date library should I standardize on?',
              options: [
                { label: 'date-fns', description: 'Tree-shakeable, functional' },
                { label: 'Luxon', description: 'Immutable, tz-aware' },
              ],
            },
          ],
        })
      : '';
  // `mock:refs` → the reply carries the in-band task-reference markers
  // (spec 2026-07-18-task-ref-markers), so the declaration path is testable dry.
  const refsMarkers = userText.includes('mock:refs')
    ? '\nCEZ:PR=4242\nCEZ:ISSUE=17\nCEZ:TITLE=implementing marker refs'
    : '';

  // `mock:slow` → hold the turn for ~25 s so queue states are observable.
  if (userText.includes('mock:slow')) await sleep(25_000);

  // Mirrors the real Claude Code 2.1.148 revoked-token envelope: the CLI puts
  // the credential failure in an `is_error` result even though its subtype is
  // `success`, rather than emitting a dedicated error frame.
  if (userText.includes('mock:auth-error')) {
    emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    });
    return;
  }

  // `mock:limit` → the envelope Claude Code emits when the subscription window is
  // exhausted: an `is_error` result whose text is the machine-readable
  // `Claude AI usage limit reached|<epoch seconds>` marker. Makes the auto-resume path
  // (spec 2026-08-03-auto-resume-after-usage-limit) reachable under CEZ_DRY_RUN=1 for QA and
  // the e2e smoke. `CEZ_MOCK_LIMIT_RESET_SECONDS` moves the reset instant (default 60 s out),
  // so a dry run can actually watch the resume fire instead of reading about it.
  if (userText.includes('mock:limit')) {
    const configured = Number(process.env.CEZ_MOCK_LIMIT_RESET_SECONDS ?? '60');
    const seconds = Number.isFinite(configured) ? configured : 60;
    emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + seconds}`,
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    });
    return;
  }

  // `mock:md` → answer with a markdown-rich reply (#346 QA: tables, nested
  // lists, emphasis, fences, quotes) instead of the scripted turn.
  if (userText.includes('mock:md')) {
    const md = [
      '## Markdown fixture',
      'This paragraph is soft-wrapped\nacross two source lines.',
      '',
      '| Column | Align | Result |',
      '|:-------|:-----:|-------:|',
      '| left `code` | *center* | **42** |',
      '| ~~old~~ new | mid | $1.50 |',
      '',
      '- top item with *emphasis*',
      '  - nested child with `code`',
      '    - [x] deep done task',
      '  - [ ] nested todo',
      '- second top',
      '',
      '> quoted intro',
      '> - quoted list item',
      '',
      '```ts',
      'const answer: number = 42;',
      '```',
      'Literal guards: snake_case_name, 2*3 and <script>alert(1)</script>.',
    ].join('\n');
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: md }], usage: { input_tokens: 100, output_tokens: 200 } },
    });
    await sleep(100);
    emit({ type: 'result', subtype: 'success', result: md, usage: { input_tokens: 100, output_tokens: 200 }, total_cost_usd: 0.001 });
    return;
  }

  // `mock:subagents` → a parallel fan-out: two `Task` spawns whose child items
  // carry `parent_tool_use_id`, interleaved the way a real fan-out interleaves,
  // then their results. Makes the Agents dock and its drill-down sheet reachable
  // under CEZ_DRY_RUN=1 for QA, screenshots and the e2e smoke (spec
  // `.ai/specs/2026-07-20-grouped-subagent-display.md` §"Testability hook", #474).
  // Derived from the `subagent-task.ndjson` golden fixture's wire shape.
  if (userText.includes('mock:subagents')) {
    const agents = [
      {
        id: `toolu_task_a_${turn}`,
        description: 'Audit the auth flow',
        subagent_type: 'general-purpose',
        steps: [
          { text: 'Scanning the auth middleware.' },
          { tool: 'Grep', id: `toolu_sub_a1_${turn}`, input: { pattern: 'session', path: 'src' }, result: 'src/middleware.ts:12:  clearSession()' },
          { tool: 'Read', id: `toolu_sub_a2_${turn}`, input: { file_path: 'src/middleware.ts' }, result: 'export function middleware() { clearSession() }' },
        ],
        result: 'The session cookie is dropped in src/middleware.ts:12 (clearSession on every redirect).',
      },
      {
        id: `toolu_task_b_${turn}`,
        description: 'Review the store layer',
        subagent_type: 'code-reviewer',
        steps: [
          { text: 'Reading the runs store.' },
          { tool: 'Bash', id: `toolu_sub_b1_${turn}`, input: { command: 'npm test -- runs/store' }, result: '12 passed' },
        ],
        result: 'Store layer looks correct; one debounce edge case worth a follow-up.',
      },
    ];

    // Both spawns first — that is what makes it a FAN-OUT rather than two
    // sequential agents, and what the dock's "N/M" odometer counts.
    for (const agent of agents) {
      emit({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: agent.id,
              name: 'Task',
              input: { description: agent.description, prompt: `${agent.description}.`, subagent_type: agent.subagent_type },
            },
          ],
          usage: { input_tokens: 900, output_tokens: 95 },
        },
        parent_tool_use_id: null,
      });
      await sleep(200);
    }

    // Children, interleaved across agents so the activity lines visibly race.
    const maxSteps = Math.max(...agents.map((agent) => agent.steps.length));
    for (let i = 0; i < maxSteps; i += 1) {
      for (const agent of agents) {
        const step = agent.steps[i];
        if (!step) continue;
        if (step.text !== undefined) {
          emit({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: step.text }], usage: { input_tokens: 300, output_tokens: 25 } },
            parent_tool_use_id: agent.id,
          });
        } else {
          emit({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: step.id, name: step.tool, input: step.input }],
              usage: { input_tokens: 40, output_tokens: 50 },
            },
            parent_tool_use_id: agent.id,
          });
          await sleep(250);
          emit({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: step.id, content: step.result }] },
            parent_tool_use_id: agent.id,
          });
        }
        await sleep(250);
      }
    }

    // The spawns settle — `parent_tool_use_id: null`, they belong to the main turn.
    for (const agent of agents) {
      emit({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agent.id, content: agent.result }] },
        parent_tool_use_id: null,
      });
      await sleep(200);
    }

    const summary = 'Both sub-agents reported back: the redirect drops the cookie in src/middleware.ts:12, and the store layer is clean. (dry-run mock)';
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: summary }], usage: { input_tokens: 400, output_tokens: 60 } },
      parent_tool_use_id: null,
    });
    await sleep(150);
    emit({
      type: 'result',
      subtype: 'success',
      result: summary,
      usage: { input_tokens: 2100, output_tokens: 380 },
      total_cost_usd: 0.0512,
    });
    return;
  }

  // Task auto-naming spec: a naming call (marked `[cez-namer]`) answers a
  // deterministic short title + a PR classification of the sample number so
  // dry-run tests can assert the full apply pipeline.
  if (userText.includes('[cez-namer]')) {
    const numbered = /(?:^|\D)(\d{1,7})(?:\D|$)/.exec(userText);
    const name = JSON.stringify({
      title: 'implementing cr fixes',
      ...(numbered ? { pr: Number(numbered[1]) } : {}),
    });
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: name }],
        usage: { input_tokens: 200, output_tokens: 30 },
      },
    });
    await sleep(50);
    emit({
      type: 'result',
      subtype: 'success',
      result: name,
      usage: { input_tokens: 200, output_tokens: 30 },
      total_cost_usd: 0.0002,
    });
    return;
  }

  // Spec 008: a planning call (marked `[cez-planner]` in the user prompt)
  // gets a canned chain plan. The `code-review` skill is deliberately made up:
  // the planner's sanitizer strips unknown skills, and the step survives on
  // its prompt — which is exactly the path worth exercising in dry runs.
  if (userText.includes('[cez-planner]')) {
    const plan = JSON.stringify({
      title: 'implement-verify-review',
      steps: [
        { name: 'Implement', prompt: '{{task}}' },
        { name: 'Verify', command: 'npm test' },
        { name: 'Review', skill: 'code-review', prompt: 'Review the changes for {{task}}' },
      ],
      rationale: 'Implement, verify with tests, then review.',
    });
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: plan }],
        usage: { input_tokens: 500, output_tokens: 120 },
      },
    });
    await sleep(100);
    emit({
      type: 'result',
      subtype: 'success',
      result: plan,
      usage: { input_tokens: 500, output_tokens: 120 },
      total_cost_usd: 0.0011,
    });
    return;
  }

  if (turn === 1) {
    // Leave a visible trace in the cwd (the task worktree under spec 006) so
    // the Diff view has something real to show in dry runs. Exactly one line
    // per spawned session: tests read this file back as a per-step trace, so
    // a multi-line prompt must not become multiple lines here.
    try {
      const head = userText.replace(/\s+/g, ' ').trim().slice(0, 400);
      appendFileSync('notes.md', `mock notes — ${new Date().toISOString()}: ${head}\n`);
    } catch {
      // read-only cwd — the mock still works, just without a diff
    }
    writeHandoffAndTodo();
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Okay — looking into: ${userText.slice(0, 120)}` }],
        usage: { input_tokens: 850, output_tokens: 40 },
      },
    });
    await sleep(300);
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_mock_${turn}`, name: 'Bash', input: { command: 'git status --short' } }],
        usage: { input_tokens: 120, output_tokens: 55 },
      },
    });
    await sleep(300);
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `toolu_mock_${turn}`, content: ' M src/example.ts' }],
      },
    });
    await sleep(200);
    // Agent screenshot in a tool result — exercises the image pipeline
    // (persist to <id>-images/, serve via /api/runs/:id/images/, zoomable
    // card + lightbox in the transcript).
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_mock_shot_${turn}`, name: 'Screenshot', input: { name: 'repro-login-redirect.png' } }],
        usage: { input_tokens: 80, output_tokens: 30 },
      },
    });
    await sleep(200);
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `toolu_mock_shot_${turn}`,
            content: [
              { type: 'text', text: 'Repro captured: after reload the session toast appears and you are back on /login.' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: MOCK_SCREENSHOT_B64 } },
            ],
          },
        ],
      },
    });
    await sleep(300);
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Done with the first pass — opened a draft PR: https://github.com/open-mercato/demo/pull/123. Anything to adjust? (dry-run mock)${refsMarkers}${doneMarker}${monitoringMarker}${askMarker}` }],
        usage: { input_tokens: 300, output_tokens: 90 },
      },
    });
    await sleep(150);
    emit({
      type: 'result',
      subtype: 'success',
      result: 'Done with the first pass (dry run).',
      usage: { input_tokens: 1270, output_tokens: 185 },
      total_cost_usd: 0.0342,
    });
    return;
  }

  const imgNote = imageCount > 0 ? ` I can see ${imageCount} image(s) you attached.` : '';
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `Follow-up #${turn - 1} received: "${userText.slice(0, 100)}".${imgNote} Applied (dry run).${refsMarkers}${doneMarker}${monitoringMarker}${askMarker}` }],
      usage: { input_tokens: 200, output_tokens: 60 },
    },
  });
  await sleep(150);
  emit({
    type: 'result',
    subtype: 'success',
    result: `Follow-up #${turn - 1} handled (dry run).`,
    usage: { input_tokens: 200, output_tokens: 60 },
    total_cost_usd: 0.0051,
  });
}

const rl = createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let userText = '(unparseable message)';
  let imageCount = 0;
  try {
    const msg = JSON.parse(trimmed);
    const blocks = msg?.message?.content ?? [];
    userText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || '(no text)';
    imageCount = blocks.filter((b) => b.type === 'image').length;
  } catch {
    // keep placeholders
  }
  // Testability hook: CEZ_MOCK_STDIN_FILE=<path> appends the FULL inbound
  // text + image count (one JSON object per line) — the scripted replies
  // below only echo a truncated slice, so tests asserting exact wiring (e.g.
  // #357's pasted-attachment path note in the prompt) need the untruncated
  // text this hook captures.
  if (process.env.CEZ_MOCK_STDIN_FILE) {
    try {
      appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText, imageCount })}\n`);
    } catch {
      // best effort — never break the mock over the hook
    }
  }
  queue = queue.then(() => respond(userText, imageCount));
});
rl.on('close', () => {
  // EOF = session over; finish any in-flight turn then exit cleanly.
  queue.then(() => process.exit(0));
});
