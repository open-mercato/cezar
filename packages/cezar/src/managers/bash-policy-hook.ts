/**
 * Claude Code PreToolUse hook for a manager turn's Bash calls: reads the hook JSON on stdin and
 * answers with `managerBashHookDecision`. Any failure exits 2, which Claude treats as a block.
 */
import { managerBashHookDecision } from './bash-policy.ts';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool_name?: unknown; tool_input?: { command?: unknown } };
  if (input.tool_name !== 'Bash') return;
  const answer = managerBashHookDecision(input.tool_input?.command);
  if (!answer) return;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: answer.decision, permissionDecisionReason: answer.reason },
  })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`cezar manager policy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
