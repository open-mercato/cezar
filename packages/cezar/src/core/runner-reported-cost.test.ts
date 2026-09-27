import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { PiRunner } from './pi-runner.ts';

// Exercise the public runner seam with wire-shaped reports from local stub processes.
// A cost of zero is a report; absent, malformed, and negative costs are not.
describe.each(['claude', 'opencode', 'pi'] as const)('%s reported cost', (backend) => {
  it.each([
    { label: 'zero', cost: 0, expected: [0] },
    { label: 'positive', cost: 0.125, expected: [0.125] },
    { label: 'missing', cost: undefined, expected: [] },
    { label: 'null', cost: null, expected: [] },
    { label: 'negative', cost: -1, expected: [] },
    { label: 'string', cost: '0', expected: [] },
  ])('preserves $label without fabricating a report', async ({ cost, expected }) => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-cost-wire-'));
    const bin = join(dir, 'stub.mjs');
    const costField = cost === undefined ? {} : { cost };
    const frame = backend === 'claude'
      ? { type: 'result', subtype: 'success', ...(cost === undefined ? {} : { total_cost_usd: cost }) }
      : { type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, ...(cost === undefined ? {} : { cost: { total: cost } }) } } };
    // OpenCode's HTTP response and repeated SSE snapshots must not duplicate cost.
    const source = backend === 'opencode' ? `
import { createServer } from 'node:http';
let stream;
const info = ${JSON.stringify(costField)};
const server = createServer((req, res) => {
  req.resume();
  if (req.url === '/event') {
    stream = res;
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.flushHeaders();
  } else if (req.url === '/session') {
    res.end(JSON.stringify({id:'session-cost'}));
  } else {
    for (let i=0; i<2; i++) stream?.write('data: '+JSON.stringify({type:'message.updated',properties:{info:{id:'message-cost',role:'assistant',...info}}})+'\\n\\n');
    stream?.write('data: '+JSON.stringify({type:'session.idle',properties:{sessionID:'session-cost'}})+'\\n\\n');
    res.end(JSON.stringify(info));
  }
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:'+server.address().port));
` : `
process.stdin.once('data', () => {
  console.log(${JSON.stringify(JSON.stringify(frame))});
  process.stdin.destroy();
});
`;
    writeFileSync(bin, '#!/usr/bin/env node\n' + source, { mode: 0o700 });
    try {
      const Runner = backend === 'claude' ? ClaudeCliRunner : backend === 'pi' ? PiRunner : OpencodeServerRunner;
      const events: AgentEvent[] = [];
      await new Runner({ bin, timeoutMs: 5_000 }).run({ cwd: dir, userPrompt: 'report usage' }, (event) => events.push(event));
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(events.filter((event) => event.type === 'cost').map((event) => event.usd)).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
