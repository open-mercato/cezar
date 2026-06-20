import { z } from 'zod';

export const ConfigSchema = z.object({
  github: z
    .object({
      owner: z.string().default(''),
      repo: z.string().default(''),
      token: z.string().default(''),
    })
    .default({}),
  llm: z
    .object({
      model: z.string().default('claude-sonnet-4-20250514'),
      maxTokens: z.number().default(4096),
      apiKey: z.string().default(''),
    })
    .default({}),
  store: z
    .object({
      path: z.string().default('.issue-store'),
    })
    .default({}),
  sync: z
    .object({
      digestBatchSize: z.number().default(20),
      duplicateBatchSize: z.number().default(30),
      minDuplicateConfidence: z.number().default(0.8),
      includeClosed: z.boolean().default(false),
      labelBatchSize: z.number().default(20),
      missingInfoBatchSize: z.number().default(15),
      recurringBatchSize: z.number().default(15),
      priorityBatchSize: z.number().default(20),
      securityBatchSize: z.number().default(20),
      staleDaysThreshold: z.number().default(90),
      staleCloseDays: z.number().default(14),
      doneDetectorBatchSize: z.number().default(10),
      categorizeBatchSize: z.number().default(20),
      bugDetectorBatchSize: z.number().default(15),
    })
    .default({}),
  autofix: z
    .object({
      enabled: z.boolean().default(false),
      repoRoot: z.string().default(''),
      remote: z.string().default('origin'),
      baseBranch: z.string().default('main'),
      fetchBeforeAttempt: z.boolean().default(true),
      branchPrefix: z.string().default('autofix/cezar-issue-'),
      maxAttemptsPerIssue: z.number().default(2),
      maxConcurrent: z.number().default(1),
      tokenBudgetPerAttempt: z.number().default(250_000),
      ciFixMax: z.number().default(2),
      ciFixTokenBudget: z.number().default(120_000),
      // Wall-clock ceiling for a single agent session (analyzer / fixer /
      // reviewer). A session is bounded by maxTurns + tokenBudget, but neither
      // catches a network/server-side stall, so without this an attempt can
      // block forever. On timeout the session rejects, the worktree is disposed
      // and the attempt is recorded as failed. Default: 20 min.
      attemptTimeoutMs: z.number().default(20 * 60 * 1000),
      requireReviewPass: z.boolean().default(true),
      minBugConfidence: z.number().min(0).max(1).default(0.7),
      minAnalyzerConfidence: z.number().min(0).max(1).default(0.5),
      retryOnReviewFailure: z.boolean().default(true),
      allowedTools: z.array(z.string()).default(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']),
      bashAllowlist: z.array(z.string()).default([
        'npm test',
        'npm run typecheck',
        'npm run lint',
        'npm run build',
        'yarn',
        'yarn test',
        'yarn typecheck',
        'yarn lint',
        'yarn build',
        'git status',
        'git diff',
        'git log',
        'git show',
        // gh label management — lets agents apply the workspace label catalog
        // injected into their system prompt (see labels/label-catalog.ts).
        'gh issue edit',
        'gh issue view',
        'gh pr edit',
        'gh pr view',
      ]),
      setupCommands: z.array(z.string()).default([]),
      // Runnable project environment: how to install deps, build, and run tests
      // for the checked-out worktree so the autofix loop gets real build/test
      // feedback before opening a PR. `kind: 'auto'` picks `compose` when a
      // compose file is present in the repo, else `native` (host shell).
      // Compose requires a Docker daemon ⇒ self-hosted-runner only; the managed
      // cloud path can't run it.
      projectEnv: z
        .object({
          kind: z.enum(['auto', 'native', 'compose']).default('auto'),
          // Commands run inside the env. Empty ⇒ that check is skipped.
          install: z.string().default(''),
          build: z.string().default(''),
          test: z.string().default(''),
          compose: z
            .object({
              // '' ⇒ auto-detect (docker-compose.yml | docker-compose.yaml | compose.yml | compose.yaml).
              file: z.string().default(''),
              // The "app" service install/build/test run inside. '' ⇒ first service in the file.
              service: z.string().default(''),
              // Where the worktree is bind-mounted inside the app service.
              workdir: z.string().default('/app'),
            })
            .default({}),
          // Extra env vars injected into every command (compose: into the run; native: process env overlay).
          envVars: z.record(z.string(), z.string()).default({}),
          // When true, a non-zero exit of that check fails the run (build/test loop back to fix).
          gateOnInstall: z.boolean().default(true),
          gateOnBuild: z.boolean().default(false),
          gateOnTest: z.boolean().default(true),
          // Optional runnable dev server: booted once after install so the agent can
          // probe the live app (via `curl` over Bash) while diagnosing / fixing.
          // Disposed with the run env. Native binds `port` on the host; compose
          // publishes the container `port` to an ephemeral host port.
          devServer: z
            .object({
              enabled: z.boolean().default(false),
              // Native: the command to launch (e.g. `yarn dev`). Compose: optional —
              // empty ⇒ `up -d` the service with its own command.
              command: z.string().default(''),
              // The app's listen port: container port (compose) or host port (native).
              port: z.number().default(0),
              // Probed for readiness after launch (an HTTP response — any status — = up).
              readyPath: z.string().default('/'),
              readyTimeoutSec: z.number().default(60),
            })
            .default({}),
        })
        .default({}),
      draftPr: z.boolean().default(true),
      prLabels: z.array(z.string()).default(['cezar-autofix']),
      skillsDir: z.string().default('.ai/skills'),
      models: z
        .object({
          // Defaults bumped 2026-05-17: was claude-sonnet-4-20250514 (~6 months
          // old, slower per-turn). Sonnet 4.6 reaches the same conclusion in
          // fewer turns; Haiku 4.5 stays as the cheap reviewer.
          analyzer: z.string().default('claude-sonnet-4-6'),
          fixer: z.string().default('claude-sonnet-4-6'),
          reviewer: z.string().default('claude-haiku-4-5-20251001'),
        })
        .default({}),
      maxTurns: z
        .object({
          analyzer: z.number().default(15),
          fixer: z.number().default(30),
          reviewer: z.number().default(10),
        })
        .default({}),
      // Persistent-session controls — both default to staged/print behavior;
      // flipping a flag opts a workspace into the unified session path.
      runner: z
        .object({
          // 'print'       — spawn `claude -p <userPrompt>` per step.
          // 'stream-json' — spawn `claude --input-format stream-json` per step;
          //                 the user message is written to stdin and parsed
          //                 from the NDJSON output. Default since 2026-05 —
          //                 it's the prerequisite for `mode: 'unified'` and
          //                 has a faster startup path than `-p` even in
          //                 staged mode.
          transport: z.enum(['print', 'stream-json']).default('stream-json'),
          // 'staged'  — N separate `claude` sessions, one per agent step (one
          //             cold start + cold prompt cache each).
          // 'unified' — one long-lived `claude` session for the whole run with
          //             `## PHASE: <name>` markers driving step transitions;
          //             pays the cold start ONCE and lets every subsequent
          //             step ride Anthropic's prompt cache off the cumulative
          //             conversation prefix. Requires `transport: 'stream-json'`
          //             and forces backend='claude-cli'.
          mode: z.enum(['staged', 'unified']).default('staged'),
        })
        .default({}),
    })
    .default({}),
  // Optional GUI-equivalent binding block the CLI can supply from
  // `.issuemanagerrc.json`. Empty ⇒ built-in defaults.
  workflow: z
    .object({
      // Phase 3a: when true, `AutofixOrchestrator` delegates to the declarative
      // workflow engine (`runWorkflow`) instead of its hand-rolled path. Defaults
      // off ⇒ today's behavior is byte-identical.
      useEngine: z.boolean().default(false),
      bindings: z
        .array(
          z.object({
            stepId: z.string(),
            skillName: z.string().nullable().default(null),
            backend: z.enum(['anthropic-api', 'claude-cli', 'codex-cli']).nullable().default(null),
            model: z.string().nullable().default(null),
            extraTools: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      settings: z
        .object({
          autoTriageEnabled: z.boolean().default(true),
          autofixEnabled: z.boolean().default(false),
          separateCommentPerStep: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
