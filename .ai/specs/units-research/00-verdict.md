# Missions: does the feature create real value? — verdict from the evidence

> Date: 2026-09-10 · Method: eight adversarial research passes (four on published evidence, four on
> products and frameworks), ~130 sources, each pass instructed to falsify the founders' hypothesis.
> Per-pass reports: `01`–`08` in this directory, each with its own confidence section. This verdict
> is the founders' reading of them, written to make decisions, not to please anyone.

## The hypothesis under test

"A frontier commander that plans and judges, cheap workers that do the work, independent reviewers,
per-mission budgets and a filesystem channel produce better and cheaper END-TO-END results than one
strong agent: you launch a mission, you get a solved problem."

## Verdict in one paragraph

The hypothesis is **false as stated and true under conditions we do not yet enforce.** The evidence
does not support hierarchy as a general win for coding, does not support "one objective in, solved
problem out" for anything larger than a couple of hours of human work, and shows that the cheap
part of the ladder only pays when verification is NOT cheap. What the evidence does support, and
what nobody in the market packages well, is narrower and more valuable: a local control tower that
splits an objective into right-sized, independently verifiable units, runs the cheap ones cheaply,
verifies every claim by execution rather than by narrative, caps spend in real dollars, and never
merges without a human. That is the product. "Missions" is the organising metaphor for it, not a
promise of autonomy.

## What the evidence says, claim by claim

### 1. "Hierarchy beats a single strong agent" — not for coding in general (reports 01, 06)

- Real multi-agent systems fail 41–87% of the time across 1,600+ traces, mostly from coordination
  failures with no single-agent analogue (MAST, Berkeley 2025). Multi-agent uses ~15× the tokens of
  a single chat-style agent (Anthropic's own number).
- Manager delegation helps on parallel, low-cohesion work (+81%) and hurts on sequential, tightly
  coupled work (−39% to −70%). Most real coding is the second kind. Coordination overhead above ~15%
  of the token budget erodes the planning advantage entirely.
- The one strong positive result (Anthropic's research system, +90% over single Opus) is for
  breadth-first research, explicitly "only for high-value tasks", and credits hard isolation, not the
  manager, for making it work. Cognition, the most coding-focused lab, argues against multi-agent by
  default and validates exactly one pattern: author plus a reviewer with deliberately unshared
  context. CrewAI's hierarchical mode is documented to overwrite good work with the last agent's;
  the fix was less LLM discretion.
- **What survives:** delegation as a per-task decision for genuinely independent pieces, with
  worktree isolation as the load-bearing property. Our worktrees are right; our default topology
  (always a commander) is not yet gated on task shape.

### 2. "Cheap workers under a frontier commander are cheaper at equal quality" — true with conditions (02, 08)

- Cascades and routing are real: DeepSeek reaches 84% of GPT-5's Aider score at 4.5% of the cost;
  routing across a model pool beat every single model on cost AND coverage (Arize). Haiku 4.5 now
  matches previous-generation Sonnet (73% SWE-bench Verified) at a third of the price. The
  arbitrage is stable-to-widening because the cheap tier's prices fall as fast as the frontier's.
- The conditions are hard. A cheap-tier verifier waved through 48% of real failures; even two
  frontier models cross-checking agreed only 95.7% of the time. In one study 91% of a budget model's
  failures were silent cap-outs that burned the whole allotment for nothing. Per-step reliability
  compounds: 95% per step is 66% after eight steps. On the harder SWE-bench Pro the cheap gap widens
  (GPT-5-mini 46%). The truly local tier (what fits a Mac) scores 46–62%, a different tier from the
  best cheap open models, which do not fit a Mac.
- **What survives:** route by task shape, not rank. Cheap tiers for bounded, verifiable, single-file
  work, tests, lint, research, first-pass review. Frontier for multi-file, ambiguous or destructive
  work. A reviewer at least one tier above the worker, or an execution gate instead. Cap-out is an
  escalation trigger, never a retry. Nobody has published the net cost of a commander→worker→
  reviewer loop; we must measure it on our own task mix.

### 3. "An independent reviewer makes cheap work trustworthy" — partly (03, 06)

- Cross-model review measurably reduces author bias; a critic model beat paid human reviewers at
  finding bugs (CriticGPT, preferred 63%). Production review tools reach ~96% precision on
  high-severity flags but top out at F1 ≈ 0.51.
- The damaging result: LLM judges evaluating an agent's own claim of completion score near chance
  (AUROC 0.54–0.65, below a bag-of-words baseline), and 45–76% of agent "done" claims in those
  benchmarks were false. Agents game visible checks (reward hacking 43× more common with a visible
  scorer; 58% of runs "built to the test"). Verifiers rubber-stamp under pressure ("early victory
  problem", named by Anthropic). Passing tests overestimate correctness by 18–32%.
- **What survives:** a reviewer that judges narrow, falsifiable claims against primary artefacts
  (the diff, engine-captured test output), from a different model, with an explicit checklist to
  falsify and the worker's narrative shown last. The engine, not any model, must run the tests and
  check that claimed files exist. The report is a claim; execution is the proof.

### 4. "One objective in, solved problem out" — not today, for anything long (04)

- Frontier agents complete ~1–2 hour tasks at 50% reliability and 4-hour tasks below 10% (METR;
  half-life ~59 min, Ord). Long-horizon terminal tasks: 4.3% mean pass rate, best model 15% (LHTB
  2026). Even Claude Code keeps a human in 87% of simple and 67% of complex sessions. Experienced
  developers were 19% slower with AI in their own repos while believing they were faster (METR RCT).
- A well-timed human checkpoint took success from 6.7% to 66.7% on hard tasks. Replit's agent deleted
  a production database under a freeze and fabricated success reports.
- **What survives:** missions decomposed into units of at most ~1–2 hours of human-equivalent work,
  each with an external definition of done, with checkpoints before irreversible actions and at
  handoffs. The value is strongest for work the user would not do themselves promptly, not as a
  blanket "faster".

### 5. The market — real pain, crowded category, two open differentiators (05, 07)

- Worktree isolation, multi-backend, cheap sub-task models and named roles are table stakes: Factory
  ships orchestrator/worker/validator "Missions", GitHub Agent HQ runs Claude, Codex and Copilot side
  by side with automatic worktrees, Claude Code has subagents and agent teams, Zed and Warp absorbed
  parallel agents natively and free.
- The category has real usage and a graveyard: Vibe Kanban reached 30k users and 100k PRs and its
  company still shut down; Terragon shut down; Crystal folded; 17 of ~150 catalogued orchestrators
  are already archived. Every attempt to monetise "team" in this niche failed or is premium-only.
- The pain is documented and specific: cost surprises ($900 in 18 days; Devin's $300–500/month
  against a $20 headline; subagents eating 85% of a token bill), 96% of developers distrust AI code,
  PRs merged without review up 31% with incidents up 243%, and Cursor's confirmed multi-agent state
  corruption.
- **Nobody hard-enforces a dollar-denominated budget**, nobody ships a first-class per-task cost
  dashboard, few make "never auto-merge" a structural guarantee, and none of the six primary cockpit
  competitors runs the whole thing local-first with verified missions. Those are ours if we take them.

### 6. The filesystem channel — right direction, unproven mechanics (06)

- Structured artefacts over chat is the pattern every credible framework converged on. Filesystem
  coordination is where the field is heading (Claude Code Agent Teams), but nobody, that vendor
  included, has published a claim/lock/conflict protocol. Our design of per-unit-owned files and
  append-only inboxes sidesteps the unsolved part, and must be documented as such rather than
  claimed as proven.

## What this means for "missions that solve problems end to end"

Redefine the promise. A mission is not an autonomous run that comes back with a solved problem.
It is a **managed pipeline**: the commander's job is decomposition into right-sized, verifiable
units and adjudication of verified results; the engine's job is to run the checks, cap the money
and stop before anything irreversible; the human's job is a handful of decisions at the points
where the evidence says a checkpoint multiplies success. The output is one reviewed branch and one
draft PR with verified evidence attached. "End to end" means the user does no work, not that the
user makes no decisions.

## Decisions, ranked by the strength of the evidence

1. **Engine-executed verification per unit.** Every order carries verify commands; the engine runs
   them at settle, captures raw output, and stamps the result on the report. A reviewer and a
   commander read engine output, never the worker's summary. Claimed files are checked to exist.
   (03, 04, 06 — the single strongest finding across passes.)
2. **A task-shape gate before delegation.** The commander must classify each piece as low- or
   high-cohesion; high-cohesion work goes to one worker or is done by the commander's own tier, never
   split. Managers only for genuinely parallel breadth. (01, 06.)
3. **Route by kind and shape, not by rank.** Cheap tiers for bounded verifiable work; frontier for
   multi-file, ambiguous or destructive; reviewer at least one tier above the author or execution-
   gated; loop caps for cheap workers with a checkpoint every few steps; cap-out escalates, never
   retries. Instrument dollars per successful task per tier from day one. (02, 08.)
4. **Reviewer prompt built against the failure list.** Falsify a checklist, artefacts before
   narrative, rubric not shown to the worker, verdict required and refused if absent. (03, 06.)
5. **Live spend brake per unit**, not only settle-time charging; the budget is a real dollar cap
   and the cockpit shows it live. This is also the headline of our positioning. (05, 06, 07.)
6. **Mission sizing rules in the composer and the commander prompt**: pieces of ≤ ~1–2 hours of
   human-equivalent work, mandatory checkpoints before irreversible actions and at handoffs. (04.)
7. **Positioning:** local-first, real-dollar budgets, never auto-merge, verified missions. Answer
   Cognition's critique explicitly in our docs. Do not lead with worktrees, multi-backend or named
   roles. (05, 07.)
8. **Measure our own crossover.** Same task set, three configurations (single frontier agent;
   commander + cheap workers + reviewer; commander + cheap workers + engine verification), reported
   as dollars per merged outcome. The literature does not contain this number. (02, 04.)
9. **Park:** deep hierarchies by default, "thousands of agents" as a goal, and any claim that missions
   are cheaper or better than a single agent in general.

## Claims we must not make

- "Hierarchical multi-agent is cheaper or better than a single strong agent." The default evidence
  is the opposite; it flips only for parallel, high-value, well-isolated work.
- "Launch a mission and the problem is solved." Not above ~1–2 hours of human work without
  checkpoints, on current evidence.
- "An independent AI reviewer guarantees correctness." It reduces bias; it does not verify claims.
- "Runs on your local models." True only for a bounded, verifiable bottom tier; the best cheap open
  models do not fit a laptop.

## Confidence and gaps

High confidence on the primary-source numbers (MAST, Anthropic's token multipliers and autonomy
telemetry, METR horizons and RCT, Aider leaderboard, Cognition's own posts). Medium on 2026
preprints and benchmark percentages taken from secondary summaries. Low on pricing and model names
from aggregator sites; several passes flagged content that looks generated. The biggest gap is the
same in every pass: no published study measures our exact shape, a commander delegating coding work
to cheap workers with an independent reviewer. Decision 8 closes it with our own data.
