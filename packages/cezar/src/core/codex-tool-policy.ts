import { DEFAULT_ALLOWED_TOOLS, type AgentRunSpec } from './agent-runner.ts';

/**
 * App-server approvals are not a universal pre-execution hook. In particular, a read-only
 * filesystem sandbox does not constrain MCP or remote mutations. Until a verified transport
 * can enforce the whole grant, restricted invocations must not spawn, even in mixed workflows.
 */
export function assertCodexToolPolicy(spec: Pick<AgentRunSpec,
  'allowedTools' | 'bashAllowlist' | 'bashHookCommand' | 'enforceReadOnly'
>): void {
  const tools = spec.allowedTools;
  const unrestricted = tools === undefined || (
    tools.length === DEFAULT_ALLOWED_TOOLS.length &&
    DEFAULT_ALLOWED_TOOLS.every((tool) => tools.includes(tool))
  );
  if (!spec.enforceReadOnly && spec.bashAllowlist === undefined && !spec.bashHookCommand && unrestricted) return;
  throw new Error('codex: tool-policy enforcement unavailable; refusing to start a restricted step. '
    + 'The app-server has no verified gate for every shell, filesystem, MCP and nested tool call. '
    + 'A read-only sandbox or approval prompt is insufficient. Pick Claude Code or Pi; '
    + 'cezar will not discard allowedTools, bashAllowlist or enforceReadOnly.');
}
