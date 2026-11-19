#!/usr/bin/env node
// Stub `claude` binary for telemetry 3ac6bbe3: after one assistant turn it exits 143 by itself —
// what claude's own SIGTERM handler does when the signal came from outside the runner.

process.stdout.write(
  `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'work done' }] },
  })}\n`,
);
setTimeout(() => process.exit(143), 300);
