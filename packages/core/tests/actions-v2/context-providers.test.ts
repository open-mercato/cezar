import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { formatOpenIssuesKb } from '../../src/actions-v2/context-providers.js';
import { runAction } from '../../src/actions-v2/runner.js';
import type { ActionDef } from '../../src/actions-v2/action.js';
import type { ActionTarget } from '../../src/actions-v2/runner.js';
import type { EffectContext } from '../../src/actions-v2/effects.js';
import type { GitHubService } from '../../src/services/github.service.js';

// ─── formatOpenIssuesKb ─────────────────────────────────────────────────────

describe('formatOpenIssuesKb', () => {
  it('returns the empty string for an empty list', () => {
    expect(formatOpenIssuesKb([])).toBe('');
  });

  it('renders the section header and one line per issue', () => {
    const out = formatOpenIssuesKb([
      { number: 12, title: 'Login fails on Safari', summary: 'Auth cookie rejected.' },
      { number: 7, title: 'Add dark mode' },
    ]);
    expect(out.startsWith('## Open-issue knowledge base')).toBe(true);
    expect(out).toContain('- #12 — Login fails on Safari: Auth cookie rejected.');
    // No summary → no trailing colon segment.
    expect(out).toContain('- #7 — Add dark mode');
    expect(out).not.toContain('- #7 — Add dark mode:');
  });

  it('omits the summary segment for null/empty summaries', () => {
    const out = formatOpenIssuesKb([
      { number: 1, title: 'A', summary: null },
      { number: 2, title: 'B', summary: '' },
      { number: 3, title: 'C', summary: '   ' },
    ]);
    expect(out).toContain('- #1 — A');
    expect(out).toContain('- #2 — B');
    expect(out).toContain('- #3 — C');
    expect(out).not.toContain(':');
  });

  it('collapses summary whitespace to one line and clips to ~300 chars', () => {
    const long = `line one\n\nline two ${'x'.repeat(400)}`;
    const out = formatOpenIssuesKb([{ number: 5, title: 'T', summary: long }]);
    const line = out.split('\n').find((l) => l.startsWith('- #5'))!;
    expect(line).toContain('line one line two');
    expect(line).not.toContain('\r');
    // header is excluded — the issue line itself carries the clipped summary + ellipsis
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThanOrEqual('- #5 — T: '.length + 301);
  });

  it('caps the list and appends an omitted-count line', () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
    }));
    const out = formatOpenIssuesKb(issues, { cap: 5 });
    expect(out).toContain('- #5 — Issue 5');
    expect(out).not.toContain('- #6 — Issue 6');
    expect(out).toContain('…and 2 more open issues (omitted)');
  });

  it('emits no omitted line when the list fits within the cap', () => {
    const out = formatOpenIssuesKb([{ number: 1, title: 'A' }], { cap: 5 });
    expect(out).not.toContain('omitted');
  });
});

// ─── runner context injection ───────────────────────────────────────────────

/** Minimal fake Anthropic client: captures `messages.create` args and returns
 *  a text-only response (no tool calls → the tool-use loop ends immediately). */
function fakeAnthropic(): {
  client: Anthropic;
  calls: Array<{ messages: Array<{ role: string; content: unknown }> }>;
} {
  const calls: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const client = {
    messages: {
      create: async (args: { messages: Array<{ role: string; content: unknown }> }) => {
        calls.push(args);
        return {
          content: [{ type: 'text', text: 'done — no changes needed' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function makeAction(overrides: Partial<ActionDef> = {}): ActionDef {
  return {
    id: '',
    workspaceId: '',
    name: 'auto-triage',
    kind: 'built-in',
    description: null,
    systemPrompt: 'Triage the issue.',
    skillRefs: [],
    target: 'issue',
    triggers: ['manual'],
    effects: null,
    outputSchema: null,
    enabled: true,
    ...overrides,
  };
}

const target: ActionTarget = {
  kind: 'issue',
  number: 42,
  title: 'Crash on save',
  body: 'It crashes.',
  state: 'open',
  labels: [],
  htmlUrl: 'https://github.com/o/r/issues/42',
};

const effectCtx: EffectContext = {
  github: {} as GitHubService,
  targetNumber: 42,
};

function firstUserMessage(
  calls: Array<{ messages: Array<{ role: string; content: unknown }> }>,
): string {
  expect(calls.length).toBeGreaterThan(0);
  const msg = calls[0].messages[0];
  expect(msg.role).toBe('user');
  return msg.content as string;
}

describe('runAction context injection', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('appends declared context sections to the user message', async () => {
    const { client, calls } = fakeAnthropic();
    const section = '## Open-issue knowledge base\n\n- #12 — Login fails on Safari';
    const result = await runAction(makeAction({ contextRefs: ['open-issues'] }), target, {
      skills: [],
      anthropic: client,
      effectCtx,
      contextProviders: { 'open-issues': async () => section },
    });

    expect(result.text).toBe('done — no changes needed');
    const userMessage = firstUserMessage(calls);
    expect(userMessage).toContain('Issue #42 — Crash on save');
    expect(userMessage).toContain(section);
    // The section lands after the target, separated by a blank line.
    expect(userMessage.indexOf('## Open-issue knowledge base')).toBeGreaterThan(
      userMessage.indexOf('It crashes.'),
    );
  });

  it('skips empty provider results without appending a blank section', async () => {
    const { client, calls } = fakeAnthropic();
    await runAction(makeAction({ contextRefs: ['open-issues'] }), target, {
      skills: [],
      anthropic: client,
      effectCtx,
      contextProviders: { 'open-issues': async () => '' },
    });
    const userMessage = firstUserMessage(calls);
    expect(userMessage).not.toContain('Open-issue knowledge base');
    expect(userMessage.endsWith('It crashes.')).toBe(true);
  });

  it('still runs the action when a provider throws — no section appended', async () => {
    const { client, calls } = fakeAnthropic();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runAction(makeAction({ contextRefs: ['open-issues'] }), target, {
        skills: [],
        anthropic: client,
        effectCtx,
        contextProviders: {
          'open-issues': async () => {
            throw new Error('db unavailable');
          },
        },
      });
      expect(result.text).toBe('done — no changes needed');
      expect(firstUserMessage(calls)).not.toContain('Open-issue knowledge base');
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not call providers for refs the action did not declare', async () => {
    const { client, calls } = fakeAnthropic();
    const provider = vi.fn(async () => '## Open-issue knowledge base\n\n- #1 — A');
    await runAction(makeAction({ contextRefs: undefined }), target, {
      skills: [],
      anthropic: client,
      effectCtx,
      contextProviders: { 'open-issues': provider },
    });
    expect(provider).not.toHaveBeenCalled();
    expect(firstUserMessage(calls)).not.toContain('Open-issue knowledge base');
  });

  it('silently skips declared refs that have no provider', async () => {
    const { client, calls } = fakeAnthropic();
    const result = await runAction(makeAction({ contextRefs: ['open-issues'] }), target, {
      skills: [],
      anthropic: client,
      effectCtx,
    });
    expect(result.text).toBe('done — no changes needed');
    expect(firstUserMessage(calls)).not.toContain('Open-issue knowledge base');
  });
});
