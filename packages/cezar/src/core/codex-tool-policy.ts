export class CodexToolPolicyError extends Error {
  constructor(detail = 'this tool grant is unsupported') {
    super(`codex: tool-policy enforcement unavailable — ${detail}. Refusing this restricted step; no model turn was started. Pick Claude Code or Pi for unsupported grants.`);
    this.name = 'CodexToolPolicyError';
  }
}
