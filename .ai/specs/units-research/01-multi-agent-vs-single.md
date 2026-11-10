# Multi-agent vs single-agent LLM systems: evidence review

Scope: published/preprint evidence 2023-2026 on multi-agent LLM systems vs a single
strong agent, with focus on hierarchical (orchestrator-worker) designs and coding
specifically, since that's cezar's use case. ~12 searches/fetches; not exhaustive.

## 1. Sources

1. Cemri, Pan, Yang et al., "Why Do Multi-Agent LLM Systems Fail?" (MAST),
   arXiv:2503.13657, UC Berkeley (Zaharia/Gonzalez/Stoica co-authors), 2025-03,
   NeurIPS 2025. Taxonomy of 14 failure modes over 1600+ traces, 7 MAS frameworks.
2. Anthropic, "How we built our multi-agent research system," 2025-06.
   Opus-4-lead + Sonnet-4-subagents; token multipliers, 90.2% win on internal eval.
3. Cognition, "Don't Build Multi-Agents," 2025-06. Contrarian essay against
   multi-agent-by-default for coding; argues for single-threaded linear agent.
4. Cognition, "Devin can now Manage Devins," ~2026-03. Coordinator + isolated
   managed-Devin instances - partial reversal of (3), framed around isolation.
5. Li, Zhang et al., "More Agents Is All You Need," arXiv:2402.05120, 2024-02.
   Sampling-and-voting over N *independent identical* model copies, not role
   delegation.
6. Hong et al., "MetaGPT," arXiv:2308.00352, 2023-08 (v6 2024). Role-based
   multi-agent SOP pipeline for code generation.
7. Qian et al., "ChatDev," arXiv:2307.07924, 2023-07. Chat-chain multi-agent
   software generation framework.
8. "Getting Up to Speed on Multi-Agent Systems, Part 7: Benchmarks and What They
   Miss," christophermeiklejohn.com, 2026-04. Survey of SWE-bench single- vs
   multi-agent entries and what benchmarks miss (coordination-token cost).
9. "When Parallelism Pays Off: Cohesion-Aware Task Partitioning for Multi-Agent
   Coding," arXiv:2606.00953, 2026-06. Task *cohesion* (coupling) as the variable
   deciding whether splitting a coding task across agents helps or hurts.
10. "The Orchestrator Bottleneck: Formal Coordination Strategies for Cost-Optimal
    Multi-Agent Enterprise Workflows," ICML 2026. Token-budget threshold (~15%)
    beyond which hierarchy's coordination cost erodes its own planning advantage.
11. Simon Willison, commentary on (2), simonwillison.net, 2025-06-14. Used to
    cross-check figures in (2).

## 2. Findings

**F1.** MAST: "empirical analysis reveals 41% to 86.7% failure rate on 7
state-of-the-art (SOTA) open-source MAS," across 1600+ traces (kappa = 0.88
inter-annotator agreement). [1]

**F2.** MAST's 3 failure categories - System Design, Inter-Agent Misalignment,
Task Verification - broken into 14 modes. Top by frequency: step repetition
15.7%, reasoning-action mismatch 13.2%, unaware of termination conditions 12.4%,
disobey task spec 11.8%, incorrect verification 9.1%, no/incomplete verification
8.2%, task derailment 7.4%, fail to ask for clarification 6.8%, premature
termination 6.2%, loss of conversation history 2.8%, conversation reset 2.2%,
ignored other agent's input 1.9%, disobey role spec 1.5%, information withholding
0.85%. [1] These are coordination failures with no single-agent analogue.

**F3.** Anthropic: "agents typically use about 4x more tokens than chat
interactions, and multi-agent systems use about 15x more tokens than chats."
Token count alone explained ~80% of variance in their BrowseComp eval score. [2, 11]

**F4.** Anthropic's multi-agent system: "90.2% performance gain" over single-agent
Opus 4 on an internal research eval - but explicitly scoped to "breadth-first
queries that involve pursuing multiple independent directions simultaneously,"
with parallelizable, single-context-exceeding work, and gated on task value:
"the economics only work for high-value research" (legal due diligence,
competitive intelligence, biomedical lit review). [2]

**F5.** Cognition, on coding specifically: "splitting one task into five pieces
doesn't automatically make the system smarter, and quite often, it just makes the
system more expensive, more complex, harder to debug, and more likely to shred
the context that actually mattered." Worked example: a Flappy Bird clone split
across two subagents produces mismatched output because "subagent 1 and subagent
2 cannot see what the other was doing." Recommendation: "the simplest way to
follow the principles is to just use a single-threaded linear agent," with
context compression instead of a second agent for long-horizon work. [3]

**F6.** Cognition's later "Devin can now Manage Devins" has one coordinator
dispatch fully isolated "managed Devin" instances (own VM, own shell/tests,
parallel), reading trajectories afterward to compile results - hierarchical
fan-out with hard isolation and no shared-context mid-task editing, close to
cezar's per-worktree design, not the tightly-coupled pattern (3) criticized. [4]

**F7.** Task *cohesion* determines outcome, not size: "Low-cohesion tasks: agents
can partition work with minimal dependencies, enabling genuine parallelism...
High-cohesion tasks: partitioning creates communication bottlenecks that degrade
performance... coordination costs exceed the parallelization gains." [9]

**F8.** A 2026 study argues coordination cost has a crossover: "an empirical
orchestrator overhead threshold... around 15% of total token budget, beyond which
the coordination cost of hierarchical strategies erodes their planning
advantage." Its strategy-switching orchestrator (using hierarchy only
selectively) cut end-to-end cost 28-42% vs a static sequential baseline. [10]

**F9.** SWE-bench Verified/Lite leaderboards mix single- and multi-agent
entries at the top; per one survey, "neither architecture achieves better results
than the other" as a class, and "a well-designed single-agent system with strong
context management can outperform a poorly-designed multi-agent system." [8]

**F10.** Cross-paper self-reports disagree sharply: ChatDev's paper claims 88%
executability, MetaGPT's claims 41%, on differently-framed evals; large
role-based frameworks (MetaGPT/ChatDev-style) have been reported elsewhere to run
communication costs "exceeding $10 per HumanEval task" - HumanEval being
single-function-sized problems. Lower-confidence (search-synthesized, not
independently re-verified against the primary papers). [6, 7, 8]

**F11.** "More Agents Is All You Need" gains come from sampling N *independent
identical-model* completions and voting - closer to best-of-N than to role-based
delegation. It is evidence that more samples help, not that hierarchical
delegation helps; citing it for orchestrator/worker design would be a category
error. [5]

## 3. What SUPPORTS cezar's hypothesis

- Anthropic's own production system beat single-agent by 90.2% with a frontier
  orchestrator + cheaper subagents - structurally close to cezar's commander/
  worker split. [F4]
- Isolation (separate context, separate environment) is what both pro-multi-agent
  sources credit for making it work: Anthropic's parallel context windows,
  Cognition's own isolated managed-Devin VMs. cezar's per-worktree isolation
  matches what both treat as necessary. [F4, F6]
- Where subtasks are genuinely low-cohesion/independent, splitting work is a real,
  evidenced win, not just a hypothesis. [F4, F7]
- A selectively-hierarchical orchestrator beat a static baseline by 28-42% cost -
  hierarchy pays off when applied as a choice, which fits cezar being a per-task
  decision rather than a mandatory default. [F8]

## 4. What CONTRADICTS or BOUNDS it (blunt)

- **cezar's core use case, coding, is the case the evidence is weakest on.** Every
  source separating "wins" from "loses" puts parallelizable, low-coupling,
  breadth-first work on the winning side and sequential, high-coupling work - most
  real coding, especially shared interfaces/shared state - on the losing side.
  [F4, F5, F7, F9] Unless a mission decomposes into genuinely low-cohesion units
  (independent modules, independent bug fixes), the literature says a single
  strong agent should do at least as well, for less.
- **41-86.7% of real MAS traces fail, mostly from coordination/design failures**,
  not reasoning failures - exactly the risk surface a hierarchy/filesystem-channel
  design adds. [F1, F2] This is the concrete list cezar's Guard/REVIEWER layer
  needs to be built against.
- **The token multiplier is ~15x vs a single chat-style agent**, and Anthropic
  states the economics only close for high-value tasks. [F3, F4] Nothing here
  supports "cheaper" as a general property of hierarchy - only "cheaper than the
  token-equivalent sequential alternative, when parallelizable and high-value."
- **The most coding-specific industry voice argues explicitly against
  multi-agent-by-default**, using a coding example structurally identical to
  cezar's worker split: two agents on adjacent parts of one deliverable producing
  inconsistent, unintegrated output. The filesystem channel mitigates but does not
  refute this - it doesn't eliminate MAST's "information withholding" / "ignored
  other agent's input" modes. [F2, F5]
- **Architecture doesn't predict SWE-bench success; implementation quality does.**
  "A well-designed single-agent system... can outperform a poorly-designed
  multi-agent system." [F9] This undercuts any claim that hierarchy itself is the
  source of advantage.
- **A real coordination-overhead crossover exists** (~15% of token budget by one
  estimate) past which more hierarchy layers erode value rather than add it - not
  monotonically-better. [F8]
- **"More Agents Is All You Need" does not support role-based hierarchy** - it's
  sampling/voting over identical copies, a different mechanism. [F11]

## 5. Implications

**Do differently:**
- Gate mission-splitting on measured task cohesion/independence, not mission
  size; default to a single agent (or 1 commander + 1 worker) when subtasks share
  interfaces or state. [F7, F9]
- Treat the 15x token multiplier as a real cost line; size mission scope to where
  parallel speed/quality plausibly exceeds that multiplier, not as a default for
  all work. [F3, F4]
- Build Guard/REVIEWER explicitly against the MAST failure list rather than a
  generic output check: step repetition, termination-unawareness, incorrect/
  incomplete verification, and reasoning-action mismatch are ~45% of observed
  MAS failures on their own. [F1, F2]
- Lean into isolation (separate worktrees/contexts) as the load-bearing design
  choice, not an implementation detail - it's what every pro-multi-agent source
  here actually credits. [F4, F6]
- Let the commander choose *not* to spin up managers/workers for sequential/
  high-cohesion missions - "escalate to multi-agent" as a decision, not a
  default topology. [F7, F8]

**Claims cezar must NOT make:**
- "Hierarchical multi-agent is cheaper than a single strong agent," generally -
  default evidence is the opposite (15x tokens); it flips only for high-
  parallelism, high-value work. [F3, F4]
- "Multi-agent produces better results on coding tasks," generally - no source
  found here shows multi-agent beating a strong single agent on sequential/
  interdependent coding; SWE-bench evidence says architecture doesn't predict the
  winner, and the leading coding-specific lab argues the opposite. [F5, F9]
- Any claim that more agents/layers monotonically improves quality - there's a
  documented overhead crossover and a majority-failure-rate baseline across real
  deployed MAS. [F1, F8]
- Citing "More Agents Is All You Need" as support for commander/worker hierarchy -
  it's a different mechanism (sampling/voting), not delegation. [F11]

## 6. Confidence and gaps

- High confidence: F1-F5 (direct quotes/numbers from primary sources: MAST paper,
  Anthropic's own post, Cognition's own post).
- Medium confidence: F6 (details from search snippets, not a direct fetch of the
  post; its date is as reported by search results, not independently verified).
- Medium confidence: F7, F8 (2026 arXiv preprints, not yet peer-reviewed; pulled
  via summarized PDF extraction, not a full read-through).
- Lower confidence: F10 (figures came from search-engine synthesis, not a
  primary-source fetch I verified line-by-line - directionally indicative that
  cross-framework self-reports disagree and coordination cost is nontrivial, not
  precise figures to quote externally without re-checking the ChatDev/MetaGPT
  papers directly).
- Gaps: no row-by-row SWE-bench leaderboard comparison pulled (only a survey's
  summary claim); HuggingGPT and AgentVerse (named in the brief) did not yield
  citable head-to-head numbers within budget and are omitted rather than
  included on weak evidence; nothing here directly tests cezar's actual mechanism
  (filesystem channel, escalation ladder, per-role budgets) - Sections 4-5's
  application to cezar specifically is this analyst's inference from general MAS
  findings, not a direct test of cezar's design.
