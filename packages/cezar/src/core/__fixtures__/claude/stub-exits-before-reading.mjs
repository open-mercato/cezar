#!/usr/bin/env node
// Stub `claude` binary that dies before reading stdin — a CLI that fails at startup
// (bad auth, missing runtime). cezar's pending prompt write then fails with EPIPE.
process.exit(1);
