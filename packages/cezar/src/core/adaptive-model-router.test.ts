import { describe, expect, it } from 'vitest';
import { selectAdaptiveModel, shouldUseAdaptiveRouting, shouldEscalateFromChecks, type RoutingCandidate } from './adaptive-model-router.ts';

const models: RoutingCandidate[] = [
  { runner: 'claude', option: { id: 'new-small', label: 'Small', description: '', reasoningEfforts: [{ id: 'low', description: '' }] },
    metadata: { id: 'anthropic/new-small', context: 200_000, reasoning: false, toolCall: true, inputUsdPerMillion: 1, outputUsdPerMillion: 5 } },
  { runner: 'codex', option: { id: 'new-large', label: 'Large', description: '', reasoningEfforts: [{ id: 'high', description: '' }] },
    metadata: { id: 'openai/new-large', context: 500_000, reasoning: true, toolCall: true, inputUsdPerMillion: 8, outputUsdPerMillion: 40 } },
];

describe('adaptive model selection', () => {
  it('chooses a cheaper available model for an ordinary task without fixed model IDs', () => {
    expect(selectAdaptiveModel({ text: 'Fix the typo in the readme', preferredRunner: 'codex' }, models))
      .toMatchObject({ runner: 'claude', model: 'new-small', reasoningEffort: 'low' });
  });
  it('chooses a more capable model for critical work or a failed verification', () => {
    expect(selectAdaptiveModel({ text: 'Fix authentication race condition', preferredRunner: 'claude' }, models))
      .toMatchObject({ runner: 'codex', model: 'new-large', reasoningEffort: 'high' });
    expect(selectAdaptiveModel({ text: 'Fix a function', preferredRunner: 'claude', verificationFailures: 1 }, models)?.model)
      .toBe('new-large');
  });
  it('keeps explicit pins, locked settings, fallback and resumes authoritative', () => {
    expect(shouldUseAdaptiveRouting({ enabled: true, dryRun: false, locked: false })).toBe(true);
    for (const patch of [{ taskModel: 'pinned' }, { stepModel: 'pinned' }, { locked: true },
      { accountPinned: true }, { resuming: true }, { fallingBack: true }, { dryRun: true }, { enabled: false }]) {
      expect(shouldUseAdaptiveRouting({ enabled: true, dryRun: false, locked: false, ...patch })).toBe(false);
    }
  });
  it('escalates only after repeated verification failures', () => {
    expect(shouldEscalateFromChecks(true, 2)).toBe(false);
    expect(shouldEscalateFromChecks(false, 4)).toBe(false);
    expect(shouldEscalateFromChecks(true, 3)).toBe(true);
  });
  it('uses reliable historical outcomes as a quality floor', () => {
    const history = models.map((candidate) => candidate.runner === 'claude' ? { ...candidate, historicalSuccessRate: 0.3 } : candidate);
    expect(selectAdaptiveModel({ text: 'Fix typo', preferredRunner: 'claude' }, history)?.model).toBe('new-large');
  });
  it('honors runner pins and excludes unavailable capability or deprecated models', () => {
    expect(selectAdaptiveModel({ text: 'Fix auth', preferredRunner: 'codex', allowedRunner: 'claude' }, models)?.runner)
      .toBe('claude');
    expect(selectAdaptiveModel({ text: 'Fix auth', preferredRunner: 'codex' }, models.map((candidate) =>
      candidate.runner === 'codex' ? { ...candidate, metadata: { ...candidate.metadata!, deprecated: true } } : candidate))?.runner)
      .toBe('claude');
    expect(selectAdaptiveModel({ text: 'Fix auth', preferredRunner: 'codex' }, models.map((candidate) =>
      ({ ...candidate, metadata: { ...candidate.metadata!, toolCall: false } })))).toBeUndefined();
  });
});
