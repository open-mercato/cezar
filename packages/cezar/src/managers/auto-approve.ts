/**
 * Auto-approval (spec 2026-11-20-manager-admin-actions § 4). The seam is live, the policy is not:
 * `evaluateAutoApproval` runs on every proposal and answers `ask`. Phase 4 fills in the rule match
 * behind `autoApprovalCeiling`; nothing else in `propose` or `decide` has to change for it.
 */
import type { Manager, ManagerActionRisk } from '@open-mercato/cezar-contract';

export type AutoApproval = { mode: 'ask'; why: string } | { mode: 'auto'; ruleId: string };

/** What the ceiling reads about one waiting card. */
export interface AutoApprovalCard {
  type: string;
  risk: ManagerActionRisk;
  pinnedAsk: boolean;
  /** The turn that proposed it: only a change the user asked for in the chat may ever go through alone. */
  turn: 'chat' | 'followup' | 'job' | 'watch' | undefined;
  /** False while the op has no full undo. */
  fullUndo: boolean;
}

/**
 * Why no rule could approve this card, or `undefined` when one may. Lives in code, not in the policy:
 * a rule can narrow it, never lift it (spec § 4.3).
 */
export function autoApprovalCeiling(manager: Manager, card: AutoApprovalCard): string | undefined {
  if (card.pinnedAsk) return 'always asks';
  if (card.risk === 'high') return 'high risk';
  if (!card.fullUndo) return 'cannot be fully undone';
  if (card.turn !== 'chat') return 'not asked for in the chat';
  if (manager.inactive) return 'manager inactive';
  return undefined;
}

export function evaluateAutoApproval(manager: Manager, card: AutoApprovalCard): AutoApproval {
  const ceiling = autoApprovalCeiling(manager, card);
  if (ceiling) return { mode: 'ask', why: ceiling };
  // Phase 0: rules are stored, never applied. Every proposal asks.
  return { mode: 'ask', why: manager.autoApprove?.rules.length ? 'automatic approval is not available yet' : 'no rule' };
}
