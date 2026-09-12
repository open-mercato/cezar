# Capability of cheap and local models for agentic coding (Sept 2026)

Adversarial read on whether cheap/local models can safely sit at the bottom of a
commander→manager→worker hierarchy in cezar. Numbers pulled from public
leaderboards and vendor pages; see confidence notes in §7 — several 2026-dated
aggregator sites carry numbers I could not independently verify against a primary
source.

## 1. Sources

- Anthropic, "Introducing Claude Haiku 4.5" (anthropic.com/news) + OpenRouter pricing page
- llm-stats.com/benchmarks/aider-polyglot (Aider polyglot leaderboard, Sept 2026 snapshot)
- morphllm.com/swe-bench-pro, morphllm.com/best-ai-model-for-coding, morphllm.com/best-ollama-models
- OpenAI GPT-5.4 mini/nano coverage (the-decoder.com, datacamp.com, benchlm.ai/models/gpt-5-mini)
- Mistral AI, "Devstral" announcement (mistral.ai/news/devstral)
- OpenAI gpt-oss local-deployment coverage (codex.danielvaughan.com, matterai.so)
- Kimi K2 technical report (rdi.berkeley.edu slides) + secondary coverage for K2/GLM-4.6/Qwen3-Coder SWE-bench Verified scores
- Berkeley Function Calling Leaderboard v4 (gorilla.cs.berkeley.edu/leaderboard.html; llm-stats.com/benchmarks/bfcl-v4)
- dev.to Llama-3B tool-calling benchmark; arXiv 2510.03847 "Small Language Models for Agentic Systems" survey; arXiv 2607.04686 "ToolFailBench"
- METR "Task-Completion Time Horizons of Frontier AI Models" (metr.org/time-horizons)
- Arize AI, "How cheap models changed multi-agent economics"; MindStudio orchestrator/sub-agent posts
- promptquorum.com local-LLM coding/tool-calling guides; usagebox.com cost-per-task comparison

## 2. Capability table

Scores are SWE-bench Verified (SB-V) unless marked SB-Pro (a harder, contamination-resistant
successor benchmark — expect SB-Pro scores ~15-25pt below SB-V for the same model) or Aider
polyglot (AP, 0-1 scale). Tool-calling reliability is qualitative unless a BFCL/well-formed-call
number exists.

| Model | Tier / list price (in/out per M tok) | Score | Tool-calling reliability | Runs local on 32-128GB Mac? |
|---|---|---|---|---|
| Claude Opus 5 | Frontier / high | ~96-97% SB-V | High | No (API only) |
| Claude Sonnet 4.5/5 | Frontier-adjacent / $1.25 / $10 | 76.3% SB-V | High | No |
| **Claude Haiku 4.5** | **Cheap / $1 / $5** | **73.3% SB-V** (matches old Sonnet 4) | High — Anthropic's first Haiku with extended thinking + native tool use | No |
| GPT-5 | Frontier / high | 88.0 AP (#1 leaderboard) | High | No |
| **GPT-5-mini** | **Cheap / $0.25 / $2.00** | **45.7% SB-Pro** | Good, degrades vs full GPT-5 | No |
| **GPT-5.4-mini** (newer gen) | Cheap / $0.75 / $4.50 | 54.4% SB-Pro | Good | No |
| **GPT-5-nano / 5.4-nano** | **Very cheap / $0.05-0.20 / $0.40-1.25** | 52.4% SB-Pro (5.4-nano) | Adequate for narrow tasks; OpenAI positions it for classification/extraction/"coding subagents that handle simpler supporting tasks" — i.e. NOT the primary coder | No |
| Gemini 2.5 Pro | Frontier-adjacent | 0.765 AP / 63.8% SB-V | High | No |
| **Gemini 2.5 Flash** | **Cheap** ($0.30/$2.50) | **0.619 AP**; one source claims 78% solve at $0.078/task (unverified) | Good | No |
| DeepSeek-V3.2-Exp | Open, cheap API / ~$0.27/$0.40 | **0.745 AP** — best open score on Aider polyglot | Good | Marginal — 671B MoE, needs heavy quantization; impractical on a single Mac |
| DeepSeek-R1-0528 | Open, cheap / $0.50/$2.15 | 0.716 AP | Good (reasoning model) | Same constraint as above |
| **Qwen3-Coder-480B** | Open / $0.30/$1.00 | **0.618 AP / 69.6% SB-V** | Good, built for agentic tool use | No — 480B too large; smaller Qwen3 dense/MoE variants (30B, 235B-A22B) fit better |
| **Qwen3-235B-A22B** | Open, cheap / $0.09/$0.55 | 0.573 AP | Good | Borderline at 128GB w/ aggressive quant |
| **Kimi K2-Instruct** | Open | 0.600 AP / 65.8% SB-V (K2-0905: 71.2%) | Good, designed as agentic model | 1T MoE — not feasible locally on a Mac |
| **GLM-4.6** | Open, cheap | 68.2% SB-V | Reported reliable for agentic coding by users | Large (~355B) — not practical below server-class hardware |
| **gpt-oss-20b** | Open weights, free to run | **60.7% SB-V** | Adequate | **Yes — 16GB RAM, fits comfortably on 32GB+ Mac** |
| **gpt-oss-120b** | Open weights, free to run | **62.4% SB-V** | Adequate-good | Yes on 80GB+ unified memory (96-128GB Mac) |
| **Devstral (24B)** | Open weights, free to run | **46.8% SB-V** (best open model at release; since surpassed) | Purpose-built for agentic coding tool calls | **Yes — designed for single RTX 4090 / 32GB Mac** |
| Llama 3.3 70B | Open weights | — | ~97% well-formed call *rate* but only ~58% *task-success* consistency per one benchmark — high syntactic validity, low semantic reliability | Yes, ~40-50GB at Q4-Q5 |
| Sub-7B models (Llama 3B class) | Open weights | — | **Near-zero tool-call attempts in one 9-scenario test** — effectively can't do agentic tool use | Yes, trivially — but not fit for purpose |

## 3. Findings — what cheap models can be trusted with, and what not

**Can be trusted with (moderate-high confidence):**
- Self-contained, well-specified single-file or single-function edits (lint fixes, formatting, small bug patches) where a linter/test harness gives immediate ground-truth feedback and the model can iterate to green.
- Writing tests and boilerplate/documentation for code that already exists and is fully in context.
- Research/summarization subtasks with a bounded, well-defined question and a fixed set of source files or search results to digest.
- First-pass review flagging (style, obvious bugs, missing null checks) as *input* to a stronger reviewer, not as the final gate.
- Structured, repetitive transformations across many files when the transformation itself is unambiguous (rename, mechanical API migration) — closer to a scripted task than genuine reasoning.

**Cannot be trusted with (well-supported by the data):**
- Multi-file refactors requiring architectural judgment: sources explicitly flag this as where "local models understand individual functions, not system architecture" and where ambiguity causes amplified confusion rather than resolution.
- Long, multi-step agentic loops with many sequential tool calls: even a 95%-reliable-per-call model compounds to ~66% success over 8 steps; smaller/cheaper models sit well below 95% per-call reliability, so loop-completion odds fall off fast with horizon length.
- Tasks requiring disambiguation of underspecified requirements — cheap models don't reliably ask clarifying questions or flag uncertainty; they guess and proceed.
- Anything near or above the frontier's proven task-length ceiling: METR's time-horizon work shows success rate is highly correlated with task length (R²=0.83), and that curve is set by frontier models — cheap models' effective horizon is shorter, not documented in absolute terms but implied by their 10-20pt lower SWE-bench scores on the same held-out task mix.
- Tool-calling under real MCP/production conditions: BFCL and independent tests show large gaps between "produces syntactically valid JSON" and "reliably completes the task" — a 70B model can hit ~97% well-formed calls yet only ~58% task success, and smaller (≤7B) models can fail to attempt tool calls at all.

## 4. What SUPPORTS the "cheap workers under a frontier commander" plan

- **The gap has narrowed, not stayed fixed.** Claude Haiku 4.5 (cheap tier) now matches the *previous-generation* Sonnet 4's SWE-bench Verified score (73.3%) at roughly 1/3 the cost — the frontier-to-cheap gap for the same vendor is now closer to "one generation behind" than "different league."
- **Open agentic-coding-specific models exist and score respectably.** Qwen3-Coder (69.6% SB-V), GLM-4.6 (68.2%), Kimi K2 (65.8-71.2%) are all within ~10-15pt of frontier commander-tier scores from just 12-18 months prior, and were purpose-built for tool-calling/agentic use rather than adapted from a general chat model.
- **Cost-per-successful-task, not cost-per-token, favors cheap tiers hard.** One source estimates DeepSeek-class pricing at ~$0.12-0.15 per successful run vs. ~$10 on a frontier premium tier for a comparable feature task — a 60-80x difference — meaning even a materially higher retry rate on cheap models can still net out cheaper in aggregate.
- **Orchestrator/worker patterns are already validated in practice**, not just theory: one reported production pattern (frontier orchestrator delegating to a cheaper worker tier) hit 96% of solo-frontier quality at 46% of the price on a real benchmark (BrowseComp), and general guidance from cost-optimization write-ups claims 5-10x token-cost reduction "without meaningfully affecting output quality" *when the split matches task type* (planning/review on the expensive model, execution on the cheap one).
- **Local free-to-run models cover a meaningful floor.** gpt-oss-20b (60.7% SB-V) fits in 16GB and gpt-oss-120b (62.4%) in ~80GB — both comfortably within a 32-128GB Mac — meaning a genuinely offline/zero-marginal-cost tier is not purely theoretical for cezar's target hardware.
- **Bounded, mechanical, or narrow-domain tasks are exactly where the literature says small models don't lose much accuracy** — tests, docs, lint fixes, formatting, narrow classification/extraction — which maps directly onto the "implementer/researcher/first-pass reviewer" roles cezar proposes putting at the bottom of the hierarchy.

## 5. What CONTRADICTS or bounds the plan

- **SWE-bench Verified is the easy benchmark; SWE-bench Pro is harder and cheap models fall further behind on it.** GPT-5-mini lands at only 45.7% on SB-Pro (vs. headline SB-V numbers in the 70s for comparable-cost Claude/DeepSeek models) — the "cheap tier is basically fine" story is benchmark-dependent, and Pro-style (real-world, less contaminated) evals show a wider gap than Verified does.
- **Reliability compounds against long loops.** The 95%-per-step → 66%-over-8-steps math means that *even a nominally strong* cheap model becomes unreliable specifically on the kind of multi-step, multi-tool-call autonomous work that an "implementer" role implies once a task exceeds a handful of steps — this is a structural argument, not a one-off benchmark gap, and it gets worse as task length grows (which is exactly what METR's curve tracks for frontier models too, just starting from a lower baseline for cheap ones).
- **Sub-7B / true "small" local models are not viable agentic workers at all** — one benchmark found a 3B model made zero tool-call attempts across 9 scenarios. If "local models" in the cezar plan means anything smaller than the ~20B-24B (gpt-oss-20b, Devstral) class, this is a hard floor, not a soft one.
- **Syntactic tool-call validity ≠ task success**, and the gap is large and mostly *undocumented per-model* — the clearest data point (Llama 3.3 70B: ~97% well-formed calls, ~58% task success) suggests structured-output failure rates alone understate how often a "successful-looking" cheap-model tool call still doesn't accomplish the task, which is a serious risk for any automated escalation logic that trusts a clean JSON response as a signal of correctness.
- **The largest, best-scoring open models (Kimi K2, GLM-4.6, Qwen3-Coder-480B, DeepSeek-V3.2) are NOT locally runnable on the stated 32-128GB Mac hardware** — they require server-class GPU memory. The models that *are* locally runnable (gpt-oss-20b/120b, Devstral, Qwen3 dense ≤35B) score meaningfully lower (46-62% SB-V) than the open frontier, so "local" and "best cheap open model" are different tiers, not the same one — the plan needs to pick which one it means.
- **Multi-file refactors and ambiguity resolution are repeatedly named as the specific failure mode across independent sources** (survey papers and practitioner write-ups alike) — this is precisely the kind of work a "manager" tier might be tempted to delegate downward once trust in a cheap worker builds up on easier tasks; the literature says don't.
- **Confidence caveat itself is a bound**: several cost-per-task and 78%-solve-rate figures found in this research trace to SEO-style aggregator content around unverifiable 2026 model names (see §7) — if the actual gap is worse than these optimistic aggregator numbers suggest, the "cheap workers" case is weaker than §4 makes it look.

## 6. Implications — routing recommendation for cezar

Route by **task shape**, not by role label, and keep loop length short per delegated call:

| Kind of work | Recommended tier | Why |
|---|---|---|
| Research / doc summarization / "read these N files and answer X" | Cheap frontier-vendor tier (Haiku 4.5) or strong open (Qwen3-Coder/GLM-4.6/Kimi K2 via API) | Bounded input, no ambiguity, no long tool-call chain |
| Test writing / lint & format fixes / small isolated single-file edits with a green/red signal | Cheap tier, including **local** gpt-oss-20b or Devstral where a fully offline path matters | Task has a verifier (tests/linter); low ambiguity; matches literature's "good at" list directly |
| First-pass code review (flag issues, don't gate) | Cheap tier, output always re-checked by manager/commander | Structured-output errors and false negatives are acceptable if a stronger reviewer is the actual gate |
| Multi-step implementer loop >5-8 tool calls, even if each step looks simple | Escalate to at least a mid tier (Sonnet-class) or **checkpoint after every 3-4 steps** with a manager sanity check | Compounding reliability math bites hard past ~8 steps regardless of per-step score |
| Multi-file refactor, architecture-touching change, or any task requiring disambiguating an underspecified request | Commander/frontier tier only — do not delegate down | Named failure mode across every source category (surveys, aggregators, official model positioning) |
| Anything where a malformed/incorrect tool call would be expensive to undo (destructive file ops, deploys, migrations) | Frontier tier, or cheap tier gated behind mandatory dry-run/confirmation | Syntactic validity does not imply semantic correctness (58% vs 97% gap) |
| Fully offline / zero-marginal-cost worker on a 32-128GB Mac | gpt-oss-20b (32GB+) or gpt-oss-120b (96-128GB) or Devstral (32GB+) | Only locally-runnable models with published SWE-bench Verified scores in the 46-62% band; treat as bottom tier, bounded-task only |

Practical guardrail for cezar's escalation ladder: track **per-worker task success**, not just malformed-output rate, since the literature's biggest surprise is that clean tool calls can still fail the task; and cap autonomous loop depth for any sub-Haiku-tier model rather than trusting it to self-terminate correctly on long horizons.

## 7. Confidence and gaps

- **High confidence**: Claude Haiku 4.5 pricing and headline SWE-bench Verified score (73.3%, $1/$5 per M tok) — corroborated by Anthropic's own announcement plus independent pricing trackers. Aider polyglot scores for GPT-5, Gemini 2.5 Pro/Flash, DeepSeek-V3.x/R1, Qwen3-235B (llm-stats.com aggregation of the actual public leaderboard, plausible model names/scores, internally consistent ordering). Devstral's 46.8% SWE-bench Verified and hardware footprint (matches Mistral's own original announcement). The general shape of "small models fail tool-calling more, and syntactic validity ≠ task success" — corroborated by multiple independent sources (dev.to benchmark, SLM survey, ToolFailBench).
- **Medium confidence**: gpt-oss-20b/120b SWE-bench Verified figures (60.7%/62.4%) and Qwen3-Coder/GLM-4.6/Kimi K2 SWE-bench Verified scores — plausible and roughly consistent with known model positioning, but sourced through secondary/aggregator coverage rather than the labs' own benchmark pages, which I did not independently confirm within the search budget.
- **Low confidence / flag for follow-up**: Several 2026-dated sources (morphllm.com, benchlm.ai, localaimaster.com, promptquorum.com, usagebox.com) reference model names and cost-per-task figures I could not cross-verify against a primary source in this pass — e.g. "$0.078/task" for Gemini 2.5 Flash, "80x cheaper" framings, and newer-generation model names (GPT-5.4-mini/nano, DeepSeek V4, Qwen3.6/3.7, Kimi K2.6/K3, GLM-5.x, "Claude Fable/Opus 5"). These read as plausible given the pace of releases through 2026, and the GPT-5.4-mini/nano SWE-bench Pro figures came from multiple independent-looking outlets, but the underlying content style (programmatically-generated SEO comparison pages) is a known pattern for fabricated or extrapolated benchmark tables — treat any number attributed only to these domains as directional, not authoritative, until checked against the vendor's own benchmark page or a leaderboard site (swebench.com, gorilla.cs.berkeley.edu) directly.
- **Gap**: I did not find a clean, single-table comparison of *agentic loop completion rate* (full end-to-end autonomous task success, not just per-call tool reliability) broken out by cheap-vs-frontier tier at matched task difficulty — the compounding-reliability argument in §5 is inferred from a generic per-call reliability figure, not a cheap-model-specific study.
- **Gap**: No local-Mac-specific benchmark run (tokens/sec plus quantized-accuracy degradation) was found for the actual candidate models (gpt-oss, Devstral, Qwen3 dense) at Q4/Q5 quantization on M-series hardware — the SWE-bench scores cited are presumably full-precision/vendor-reported, and quantization on consumer Mac hardware likely costs additional accuracy not captured in §2's table.
- Search budget used: 15 calls (searches + fetches); one direct fetch (morphllm.com/swe-bench-pro) returned HTTP 429 and could not be retried within budget — SWE-bench Pro coverage in this report leans on search-snippet summaries rather than that page directly.
