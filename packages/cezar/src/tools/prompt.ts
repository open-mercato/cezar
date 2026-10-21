import { isOn } from './runtime.ts';
import { TOOL_IDS } from './registry.ts';

/**
 * The agent is told about `cezar tools` only when it can use it: installs are on
 * (`CEZ_TOOL_INSTALL`) AND the cockpit's own entrypoint (`CEZ_BIN`, set by `serve`) is known —
 * a headless `cezar run` has no such path, and describing a command the agent cannot run would
 * only teach it to give up.
 */
export function toolsReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.CEZ_TOOL_INSTALL) && Boolean(env.CEZ_BIN);
}

export const TOOLS_PROMPT = `Test toolchains. If the task needs Flutter, the Android SDK/emulator, a JDK or the iOS Simulator and it is not installed, install it yourself instead of stopping — always through the cockpit's own binary:

  node "$CEZ_BIN" tools ensure <id…>       ids: ${TOOL_IDS.join(', ')}; prints what it did, then shell exports (eval them, or run: node "$CEZ_BIN" tools env)
  node "$CEZ_BIN" tools emulator start      boots the headless Android emulator and prints its serial (emulator-5554)
  node "$CEZ_BIN" tools simulator boot      boots an iOS Simulator (macOS with Xcode) and prints its UDID

Installs go to a private directory (no sudo), are safe to run from parallel tasks, and are skipped when already present. The iOS Simulator needs Xcode, which cannot be installed this way: if it reports so, say it in your final message. Tools already installed are on your PATH.`;
