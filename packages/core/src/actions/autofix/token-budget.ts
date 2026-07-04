export class TokenBudgetExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(`Token budget exceeded: used ${used} of ${limit}`);
    this.name = 'TokenBudgetExceededError';
  }
}

export interface TokenUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Tracks cumulative token usage across one autofix attempt and trips the circuit
 * breaker when a pre-configured budget is crossed. Cache reads count at face value
 * — the budget is about absolute cost control, not billing accuracy.
 */
export class TokenBudget {
  private used = 0;

  constructor(public readonly limit: number) {
    if (limit <= 0) throw new Error('TokenBudget limit must be positive');
  }

  record(delta: TokenUsageDelta): void {
    this.used +=
      (delta.inputTokens ?? 0) +
      (delta.outputTokens ?? 0) +
      (delta.cacheCreationInputTokens ?? 0) +
      (delta.cacheReadInputTokens ?? 0);
  }

  get current(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  get exceeded(): boolean {
    return this.used >= this.limit;
  }

  /** Call after each agent turn. Throws if the budget has been crossed. */
  assertWithinBudget(): void {
    if (this.exceeded) throw new TokenBudgetExceededError(this.used, this.limit);
  }
}
