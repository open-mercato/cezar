#!/usr/bin/env node
// Stub `claude` binary: reports how it was told to load MCP servers, then ends its turn.

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const text = `claudeai=${process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? 'unset'} strict=${process.argv.includes('--strict-mcp-config')}`;
emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
emit({ type: 'result', subtype: 'success', result: text, usage: { input_tokens: 1, output_tokens: 1 } });
