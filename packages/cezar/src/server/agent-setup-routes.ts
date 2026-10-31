import { homedir } from 'node:os';

import {
  agentSetupSessionParamsSchema,
  agentSetupSessionSchema,
  agentSetupStartSchema,
  agentSetupStateSchema,
  terminalInputSchema,
  terminalOutputQuerySchema,
  terminalOutputSchema,
  terminalResizeSchema,
  type AgentSetupAction,
  type AgentSetupProvider,
  type ProviderStatusResponse,
} from '@open-mercato/cezar-contract';
import { Hono } from 'hono';

import { AGENT_SETUP_PROVIDERS, installCommand, probeInstallEnv, type InstallEnv } from './agent-setup.ts';
import type { PtyBinding } from './terminal/pty-module.ts';
import type { TerminalSessionInfo, TerminalSessions } from './terminal/sessions.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';

/** The owner key of setup sessions. Never a run id, so no task's terminal routes reach one by accident. */
export const AGENT_SETUP_OWNER = 'agent-setup';
const INSTALL_ENV_TTL_MS = 30_000;
/** Dry-run mocks the agents: nothing is installed and nobody signs in. */
const DRY_RUN_COMMAND = 'echo dry run: nothing was installed or signed in';

export interface AgentSetupDeps {
  sessions: TerminalSessions;
  loadPty: () => Promise<PtyBinding>;
  /** The policy half of "can a setup terminal open here"; null means yes. */
  refusal: () => string | null;
  status: () => Promise<ProviderStatusResponse>;
  loginCommand: (provider: AgentSetupProvider) => string | null;
  installHint: (provider: AgentSetupProvider) => string;
  /** Makes output reach the cockpit: the same cursor-only topic a task's terminal has. */
  registerTopic: (sessionId: string) => void;
  topic: (sessionId: string) => string;
  /** A login terminal opened: the same telemetry and status watch `POST /providers/connect` has. */
  onLoginOpened: (provider: AgentSetupProvider, status: 'disconnected' | 'unknown', sid: string | undefined) => void;
  deviceSid: (header: string | undefined) => string | undefined;
  probeEnv?: () => Promise<InstallEnv>;
}

/**
 * `/api/v1/providers/setup` (spec 2026-10-26-first-run-onboarding, "Set up an agent here"): one
 * server-chosen install or login command in a PTY, on the machine the user is at. One at a time,
 * because two installs would race for the same global folder. Runs in the home folder: a project's
 * `.npmrc` must not get to redirect an install, nor its agent config a login.
 */
export function agentSetupRoutes(deps: AgentSetupDeps) {
  const probe = deps.probeEnv ?? probeInstallEnv;
  let envCache: { at: number; env: Promise<InstallEnv> } | null = null;
  const installEnv = (): Promise<InstallEnv> => {
    if (!envCache || Date.now() - envCache.at > INSTALL_ENV_TTL_MS) envCache = { at: Date.now(), env: probe() };
    return envCache.env;
  };

  let current: { id: string; provider: AgentSetupProvider; action: AgentSetupAction; command: string } | null = null;
  let starting = false;

  const describe = (info: TerminalSessionInfo) =>
    current
      ? agentSetupSessionSchema.parse({ ...info, topic: deps.topic(info.id), provider: current.provider, action: current.action, command: current.command })
      : null;
  const currentInfo = (): TerminalSessionInfo | null => {
    const info = current ? deps.sessions.get(current.id) : null;
    if (!info) current = null;
    return info ?? null;
  };
  const owned = (sessionId: string): TerminalSessionInfo | null => {
    const info = deps.sessions.get(sessionId);
    return info && info.runId === AGENT_SETUP_OWNER ? info : null;
  };
  const refusal = async (): Promise<string | null> => {
    const policy = deps.refusal();
    if (policy) return policy;
    const binding = await deps.loadPty();
    return binding.available ? null : binding.reason;
  };

  return new Hono()
    .get('/providers/setup', async (c) => {
      c.header('Cache-Control', 'no-store');
      const reason = await refusal();
      if (reason) return c.json(agentSetupStateSchema.parse({ available: false, reason }));
      const env = await installEnv();
      const info = currentInfo();
      return c.json(agentSetupStateSchema.parse({
        available: true,
        agents: AGENT_SETUP_PROVIDERS.map((provider) => ({
          provider,
          installCommand: installCommand(provider, env),
          installHint: deps.installHint(provider),
          loginCommand: deps.loginCommand(provider),
        })),
        session: info ? describe(info) : null,
      }));
    })
    .post('/providers/setup/sessions', jsonZodValidator(agentSetupStartSchema), async (c) => {
      const reason = await refusal();
      if (reason) return c.json({ error: reason }, 409);
      const { provider, action, cols, rows } = c.req.valid('json');
      const live = currentInfo();
      if (live?.exitCode === null) {
        // A double click or a second tab joins the session already running.
        if (current?.provider === provider && current.action === action) return c.json(agentSetupSessionSchema.parse(describe(live)), 200);
        return c.json({ error: 'Another agent is being set up. Finish or cancel it first.' }, 409);
      }
      if (starting) return c.json({ error: 'Another agent is being set up. Finish or cancel it first.' }, 409);
      starting = true;
      try {
        const dryRun = process.env.CEZ_DRY_RUN === '1';
        const row = dryRun ? undefined : (await deps.status()).providers.find((candidate) => candidate.provider === provider);
        if (!dryRun && !row) return c.json({ error: 'The agent could not be checked. Try again.' }, 500);
        // The status decides, so a stale page can neither reinstall an agent nor sign in to a missing one.
        if (action === 'install' && row && row.status !== 'not-installed') return c.json({ error: 'This agent is already installed.' }, 409);
        if (action === 'login' && row?.status === 'not-installed') return c.json({ error: 'Install this agent first.' }, 409);
        if (action === 'login' && row?.status === 'connected') return c.json({ error: 'This agent is already signed in.' }, 409);
        const command = action === 'install' ? installCommand(provider, await installEnv()) : deps.loginCommand(provider);
        if (command === null) return c.json({ error: deps.installHint(provider) }, 409);
        if (live && current) deps.sessions.kill(current.id);
        const created = await deps.sessions.create({
          runId: AGENT_SETUP_OWNER,
          cwd: homedir(),
          command: dryRun ? DRY_RUN_COMMAND : command,
          label: `${provider} ${action}`,
          ...(cols !== undefined ? { cols } : {}),
          ...(rows !== undefined ? { rows } : {}),
        });
        if (!created.ok) return c.json({ error: created.reason }, 409);
        current = { id: created.session.id, provider, action, command };
        deps.registerTopic(created.session.id);
        if (action === 'login' && row) {
          deps.onLoginOpened(provider, row.status === 'unknown' ? 'unknown' : 'disconnected', deps.deviceSid(c.req.header('x-cezar-sid')));
        }
        return c.json(agentSetupSessionSchema.parse(describe(created.session)), 201);
      } finally {
        starting = false;
      }
    })
    .get(
      '/providers/setup/sessions/:sessionId/output',
      paramZodValidator(agentSetupSessionParamsSchema),
      queryZodValidator(terminalOutputQuerySchema),
      async (c) => {
        const info = owned(c.req.valid('param').sessionId);
        if (!info) return c.json({ error: 'setup session not found' }, 404);
        const reason = deps.refusal();
        if (reason) return c.json({ error: reason }, 409);
        const read = deps.sessions.read(info.id, c.req.valid('query').cursor ?? 0);
        if (!read) return c.json({ error: 'setup session not found' }, 404);
        c.header('Cache-Control', 'no-store');
        return c.json(terminalOutputSchema.parse(read));
      },
    )
    .post(
      '/providers/setup/sessions/:sessionId/input',
      paramZodValidator(agentSetupSessionParamsSchema),
      jsonZodValidator(terminalInputSchema),
      async (c) => {
        const info = owned(c.req.valid('param').sessionId);
        if (!info) return c.json({ error: 'setup session not found' }, 404);
        const reason = deps.refusal();
        if (reason) return c.json({ error: reason }, 409);
        return c.json({ delivered: deps.sessions.write(info.id, c.req.valid('json').data) });
      },
    )
    .post(
      '/providers/setup/sessions/:sessionId/resize',
      paramZodValidator(agentSetupSessionParamsSchema),
      jsonZodValidator(terminalResizeSchema),
      async (c) => {
        const info = owned(c.req.valid('param').sessionId);
        if (!info) return c.json({ error: 'setup session not found' }, 404);
        const reason = deps.refusal();
        if (reason) return c.json({ error: reason }, 409);
        const { cols, rows } = c.req.valid('json');
        return c.json({ resized: deps.sessions.resize(info.id, cols, rows) });
      },
    )
    // Not policy-gated, like a task's terminal: stopping a process only ever reduces exposure.
    .delete('/providers/setup/sessions/:sessionId', paramZodValidator(agentSetupSessionParamsSchema), (c) => {
      const info = owned(c.req.valid('param').sessionId);
      if (!info) return c.json({ error: 'setup session not found' }, 404);
      deps.sessions.kill(info.id);
      return c.json({ stopped: true });
    });
}
