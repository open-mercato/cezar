/**
 * How a `gate.human` node reads a reply. Only a clear reject rejects: a reply that is
 * neither a button nor a plain yes is approval WITH instructions, which the workflow applies
 * before it goes on — never a silent `reject` that ends the run at "stopped".
 */
import { edgeFrom, type WorkflowGraph } from './graph.ts';

export const GATE_APPROVE = 'Approve';
export const GATE_FULL_PR = 'Approve, open a full PR';
export const GATE_REJECT = 'Reject';

export interface GateDecision {
  decision: 'approve' | 'reject';
  /** Free text to apply before the workflow continues; absent for a bare approve. */
  instructions?: string;
  /** The reply asked for a ready-for-review PR instead of a draft. */
  fullPr?: boolean;
}

const BARE_APPROVE = new Set([
  'approve', 'approved', 'yes', 'y', 'ok', 'okay', 'lgtm', 'go', 'go ahead', 'ship', 'ship it', 'do it', 'proceed',
  'open it', 'open pr', 'open a pr', 'open the pr', 'open draft pr', 'open a draft pr', 'open the draft pr',
]);
const BARE_FULL_PR = new Set([
  GATE_FULL_PR.toLowerCase(), 'full pr', 'open full pr', 'open a full pr', 'open the full pr', 'ready for review',
  'open it ready for review', 'open a pr ready for review', 'not a draft', 'not draft', 'non-draft', 'no draft',
]);
const BARE_REJECT = new Set(['no', 'nope', 'stop', 'cancel', 'abort', 'skip', "don't", 'do not', 'no pr', 'rejected', 'declined']);
const REJECT_FIRST = /^(?:please\s+)?(?:reject|decline|request changes|changes requested)(?:$|\s*[.!?,:;—–-]|\s+(?:it|this|the pr|the pull request)\b)/i;
const STOP = /^no[,!\s]+(?:stop|cancel|abort|skip|don't|do not)\b/i;
// A whole reply that only says "stop", "not yet" or "wait" (#2318 review): never an approval.
const HOLD =
  /^(?:please |ok |okay )?(?:n|nah|stop|halt|cancel|abort|skip|wait|hold(?: off| on)?|not (?:yet|now)|never ?mind|no thanks|later)(?: (?:here|it|this|that|the pr|the pull request|for now|now|please|for a (?:moment|minute|bit)|a (?:moment|minute|sec(?:ond)?)))*$/i;
const DO_NOT_PUBLISH = /^(?:please\s+)?(?:don't|do not|never)\s+(?:publish\b|push(?:\s+(?:it|this|that|anything|the branch|yet))*\s*$|(?:open|create)\s+(?:it|(?:(?:a|the)\s+)?(?:pr|pull request))\b)/i;
const FULL_PR =
  /\b(?:open|create|make|mark)\s+(?:it\s+)?(?:as\s+)?(?:a\s+|the\s+)?(?:full|non-?draft|regular|normal|ready[- ]for[- ]review)\s+(?:pr|pull request)\b|\b(?:open|create|make|mark)\b[^.!?,;]*\bready for review\b/i;
const DRAFT_NEGATION = /\b(?:not|no|never|don't|do not)\s+(?:(?:open|create|publish)\s+)?(?:it\s+)?(?:as\s+)?(?:a\s+)?draft\b/i;
const FULL_NEGATION = /\b(?:not|no|never|don't|do not)\b/i;

const normalize = (text: string) => text.trim().toLowerCase().replace(/’/g, "'").replace(/[\s.!?,;:—–-]+$/u, '').replace(/\s+/g, ' ');

export function classifyGateReply(reply: string, opensPr: boolean): GateDecision | undefined {
  const text = reply.trim();
  if (!text) return undefined;
  const plain = normalize(text);
  if (BARE_REJECT.has(plain) || REJECT_FIRST.test(plain) || STOP.test(plain) || HOLD.test(plain)) return { decision: 'reject' };
  const clauses = plain.split(/[.!?,;]/).map((clause) => clause.trim());
  if (clauses.some((clause) => DO_NOT_PUBLISH.test(clause) && !DRAFT_NEGATION.test(clause))) return { decision: 'reject' };
  if (opensPr && BARE_FULL_PR.has(plain)) return { decision: 'approve', fullPr: true };
  if (BARE_APPROVE.has(plain)) return { decision: 'approve' };
  const fullPr = opensPr && clauses.some((clause) =>
    DRAFT_NEGATION.test(clause) || (FULL_PR.test(clause) && !FULL_NEGATION.test(clause)),
  );
  return { decision: 'approve', instructions: text, ...(fullPr ? { fullPr: true } : {}) };
}

/** The gate's approve port leads straight to a PR node, so "open a full PR" means something. */
export function gateOpensPr(graph: WorkflowGraph, gateId: string): boolean {
  const to = edgeFrom(graph, gateId, 'approve')?.to;
  return graph.nodes.some((n) => n.id === to && n.type === 'github.draft-pr');
}

/** The prompt for the turn that applies a gate's instructions before the workflow continues. */
export function gateInstructionsPrompt(gate: string, instructions: string, next: { name: string; opensPr: boolean; fullPr: boolean } | undefined): string {
  const after = !next
    ? 'This is the last step of the workflow.'
    : next.opensPr
      ? `When you finish, the workflow goes on to "${next.name}": cezar pushes the branch and opens the pull request ` +
        `(${next.fullPr ? 'ready for review' : 'as a draft'}) itself, so do not open, close or convert a pull request yourself.`
      : `When you finish, the workflow goes on to "${next.name}".`;
  return `The user approved "${gate}", with these instructions:\n\n${instructions}\n\n` +
    `Apply them now on this task's branch and commit any changes. ${after}\n\n` +
    'End your final message with CEZ:VERDICT applied only after completing the instructions, or CEZ:VERDICT blocked if you could not apply them. ' +
    'If the instructions ask the workflow to stop, wait or not publish, change nothing and end with CEZ:VERDICT declined.\n\n' +
    'Original task: {{task}}';
}
