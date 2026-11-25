import { homedir } from 'node:os';
import { basename } from 'node:path';

import {
  AGENT_SETUP_FORCE_HEADER,
  AGENT_SETUP_LATEST_HEADER,
  agentSetupSessionParamsSchema,
  agentSetupSessionSchema,
  agentSetupStartSchema,
  agentSetupStateSchema,
  terminalInputSchema,
  terminalOutputQuerySchema,
  terminalOutputSchema,
  terminalResizeSchema,
  type AgentSetupAction,
  type AgentSetupEntry,
  type AgentSetupProvider,
  type AgentSetupSession,
  type AgentSetupState,
  type TerminalOutput,
  type ProviderStatusResponse,
} from '@open-mercato/cezar-contract';
import { Hono } from 'hono';

import { minimumVersion, type LatestVersions } from '../core/agent-cli-versions.ts';
import { locateInstalledCli, planInstall, planUpdate, recipeFor, type CommandPlan, type InstalledCli } from '../core/agent-install.ts';
import { detectEnvironment, type BackendCheck } from '../core/backend-detect.ts';
import { cliVersionFrom } from '../core/provider-auth.ts';
import { AGENT_SETUP_PROVIDERS, probeInstallEnv, shellLine, type InstallEnv } from './agent-setup.ts';
import type { PtyBinding } from './terminal/pty-module.ts';
import type { TerminalSessionInfo, TerminalSessions } from './terminal/sessions.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';

/** The owner key of setup sessions. Never a run id, so no task's terminal routes reach one by accident. */
export const AGENT_SETUP_OWNER = 'agent-setup';
const INSTALL_ENV_TTL_MS = 30_000;
/** `--version` of eleven CLIs is ~1 s: a page polling the state must not pay it every second. */
const CHECKS_TTL_MS = 15_000;
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
  /** The provider status as cached, for the listing; `status` refreshes and decides a start. */
  currentStatus?: () => Promise<ProviderStatusResponse>;
  /** Each CLI's `--version` (the health probe). */
  checks?: () => Promise<BackendCheck[]>;
  /** What cezar spawns for this agent, so its binary and install method can be found. */
  executable?: (provider: AgentSetupProvider) => string;
  /** Where the binary was found and how it was installed; a seam for tests. */
  locate?: (executable: string) => InstalledCli;
  /** Tasks running on this agent now. */
  activeRuns?: (provider: AgentSetupProvider) => number | Promise<number>;
  /** The newest release, read only when the request sets `AGENT_SETUP_LATEST_HEADER`. */
  latest?: LatestVersions;
  /** The request came through a paired phone: no typing, and nothing that needs a password. */
  phone?: () => boolean;
}

/**
 * A command as a paired phone may see it: an absolute binary path (it names the user's home) cut to
 * the program's name, the way `/workspace/agent-profiles` withholds host paths from phones.
 */
export function withoutHostPaths(command: string): string;
export function withoutHostPaths(command: string | null): string | null;
export function withoutHostPaths(command: string | null): string | null {
  if (command === null) return null;
  return command
    // Single-quoted POSIX absolute paths, including shell-escaped apostrophes (`'\''`).
    .replace(/'(\/(?:[^']|'\\'')*)'/g, (match, inner: string) => {
      const base = inner.slice(inner.lastIndexOf('/') + 1);
      return base ? `'${base}'` : match;
    })
    // Double-quoted Windows drive paths (backslash or forward-slash) and UNC paths.
    .replace(/"(?:[A-Za-z]:[\\/]|(?:\\\\|\/\/)[^"\\/]+[\\/][^"\\/]+[\\/])(?:[^"\\/]*[\\/])*([^"\\/]+)"/g, '"$1"')
    // Bare Windows drive or UNC paths.
    .replace(/(^|\s)(?:[A-Za-z]:[\\/]|(?:\\\\|\/\/)[^\s'"\\/]+[\\/][^\s'"\\/]+[\\/])(?:[^\s'"\\/]*[\\/])*([^\s'"\\/]+)/g, '$1$2')
    // Bare POSIX absolute paths.
    .replace(/(^|\s)(?:\/[^\s'"\/]+)+\/([^\s'"\/]+)/g, '$1$2');
}

/** What a phone gets per agent: no sign-in line (it may carry an account's folder), and no paths. */
const forPhone = (agent: AgentSetupEntry): AgentSetupEntry => ({
  ...agent,
  loginCommand: null,
  update: agent.update ? { ...agent.update, command: withoutHostPaths(agent.update.command) } : null,
});

/** Every refusal in this family is `{ error }` and nothing more: the typed API sits at the
 *  compiler's size limit (TS7056), and a second error shape tipped it over on Windows (#2474).
 *  A command to copy is already in the listing. */
const refusal = (error: string): { error: string } => ({ error });

const plan = (value: CommandPlan): AgentSetupEntry['install'] =>
  ({ command: value.command, runnable: value.runnable, sudo: value.sudo });

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

  let checksCache: { at: number; checks: Promise<BackendCheck[]> } | null = null;
  const checks = (): Promise<BackendCheck[]> => {
    if (!checksCache || Date.now() - checksCache.at > CHECKS_TTL_MS) checksCache = { at: Date.now(), checks: (deps.checks ?? detectEnvironment)() };
    return checksCache.checks;
  };
  const phone = () => deps.phone?.() ?? false;
  // Walking PATH for every agent on each poll is wasted while nothing changes: cached like the
  // checks, and dropped with them when an install or update ends.
  let located: { at: number; byProvider: Map<AgentSetupProvider, InstalledCli> } | null = null;
  const locate = (provider: AgentSetupProvider): InstalledCli => {
    if (!located || Date.now() - located.at > CHECKS_TTL_MS) located = { at: Date.now(), byProvider: new Map() };
    const known = located.byProvider.get(provider);
    if (known) return known;
    const executable = deps.executable?.(provider) ?? provider;
    const found = (deps.locate ?? locateInstalledCli)(executable);
    located.byProvider.set(provider, found);
    return found;
  };
  const updatePlan = (provider: AgentSetupProvider, env: InstallEnv): CommandPlan | null => planUpdate(provider, locate(provider), env);

  /** Everything the sheet shows for one agent: the commands, the versions, and what blocks an update. */
  const entries = async (withLatest: boolean, status: ProviderStatusResponse): Promise<AgentSetupEntry[]> => {
    const [env, found] = await Promise.all([installEnv(), checks().catch(() => [] as BackendCheck[])]);
    return Promise.all(AGENT_SETUP_PROVIDERS.map(async (provider): Promise<AgentSetupEntry> => {
      const row = status.providers.find((candidate) => candidate.provider === provider);
      const check = found.find((candidate) => candidate.name === provider);
      const installed = check?.available === true || (row ? row.status !== 'not-installed' : false);
      const recipe = recipeFor(provider);
      const installPlan = planInstall(provider, env);
      const where = installed ? locate(provider) : null;
      const update = installed && where ? planUpdate(provider, where, env) : null;
      const version = check?.version ? cliVersionFrom(check.version) : null;
      const minVersion = minimumVersion(provider);
      const latestVersion = installed && withLatest && deps.latest ? await deps.latest.latest(provider) : null;
      return {
        provider,
        loginCommand: deps.loginCommand(provider),
        install: plan(installPlan),
        update: update ? plan(update) : null,
        docsUrl: recipe.docsUrl,
        installed,
        version,
        method: where?.method ?? null,
        minVersion,
        latestVersion,
        activeRuns: await (deps.activeRuns?.(provider) ?? 0),
      };
    }));
  };

  let current: { id: string; provider: AgentSetupProvider; action: AgentSetupAction; command: string } | null = null;
  let starting = false;

  const describe = (info: TerminalSessionInfo) =>
    current
      ? agentSetupSessionSchema.parse({ ...info, topic: deps.topic(info.id), provider: current.provider, action: current.action, command: current.command })
      : null;
  /** What each setup session runs, by id: a phone may read install and update logs only. */
  const actions = new Map<string, AgentSetupAction>();
  /** The install or update whose end already cleared the version cache. */
  let refreshedAfter: string | null = null;
  /** Fresh provider-status probe kicked off when an install/update exits so concurrent setup polls
   *  do not read a stale `not-installed` cache while the refresh is in flight. */
  let statusRefresh: Promise<ProviderStatusResponse> | null = null;
  // An install or update changes `--version` and provider availability: re-probe both on exit.
  const afterEnd = (id: string, action: AgentSetupAction) => {
    if (action === 'login' || refreshedAfter === id) return;
    refreshedAfter = id;
    checksCache = null;
    located = null;
    const refresh = deps.status().finally(() => {
      if (statusRefresh === refresh) statusRefresh = null;
    });
    void refresh.catch(() => {});
    statusRefresh = refresh;
  };
  const currentInfo = (): TerminalSessionInfo | null => {
    const info = current ? deps.sessions.get(current.id) : null;
    if (current && (!info || info.exitCode !== null)) afterEnd(current.id, current.action);
    if (!info) current = null;
    return info ?? null;
  };
  /** A sign-in's screen carries its OAuth link and device code: never a phone's to read. */
  const phoneMayRead = (sessionId: string) => !phone() || (actions.get(sessionId) ?? 'login') !== 'login';
  const owned = (sessionId: string): TerminalSessionInfo | null => {
    const info = deps.sessions.get(sessionId);
    return info && info.runId === AGENT_SETUP_OWNER ? info : null;
  };
  /** Every session body a phone receives goes through here: no host path reaches it. */
  const shown = (session: AgentSetupSession): AgentSetupSession =>
    phone()
      ? {
          ...session,
          command: withoutHostPaths(session.command),
          cwd: '~',
          shell: basename(session.shell.replaceAll('\\', '/')) || session.shell,
        }
      : session;
  const unavailable = async (): Promise<string | null> => {
    const policy = deps.refusal();
    if (policy) return policy;
    const binding = await deps.loadPty();
    return binding.available ? null : binding.reason;
  };



  return new Hono()
    .get('/providers/setup', async (c) => {
      c.header('Cache-Control', 'no-store');
      // First: a session that just ended clears the version cache before the listing reads it.
      const info = currentInfo();
      const status = await (statusRefresh ?? (deps.currentStatus ?? deps.status)()).catch((): ProviderStatusResponse => ({ providers: [] }));
      const agents = await entries(c.req.header(AGENT_SETUP_LATEST_HEADER) === '1', status);
      const reason = await unavailable();
      // Refused (hosted, terminal off): the install lines and docs still help, but nothing is
      // runnable here and a sign-in or update line names the host's binary path.
      if (reason) {
        const safe = agents.map((agent) => ({
          ...agent,
          loginCommand: null,
          install: { ...agent.install, runnable: false },
          update: agent.update ? { ...agent.update, command: null, runnable: false } : null,
        }));
        const refused: AgentSetupState = agentSetupStateSchema.parse({ available: false, reason, interactive: false, agents: safe, session: null });
        return c.json(refused);
      }
      const described = info && phoneMayRead(info.id) ? describe(info) : null;
      const session: AgentSetupSession | null = described ? shown(described) : null;
      const listed: AgentSetupEntry[] = phone() ? agents.map(forPhone) : agents;
      const state: AgentSetupState = agentSetupStateSchema.parse({ available: true, reason: null, agents: listed, interactive: !phone(), session });
      return c.json(state);
    })
    .post('/providers/setup/sessions', jsonZodValidator(agentSetupStartSchema), async (c) => {
      const reason = await unavailable();
      if (reason) return c.json(refusal(reason), 409);
      const { provider, action, cols, rows } = c.req.valid('json');
      const force = c.req.header(AGENT_SETUP_FORCE_HEADER) === '1';
      // A phone may start only what needs nobody at the computer: a sign-in has the card for that.
      if (phone() && action === 'login') return c.json(refusal('Sign in from the sign-in card, or finish on your computer.'), 409);
      const live = currentInfo();
      if (live?.exitCode === null) {
        // A double click or a second tab joins the session already running (a phone never a sign-in's).
        if (current?.provider === provider && current.action === action && phoneMayRead(live.id)) {
          const joined: AgentSetupSession = shown(agentSetupSessionSchema.parse(describe(live)));
          return c.json(joined, 201);
        }
        return c.json(refusal('Another agent is being set up. Finish or cancel it first.'), 409);
      }
      if (starting) return c.json(refusal('Another agent is being set up. Finish or cancel it first.'), 409);
      starting = true;
      try {
        const dryRun = process.env.CEZ_DRY_RUN === '1';
        const row = dryRun ? undefined : (await deps.status()).providers.find((candidate) => candidate.provider === provider);
        if (!dryRun && !row) return c.json(refusal('The agent could not be checked. Try again.'), 409);
        // The status decides, so a stale page can neither reinstall an agent nor sign in to a missing one.
        if (action === 'install' && row && row.status !== 'not-installed') return c.json(refusal('This agent is already installed.'), 409);
        if (action !== 'install' && row?.status === 'not-installed') return c.json(refusal('Install this agent first.'), 409);
        if (action === 'login' && row?.status === 'connected') return c.json(refusal('This agent is already signed in.'), 409);
        let command: string | null;
        if (action === 'login') {
          command = deps.loginCommand(provider);
          if (command === null) return c.json(refusal(deps.installHint(provider)), 409);
        } else {
          const env = await installEnv();
          const chosen = action === 'install' ? planInstall(provider, env) : updatePlan(provider, env);
          if (!chosen?.runnable || !chosen.command) {
            const copyOnly = recipeFor(provider).copyOnly;
            const error = copyOnly ?? (action === 'install' ? deps.installHint(provider) : 'cezar does not run this update itself. Run it in a terminal.');
            return c.json(refusal(error), 409);
          }
          if (phone() && chosen.sudo) return c.json(refusal('This needs your computer password. Finish it on your computer.'), 409);
          const running = await (deps.activeRuns?.(provider) ?? 0);
          if (action === 'update' && running > 0 && !force) {
            return c.json(refusal(`${running} task${running === 1 ? ' is' : 's are'} running on this agent. Update when they finish, or update now.`), 409);
          }
          command = chosen.command;
        }
        if (live && current) deps.sessions.kill(current.id);
        const created = await deps.sessions.create({
          runId: AGENT_SETUP_OWNER,
          cwd: homedir(),
          command: dryRun ? DRY_RUN_COMMAND : shellLine(command, process.platform),
          label: `${provider} ${action}`,
          ...(cols !== undefined ? { cols } : {}),
          ...(rows !== undefined ? { rows } : {}),
        });
        if (!created.ok) return c.json(refusal(created.reason), 409);
        current = { id: created.session.id, provider, action, command };
        for (const id of actions.keys()) if (!deps.sessions.get(id)) actions.delete(id);
        actions.set(created.session.id, action);
        // The exit itself clears the version cache: no later GET is needed for it.
        const sessionId = created.session.id;
        const release = deps.sessions.subscribe(sessionId, () => {
          const ended = deps.sessions.get(sessionId);
          if (ended && ended.exitCode === null) return;
          afterEnd(sessionId, action);
          release();
        });
        deps.registerTopic(created.session.id);
        if (action === 'login' && row) {
          deps.onLoginOpened(provider, row.status === 'unknown' ? 'unknown' : 'disconnected', deps.deviceSid(c.req.header('x-cezar-sid')));
        }
        const body: AgentSetupSession = shown(agentSetupSessionSchema.parse(describe(created.session)));
        return c.json(body, 201);
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
        if (!info) return c.json(refusal('setup session not found'), 404);
        const reason = deps.refusal();
        if (reason) return c.json(refusal(reason), 409);
        if (!phoneMayRead(info.id)) return c.json(refusal('A sign-in is shown only on the computer.'), 409);
        const read = deps.sessions.read(info.id, c.req.valid('query').cursor ?? 0);
        if (!read) return c.json(refusal('setup session not found'), 404);
        c.header('Cache-Control', 'no-store');
        const output: TerminalOutput = terminalOutputSchema.parse(read);
        return c.json(output);
      },
    )
    .post(
      '/providers/setup/sessions/:sessionId/input',
      paramZodValidator(agentSetupSessionParamsSchema),
      jsonZodValidator(terminalInputSchema),
      async (c) => {
        const info = owned(c.req.valid('param').sessionId);
        if (!info) return c.json(refusal('setup session not found'), 404);
        const reason = deps.refusal();
        if (reason) return c.json(refusal(reason), 409);
        // Read-only on a phone: a password or an answer goes in at the computer.
        if (phone()) return c.json(refusal('The terminal is read-only on your phone.'), 409);
        return c.json({ delivered: deps.sessions.write(info.id, c.req.valid('json').data) });
      },
    )
    .post(
      '/providers/setup/sessions/:sessionId/resize',
      paramZodValidator(agentSetupSessionParamsSchema),
      jsonZodValidator(terminalResizeSchema),
      async (c) => {
        const info = owned(c.req.valid('param').sessionId);
        if (!info) return c.json(refusal('setup session not found'), 404);
        const reason = deps.refusal();
        if (reason) return c.json(refusal(reason), 409);
        if (!phoneMayRead(info.id)) return c.json(refusal('A sign-in is shown only on the computer.'), 409);
        // The computer is the one typing: a phone viewer must not reflow its terminal.
        if (phone()) return c.json(refusal('The terminal is read-only on your phone.'), 409);
        const { cols, rows } = c.req.valid('json');
        return c.json({ resized: deps.sessions.resize(info.id, cols, rows) });
      },
    )
    // Not policy-gated, like a task's terminal: stopping a process only ever reduces exposure.
    .delete('/providers/setup/sessions/:sessionId', paramZodValidator(agentSetupSessionParamsSchema), (c) => {
      const info = owned(c.req.valid('param').sessionId);
      if (!info) return c.json(refusal('setup session not found'), 404);
      deps.sessions.kill(info.id);
      return c.json({ stopped: true });
    });
}
