export class CodexToolPolicyError extends Error {
  constructor(detail = 'this tool grant is unsupported', outcome = 'Refusing this restricted step; no model turn was started. Pick Claude Code or Pi for unsupported grants.') {
    super(`codex: tool-policy enforcement unavailable — ${detail}. ${outcome}`);
    this.name = 'CodexToolPolicyError';
  }
}
