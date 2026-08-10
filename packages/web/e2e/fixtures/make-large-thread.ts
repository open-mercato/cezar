/**
 * The synthetic LARGE transcript for the virtualization e2e (thread-scroll.e2e.ts): a
 * legitimate synthetic load, never fake product data — every line reuses the verbatim wire
 * shapes of `thread-run.ndjson` (an R2 dry-run's real output: v2 `turn.*`/`item.*` events
 * with their v1 twins on one `seq` clock), repeated across enough turns to push the thread
 * far past the ~300-row virtualization threshold.
 *
 * Shape per turn (rows it becomes): a v1 `user-message` (bubble) → an assistant message item
 * (+ v1 `text` twin, deduped by the reducer) → a completed Bash execute item (+ v1
 * `tool-call`/`tool-result` twins) → a `$ …` note line → `turn.completed`. Four rendered rows
 * per turn; the run's own `task` bubble and the leading lifecycle/step lines add a few more.
 */

interface Line {
  type: string
  [key: string]: unknown
}

export function largeThreadEvents(turnCount: number): Array<Line & { seq: number; ts: string }> {
  const lines: Line[] = [
    { type: 'lifecycle', message: 'run started — workflow "quick-task" (runner: claude)' },
    { type: 'note', message: 'worktree ready — branch cez/1a2b3c4d (base main)' },
    { type: 'step-start', stepId: 'task', name: 'Do the task', kind: 'agent', iteration: 1 },
    { type: 'session.started', sessionId: 'a0000000-0000-4000-8000-000000000001', backend: 'claude', stepId: 'task' },
  ]

  for (let turn = 1; turn <= turnCount; turn += 1) {
    const command = `git log --oneline -${turn}`
    const output = Array.from({ length: 4 }, (_, i) => `commit-${turn}-${i} touch file-${turn}.ts`).join('\n')
    const messageText = `Pass ${turn}: inspected the history window and summarized ${turn} commits.`
    lines.push(
      // The engine writes every follow-up as a v1 user-message line before the v2 turn opens.
      ...(turn > 1
        ? [{ type: 'user-message', stepId: 'task', text: `Keep going — pass ${turn}.`, imageCount: 0 }]
        : []),
      { type: 'turn.started', turnId: `turn_${turn}`, stepId: 'task' },
      {
        type: 'item.completed',
        item: { kind: 'message', id: `item_msg_${turn}`, role: 'assistant', text: messageText },
        stepId: 'task',
      },
      { type: 'text', text: messageText, stepId: 'task' }, // the v1 twin (dedup path)
      { type: 'tool-call', id: `toolu_${turn}`, tool: 'Bash', input: { command }, stepId: 'task' },
      {
        type: 'item.completed',
        item: {
          kind: 'tool',
          id: `toolu_${turn}`,
          name: 'Bash',
          toolKind: 'execute',
          title: `Ran ${command}`,
          status: 'completed',
          input: { command },
          output,
        },
        stepId: 'task',
      },
      { type: 'tool-result', toolCallId: `toolu_${turn}`, result: output, isError: false, stepId: 'task' },
      { type: 'note', stepId: 'task', message: `$ ${command}` },
      {
        type: 'turn.completed',
        turnId: `turn_${turn}`,
        stopReason: 'end_turn',
        usage: { input: 100, output: 50, total: 150 },
        costUsd: 0.001,
        stepId: 'task',
      },
      { type: 'token-usage', tokensUsed: turn * 150, stepId: 'task' },
    )
  }

  lines.push(
    { type: 'session.ended', reason: 'end_turn', stepId: 'task' },
    { type: 'step-end', stepId: 'task', status: 'done' },
    { type: 'lifecycle', message: 'goal achieved — session closed' },
  )

  const start = Date.parse('2026-07-14T20:00:00.000Z')
  return lines.map((line, index) => ({
    ...line,
    seq: index + 1,
    ts: new Date(start + index * 25).toISOString(),
  }))
}

/** How many thread rows the transcript renders: task bubble + the leading dim lines + per
 *  turn (bubble from turn 2 on, message, tool card, note). Kept next to the generator so the
 *  e2e's DOM-count assertions state their expectation instead of re-deriving it. */
export function expectedRowCount(turnCount: number): number {
  const leading = 1 /* task bubble */ + 2 /* lifecycle + worktree notes */
  const perTurn = 4 // user bubble + assistant message + tool card + `$ …` note
  const trailing = 1 // 'goal achieved' lifecycle line
  return leading + perTurn * turnCount - 1 /* turn 1 has no user bubble */ + trailing
}
