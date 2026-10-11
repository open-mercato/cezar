import { nodeShimIo, runShim } from './shim.ts';

// Entry point of the shadow shim (spec 2026-10-06-shadow-runs). Started by the generated `gh`
// wrappers and by the shadow remotes' `pre-receive` hooks; all logic lives in `shim.ts`, where it
// can be tested without spawning anything.
process.exitCode = runShim(nodeShimIo(process.argv.slice(2)));
