#!/usr/bin/env node
// Stub `claude` binary reproducing the teardown shape of #703: it emits one
// assistant turn, then NEVER exits on its own — it ignores stdin EOF (the
// janitor-confirmed CLI hang the EOF watchdog exists for) and handles SIGTERM
// itself, exiting 143 instead of dying from the signal.

process.on('SIGTERM', () => process.exit(143));

process.stdout.write(
  `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'work done' }] },
  })}\n`,
);

// Keep the event loop alive and stay deaf to EOF, exactly like the real hang.
process.stdin.resume();
process.stdin.on('end', () => {});
setInterval(() => {}, 60_000);
