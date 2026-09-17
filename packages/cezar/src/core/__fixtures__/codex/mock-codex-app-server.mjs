#!/usr/bin/env node
// Test-only mock of `codex app-server` — speaks just enough JSON-RPC 2.0
// JSONL (§3 of agent-event-protocols.md) for the runner wiring test in
// `codex-ui-mapper.test.ts`: initialize/thread/turn handshake, one scripted
// turn with an agentMessage + a commandExecution (with live outputDelta),
// cumulative token usage, then exits on stdin EOF like the real server.
//
// `MOCK_CODEX_IGNORE_EOF=1` switches to the #703 teardown shape instead: the
// server stays deaf to stdin EOF (the CLI hang the EOF watchdog exists for)
// and handles SIGTERM itself, exiting 143 rather than dying from the signal.
import { createInterface } from 'node:readline';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const rl = createInterface({ input: process.stdin });

/**
 * #955 — the context-compaction boundary, as a scripted app-server sequence.
 *
 * The shape a long Codex task hits when it crosses the model's context window:
 * the turn's LAST act is a completed `contextCompaction` item, then
 * `turn/completed`, with no assistant message after it. NO redacted Luna trace
 * was obtainable while this fixture was written, so it is built from the
 * documented wire contract (`agent-event-protocols.md` §3/§7.1 — the same source
 * the mapper cites — the frames this mock already speaks, and the item ordering
 * in the reporter's screenshot) — and it
 * scripts ALL THREE post-compaction follow-up shapes #955 enumerates as open
 * questions, so the chosen policy is pinned under every one of them rather than
 * betting on the unverified one:
 *
 *   mock:compaction          turn 1 compaction-ends; turn 2 works and finishes
 *   mock:compaction-hold     turn 1 compaction-ends; turn 2 opens and never ends
 *   mock:compaction-repeat   EVERY turn compaction-ends (the spin the bound exists for)
 *   mock:compaction-reject   turn 1 compaction-ends; the next `turn/start` is REFUSED
 *   mock:compaction-done     the turn emits CEZ:DONE and THEN compacts
 *   mock:compaction-monitor  the turn emits CEZ:MONITORING and THEN compacts
 *   mock:compaction-badask   the turn emits a MALFORMED CEZ:ASK and THEN compacts
 *   mock:child-compaction    a CHILD thread compacts and ends its turn; the parent works on
 *   mock:steer-reject        the turn stays open, so a follow-up steers — and is REFUSED
 *
 * The continuation cezar sends after a boundary carries no `mock:` marker, so
 * the scenario is latched from the opening turn rather than re-read per turn.
 */
const COMPACTION_SCENARIOS = ['hold', 'repeat', 'reject', 'done', 'monitor', 'badask'];
let scenario = '';
let turnSeq = 0;

/** The prose (if any) this scenario emits BEFORE the compaction item. */
function compactionPrelude(kind) {
  if (kind === 'done') return 'Everything is in place.\n\nCEZ:DONE';
  if (kind === 'monitor') return 'Kicked the build off.\n\nCEZ:MONITORING';
  // Malformed on purpose: it raises no card, so a continuation would bury the question.
  if (kind === 'badask') return 'Which database should I use?\n\nCEZ:ASK not-json';
  return 'Halfway through the refactor — three files still to go.';
}

/** One turn whose last act is a completed `contextCompaction`, then `turn/completed`. */
function emitCompactionTurn(turnId, kind) {
  const text = compactionPrelude(kind);
  const messageId = `item_m_${turnId}`;
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: messageId, text: '' } } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId, itemId: messageId, delta: text } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: messageId, text } } });
  const compactionId = `item_cc_${turnId}`;
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item: { type: 'contextCompaction', id: compactionId, status: 'inProgress' } } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'contextCompaction', id: compactionId, status: 'completed' } } });
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: turnId, status: 'completed' } } });
}

/** The recovered turn: real work after the boundary, ending on the completion marker. */
function emitRecoveredTurn(turnId) {
  const text = 'Refactor finished and the suite is green.\n\nCEZ:DONE';
  const messageId = `item_m_${turnId}`;
  emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: messageId, text: '' } } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId, itemId: messageId, delta: text } });
  emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: messageId, text } } });
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: turnId, status: 'completed' } } });
}

const ignoreEof = process.env.MOCK_CODEX_IGNORE_EOF === '1';
if (ignoreEof) {
  process.on('SIGTERM', () => process.exit(143));
  // Keep the event loop alive so EOF alone can never end the process.
  setInterval(() => {}, 60_000);
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 'ask-1' && msg.result) {
    const answer = msg.result.answers?.library?.answers;
    const freeText = msg.result.answers?.first?.answers;
    emit((Array.isArray(answer) && answer[0] === 'Vitest') || (Array.isArray(freeText) && freeText[0] === 'Use sensible defaults')
      ? { method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } }
      : { method: 'turn/failed', params: { turn: { id: 'turn_mock_1', status: 'failed' }, error: { message: 'bad answer' } } });
  } else if (msg.method === 'initialize') {
    emit({ id: msg.id, result: { userAgent: 'mock-codex/0.0.0' } });
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const expectedSandbox = process.env.CEZ_CODEX_NETWORK === '0' ? 'workspace-write' : 'danger-full-access';
    if (msg.params?.sandbox !== expectedSandbox || msg.params?.approvalPolicy !== 'never') {
      emit({ id: msg.id, error: { code: -32602, message: `expected ${expectedSandbox} auto permissions` } });
      return;
    }
    if (process.argv.includes('sandbox_workspace_write.network_access=true')) {
      emit({ id: msg.id, error: { code: -32602, message: 'workspace-write override is obsolete in full-access mode' } });
      return;
    }
    if (msg.method === 'thread/start') {
      emit({ method: 'thread/started', params: { thread: { id: 'th_mock_1' } } });
      emit({ id: msg.id, result: { thread: { id: 'th_mock_1' } } });
    } else if (process.env.MOCK_CODEX_REJECT_RESUME === '1') {
      emit({ id: msg.id, error: { code: -32603, message: `no rollout found for thread id ${msg.params?.threadId ?? ''}` } });
      rl.close();
    } else {
      emit({ id: msg.id, result: { thread: { id: msg.params?.threadId } } });
    }
  } else if (msg.method === 'turn/steer') {
    // A follow-up delivered INTO a live turn. `mock:steer-reject` refuses it after stdin
    // already accepted the message — the second half of #955's silent-zombie shape.
    // `mock:steer-silent` never answers at all, so the request is still in flight when
    // cezar tears the session down and `rejectPending` settles it.
    if (scenario === 'steer-silent') return;
    if (scenario === 'steer-reject') {
      emit({ id: msg.id, error: { code: -32602, message: 'expectedTurnId does not match the active turn' } });
      return;
    }
    emit({ id: msg.id, result: {} });
  } else if (msg.method === 'turn/start') {
    const turnText = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
    turnSeq += 1;
    if (turnSeq === 1) {
      if (turnText.includes('mock:steer-reject')) scenario = 'steer-reject';
      else if (turnText.includes('mock:steer-silent')) scenario = 'steer-silent';
      else if (turnText.includes('mock:compaction')) {
        scenario = COMPACTION_SCENARIOS.find((kind) => turnText.includes(`mock:compaction-${kind}`)) ?? 'once';
      }
    }
    // The refused follow-up: the app-server takes the frame off stdin and answers with a
    // JSON-RPC error instead of opening a turn. Nothing else is emitted — the rejection is
    // the whole event, which is exactly why it used to vanish into a quiet note (#955).
    if (scenario === 'reject' && turnSeq > 1) {
      emit({ id: msg.id, error: { code: -32603, message: 'thread is busy compacting context' } });
      return;
    }
    const turnId = scenario ? `turn_mock_${turnSeq}` : 'turn_mock_1';
    emit({ id: msg.id, result: { turn: { id: turnId } } });
    emit({ method: 'turn/started', params: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (scenario === 'steer-reject' || scenario === 'steer-silent') {
      // The turn stays OPEN (no turn/completed), so the next message steers it. The message
      // item IS completed, so the v1 `text` event fires and a test can wait on real output.
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: 'item_sr', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId, itemId: 'item_sr', delta: 'Working on it.' } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: 'item_sr', text: 'Working on it.' } } });
      return;
    }
    if (scenario) {
      // `repeat` never recovers; `hold` opens turn 2 and never ends it; every other
      // scenario compaction-ends turn 1 and then works normally.
      if (scenario === 'repeat' || turnSeq === 1) {
        emitCompactionTurn(turnId, scenario);
      } else if (scenario === 'hold') {
        emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: `item_h_${turnId}`, text: '' } } });
        emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId, itemId: `item_h_${turnId}`, delta: 'Picking the refactor back up.' } });
      } else {
        emitRecoveredTurn(turnId);
      }
      return;
    }
    if (turnText.includes('mock:child-compaction')) {
      // A sub-agent CHILD thread compacts ITS context and ends ITS turn. Neither the item
      // nor the turn boundary may reach the parent's lifecycle (#600 + #955): the parent is
      // still working, and a child's maintenance is not the parent's turn ending.
      emit({ method: 'turn/started', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'inProgress', items: [] } } });
      emit({ method: 'item/started', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'contextCompaction', id: 'item_cc_child', status: 'inProgress' } } });
      emit({ method: 'item/completed', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'contextCompaction', id: 'item_cc_child', status: 'completed' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'completed' } } });
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: 'item_pc1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId, itemId: 'item_pc1', delta: 'Still working after the sub-agent compacted.' } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: 'item_pc1', text: 'Still working after the sub-agent compacted.' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: turnId, status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:turn-failed')) {
      emit({ method: 'turn/failed', params: {
        turn: { id: 'turn_mock_1', status: 'failed' },
        error: { message: 'model unavailable' },
      } });
      return;
    }
    if (turnText.includes('mock:subagent-activity')) {
      emit({ method: 'item/started', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/completed', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/started', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'inProgress', receiverThreadIds: [] } } });
      emit({ method: 'item/completed', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'completed', receiverThreadIds: [] } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:child-turn')) {
      // A spawned sub-agent runs in its OWN child thread that emits a full turn
      // lifecycle over the shared connection. Its turn/completed must not end the
      // parent turn (#600): the parent is still working after the child finishes.
      emit({ method: 'turn/started', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'inProgress', items: [] } } });
      emit({ method: 'item/started', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'commandExecution', id: 'item_child', command: ['rg', 'requestUserInput'], cwd: '/repo', status: 'inProgress' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'completed' } } });
      // Parent keeps streaming after the child's turn ended.
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_p1', delta: 'Still working after the sub-agent.' } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: 'Still working after the sub-agent.' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (process.env.MOCK_CODEX_ASK === '1' || turnText.includes('mock:native-codex-ask')) {
      const questions = turnText.includes('multi free text')
        ? [{ id: 'first', header: 'First', question: 'First choice?', isOther: true, isSecret: false,
            options: [{ label: 'A', description: 'Option A.' }, { label: 'B', description: 'Option B.' }] },
          { id: 'second', header: 'Second', question: 'Second choice?', isOther: true, isSecret: false,
            options: [{ label: 'C', description: 'Option C.' }, { label: 'D', description: 'Option D.' }] }]
        : [{ id: 'library', header: 'Library', question: 'Which test library?', isOther: true,
            isSecret: false, options: [{ label: 'Vitest', description: 'Use the existing test runner.' },
              { label: 'Node test', description: 'Use node:test.' }] }];
      emit({ id: 'ask-1', method: 'item/tool/requestUserInput', params: {
        threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_ask_1', autoResolutionMs: null,
        questions,
      } });
      return;
    }
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: '' } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_m1', delta: 'Checking the working tree.' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: 'Checking the working tree.' } } });
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'inProgress' } } });
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_c1', delta: ' M src/example.ts\n' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 }, last: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } } } });
    emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  }
});

rl.on('close', () => {
  if (!ignoreEof) process.exit(0);
});
