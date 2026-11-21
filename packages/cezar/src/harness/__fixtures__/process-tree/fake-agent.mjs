#!/usr/bin/env node
// A detached agent that, like `opencode serve` or an EOF-ignoring CLI, outlives its stdin, with a
// tool child in its process group. Records both pids in its cwd for the test to watch.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const tool = spawn('sleep', ['60'], { stdio: 'ignore' });
writeFileSync('pids.json', JSON.stringify({ leader: process.pid, tool: tool.pid }));
// The leader goes, its tool child stays in the group — an orphaned background job or MCP server.
// A marker file, not an env var: the agent env is an allowlist.
if (existsSync('leader-exits')) {
  tool.unref();
  setTimeout(() => process.exit(0), 100);
}
process.stdin.resume();
process.stdin.on('error', () => {});
setInterval(() => {}, 60_000);
