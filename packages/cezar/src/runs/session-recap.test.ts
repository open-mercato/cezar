import { describe, expect, it } from 'vitest';
import type { RunEvent } from './store.ts';
import { buildSessionRecap } from './session-recap.ts';

const event = (seq: number, type: string, extra: Record<string, unknown> = {}): RunEvent => ({
  seq,
  ts: `2026-09-11T10:00:0${seq}.000Z`,
  type,
  ...extra,
});

describe('buildSessionRecap — the briefing a non-resumable Continue opens on', () => {
  it('carries the original task, so a fresh session knows what it was asked to do', () => {
    const recap = buildSessionRecap({ task: 'Fix the login redirect', events: [] });
    expect(recap).toContain('## Previous session (cezar)');
    expect(recap).toContain('Fix the login redirect');
    // The agent must not mistake replayed history for its own memory.
    expect(recap).toContain('NEW session');
  });

  /** The reported shape: cezar died while the run queued for the worktree lock, so there is a
   *  task and an error and literally nothing else. It still has to produce a usable briefing. */
  it('says so plainly when the session ended before the agent said anything', () => {
    const recap = buildSessionRecap({
      task: 'Fix the login redirect',
      error: 'interrupted — cezar process exited during the run',
      events: [event(1, 'lifecycle', { message: 'run started' })],
    });
    expect(recap).toContain('interrupted — cezar process exited during the run');
    expect(recap).toContain('Nothing was exchanged');
  });

  it('replays user and agent messages in order, labelled, and ignores everything else', () => {
    const recap = buildSessionRecap({
      task: 'Fix the login redirect',
      events: [
        event(1, 'lifecycle', { message: 'run started' }),
        event(2, 'text', { text: 'Looking at the middleware.' }),
        event(3, 'tool', { name: 'Bash' }),
        event(4, 'user-message', { text: 'check the cookie flags too' }),
        event(5, 'text', { text: 'SameSite is the culprit.' }),
      ],
      // A briefing is not a log: lifecycle lines and tool calls are noise here.
    });
    const body = recap.slice(recap.indexOf('**Conversation so far**'));
    expect(body).toContain('[agent] Looking at the middleware.');
    expect(body).toContain('[user] check the cookie flags too');
    expect(body).toContain('[agent] SameSite is the culprit.');
    expect(body).not.toContain('run started');
    expect(body).not.toContain('Bash');
    expect(body.indexOf('[user] check')).toBeGreaterThan(body.indexOf('[agent] Looking'));
  });

  /** The engine appends one `text` event per streamed chunk, so an un-coalesced replay would
   *  read as a stutter of one-line agent turns rather than as a conversation. */
  it('joins the chunks of one agent turn back into a single message', () => {
    const recap = buildSessionRecap({
      task: 't',
      events: [event(1, 'text', { text: 'First half.' }), event(2, 'text', { text: 'Second half.' })],
    });
    expect(recap).toContain('[agent] First half.\nSecond half.');
    expect(recap.match(/\[agent\]/g)).toHaveLength(1);
  });

  it('skips empty and non-string text rather than emitting blank speakers', () => {
    const recap = buildSessionRecap({
      task: 't',
      events: [event(1, 'text', { text: '   ' }), event(2, 'user-message', { text: 42 })],
    });
    expect(recap).toContain('Nothing was exchanged');
  });

  it('clips one runaway message instead of letting it evict the rest', () => {
    const recap = buildSessionRecap(
      { task: 't', events: [event(1, 'text', { text: 'x'.repeat(500) }), event(2, 'user-message', { text: 'and then?' })] },
      { maxMessageChars: 50 },
    );
    expect(recap).toContain('…[truncated]');
    expect(recap).toContain('[user] and then?');
    expect(recap).not.toContain('x'.repeat(51));
  });

  /** Over budget, the END of a conversation is what survives: that is where the unfinished work
   *  is, and the opening is the part the task text already restates. */
  it('drops the oldest messages first and says how many it dropped', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      event(i + 1, i % 2 === 0 ? 'text' : 'user-message', { text: `message ${i}` }),
    );
    const recap = buildSessionRecap({ task: 't', events }, { maxChars: 60 });
    expect(recap).toContain('message 9');
    expect(recap).not.toContain('message 0');
    expect(recap).toMatch(/…\d earlier messages omitted…/);
  });

  it('omits the omission note when nothing was dropped', () => {
    const recap = buildSessionRecap({ task: 't', events: [event(1, 'text', { text: 'short' })] });
    expect(recap).not.toContain('omitted');
  });

  it('never claims an error the record does not carry', () => {
    const recap = buildSessionRecap({ task: 't', error: '   ', events: [] });
    expect(recap).not.toContain('How the previous session ended');
  });
});
