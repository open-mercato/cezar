import { describe, expect, it } from 'vitest';
import { createModelProber, probeKey, type ProbeTransport } from './probe.js';

/**
 * Readiness probing (2026-07-25). The defect this exists to prevent: a council
 * run reported every reviewer "ready" while the opencode transport 500'd on
 * the very first prompt — because "ready" only ever meant "a credential/binary
 * is present", and cezar's own preflight hardcoded it besides.
 *
 * The contract under test: a verdict means a COMPLETED ROUND-TRIP on the exact
 * transport the run will use. Presence is not readiness.
 */

function recorder(verdicts: Record<string, Awaited<ReturnType<ProbeTransport>>>) {
  const calls: string[] = [];
  const transport: ProbeTransport = async (ref) => {
    const key = probeKey(ref);
    calls.push(key);
    return verdicts[key] ?? { status: 'ready', detail: 'ok' };
  };
  return { calls, transport };
}

describe('createModelProber', () => {
  it('reports a transport that fails the round-trip as failed, with the concrete reason', async () => {
    const { transport } = recorder({
      'opencode/opencode/mimo-v2.5-free': {
        status: 'failed',
        detail: 'POST /session/x/message → 500 no such column: replacement_seq',
      },
    });
    const prober = createModelProber({ transport });

    const verdict = await prober.probe({ runner: 'opencode', model: 'opencode/mimo-v2.5-free' });

    expect(verdict.status).toBe('failed');
    expect(verdict.detail).toContain('replacement_seq');
  });

  it('never reports ready from credential presence alone — the round-trip decides', async () => {
    const { transport, calls } = recorder({
      'opencode/opencode/glm-5.2': { status: 'failed', detail: 'server 500' },
    });
    const prober = createModelProber({ transport });

    const verdict = await prober.probe({ runner: 'opencode', model: 'opencode/glm-5.2' });

    expect(calls).toEqual(['opencode/opencode/glm-5.2']);
    expect(verdict.status).toBe('failed');
  });

  it('caches a verdict per model for the TTL so back-to-back runs do not repay it', async () => {
    const { transport, calls } = recorder({});
    let now = 1_000;
    const prober = createModelProber({ transport, ttlMs: 10_000, now: () => now });

    await prober.probe({ runner: 'codex', model: 'gpt-5.6-sol' });
    await prober.probe({ runner: 'codex', model: 'gpt-5.6-sol' });
    expect(calls).toHaveLength(1);

    now += 10_001; // TTL elapsed
    await prober.probe({ runner: 'codex', model: 'gpt-5.6-sol' });
    expect(calls).toHaveLength(2);
  });

  it('caches per model, not globally — a healthy model never masks a broken one', async () => {
    const { transport, calls } = recorder({
      'opencode/opencode/mimo-v2.5-free': { status: 'failed', detail: 'server 500' },
    });
    const prober = createModelProber({ transport });

    const codex = await prober.probe({ runner: 'codex', model: 'gpt-5.6-sol' });
    const mimo = await prober.probe({ runner: 'opencode', model: 'opencode/mimo-v2.5-free' });

    expect(codex.status).toBe('ready');
    expect(mimo.status).toBe('failed');
    expect(calls).toEqual(['codex/gpt-5.6-sol', 'opencode/opencode/mimo-v2.5-free']);
  });

  it('does not cache failures as long as successes — a fixed transport recovers promptly', async () => {
    let status: 'ready' | 'failed' = 'failed';
    const calls: string[] = [];
    const transport: ProbeTransport = async (ref) => {
      calls.push(ref.model);
      return { status, detail: status === 'failed' ? 'server 500' : 'ok' };
    };
    let now = 1_000;
    const prober = createModelProber({ transport, ttlMs: 600_000, failureTtlMs: 5_000, now: () => now });

    expect((await prober.probe({ runner: 'opencode', model: 'm' })).status).toBe('failed');
    now += 5_001;
    status = 'ready'; // operator upgraded opencode
    expect((await prober.probe({ runner: 'opencode', model: 'm' })).status).toBe('ready');
    expect(calls).toHaveLength(2);
  });

  it('turns a thrown transport error into a failed verdict rather than crashing preflight', async () => {
    const transport: ProbeTransport = async () => {
      throw new Error('spawn opencode ENOENT');
    };
    const prober = createModelProber({ transport });

    const verdict = await prober.probe({ runner: 'opencode', model: 'opencode/glm-5.2' });

    expect(verdict.status).toBe('failed');
    expect(verdict.detail).toContain('ENOENT');
  });

  it('probes a roster once per distinct model even when a model fills several roles', async () => {
    const { transport, calls } = recorder({});
    const prober = createModelProber({ transport });

    const verdicts = await prober.probeAll([
      { runner: 'codex', model: 'gpt-5.6-sol' }, // implementer
      { runner: 'codex', model: 'gpt-5.6-sol' }, // and reviewer
      { runner: 'opencode', model: 'opencode/glm-5.2' },
    ]);

    expect(calls).toEqual(['codex/gpt-5.6-sol', 'opencode/opencode/glm-5.2']);
    expect(verdicts.get('codex/gpt-5.6-sol')?.status).toBe('ready');
    expect(verdicts.size).toBe(2);
  });

  it('keys a default-model binding the same way the driver does, so its verdict is not lost', async () => {
    expect(probeKey({ runner: 'codex', model: '' })).toBe('codex/auto');

    const { transport } = recorder({ 'codex/auto': { status: 'failed', detail: 'codex exec exited 1' } });
    const prober = createModelProber({ transport });
    const verdicts = await prober.probeAll([{ runner: 'codex', model: '' }]);

    expect(verdicts.get('codex/auto')?.status).toBe('failed');
  });

  it('requires the Claude host to complete the same measured round-trip contract', async () => {
    const { transport, calls } = recorder({});
    const prober = createModelProber({ transport });

    const verdict = await prober.probe({ runner: 'claude', model: 'claude-opus-4-8' });

    expect(verdict.status).toBe('ready');
    expect(calls).toEqual(['claude/claude-opus-4-8']);
  });
});
