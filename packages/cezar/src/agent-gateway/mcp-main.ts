/**
 * Lean entry for `cezar mcp`: what `cezar integrations print` tells Hermes/OpenClaw to launch.
 *
 * `dist/index.js` statically imports the whole service (server, runs, workflows) before it looks at
 * argv, which is seconds of module loading on a cold or slow filesystem — and MCP hosts give a server
 * ~5 s to answer `initialize` (OpenClaw does; found live in a Docker bind mount, 10 s). This file
 * imports only the MCP server, so the handshake does not pay for a cockpit it never starts.
 */
import { runMcpCommand } from './mcp-server.ts';

process.exitCode = await runMcpCommand(process.argv.slice(2));
