/**
 * Pins claude binary resolution for suites that assert the executable LITERALLY.
 *
 * `resolveClaudeBin` probes PATH and then the installers' known locations, so on a developer
 * machine it answers with an absolute path like `/Users/me/.local/bin/claude`. Several suites
 * build a `runCommand` fixture that dispatches on `executable === 'claude'` and falls through to
 * another provider's fixture otherwise — so an absolute path does not fail one assertion, it
 * silently makes the claude probe parse some other CLI's output and report the wrong status.
 *
 * That made those suites pass or fail depending on where claude happens to be installed on the
 * host running them, and fail on precisely the off-PATH installs the resolver exists to support.
 * Pin resolution to the environment override and the bare name; `claude-bin.test.ts` keeps the
 * real resolver's own coverage.
 *
 * Usage, with the path adjusted to the importing file:
 *
 *     vi.mock('../core/claude-bin.ts', async (importOriginal) => {
 *       const { pinClaudeBin } = await import('../core/claude-bin.testkit.ts');
 *       return pinClaudeBin(await importOriginal());
 *     });
 */
export function pinClaudeBin<T extends object>(actual: T): T {
  return {
    ...actual,
    resolveClaudeBin: (env: NodeJS.ProcessEnv = process.env) => env.CEZ_CLAUDE_BIN || 'claude',
    // null = "a bare `claude` is the best answer", so the terminal handoff keeps the portable
    // command these suites assert instead of a host-specific absolute path.
    claudeShellCommand: (env: NodeJS.ProcessEnv = process.env) => env.CEZ_CLAUDE_BIN || null,
  };
}
