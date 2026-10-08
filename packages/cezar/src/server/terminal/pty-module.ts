/**
 * The optional PTY binding (spec `.ai/specs/2026-10-07-task-workspace.md` §6, Milestone 2).
 *
 * `@lydell/node-pty` is an `optionalDependency`, and that choice is load-bearing rather than
 * incidental. cezar ships with ZERO native dependencies and zero install scripts today, and its
 * self-update path runs `npm install` on the user's own machine without `--ignore-scripts`
 * (`src/self-update/installer.ts`). Upstream `node-pty` would compile there through
 * `node-gyp rebuild`, on whatever Node the user has (`engines: >=20`, no upper bound), across
 * four platforms — a broken toolchain would then break the whole cockpit, not just the terminal.
 * The fork ships per-platform prebuilt binaries and declares no install script at all, so there
 * is nothing to compile; and `optional` means a platform it has no binary for simply resolves to
 * nothing instead of failing the install.
 *
 * Hence the shape of this module: ONE dynamic import, cached, that never throws. A cockpit whose
 * PTY is missing reports the terminal as unavailable and keeps working — AGENTS.md § Zero config,
 * "degrade to a smaller working cockpit, never fail the boot".
 */

/** The slice of a node-pty process this server uses. Declared here rather than imported so the
 *  types do not depend on a package that may not be installed. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}

/** Why the terminal is unavailable, in words a user can act on. */
export type PtyUnavailable = { available: false; reason: string };
export type PtyBinding = { available: true; module: PtyModule } | PtyUnavailable;

let cached: Promise<PtyBinding> | undefined;

/** How the binding is reached. A seam, not a strategy: the only reason it exists is that the
 *  failure paths below — not installed, no `spawn`, a binary that will not load — are the whole
 *  point of this module and cannot be exercised against a machine where the real package works. */
export type PtyImporter = (specifier: string) => Promise<unknown>;

/**
 * Resolve the PTY binding once per process.
 *
 * Cached as the PROMISE, not the result: two columns opening a terminal in the same tick must not
 * race two dynamic imports of a native module.
 */
export function loadPty(importer?: PtyImporter): Promise<PtyBinding> {
  cached ??= importPty(importer);
  return cached;
}

/** Test seam: forget the cached binding. Never call this from server code. */
export function resetPtyCache(): void {
  cached = undefined;
}

/** Test seam: pretend the binding resolved to this. Never call this from server code. */
export function setPtyBindingForTest(binding: PtyBinding): void {
  cached = Promise.resolve(binding);
}

async function importPty(importer?: PtyImporter): Promise<PtyBinding> {
  try {
    // The specifier is a variable so a bundler cannot try to resolve an optional dependency at
    // build time — the same reason the cockpit's own optional imports are written this way.
    const specifier = '@lydell/node-pty';
    const imported: unknown = await (importer ? importer(specifier) : import(specifier));
    const candidate = pickModule(imported);
    if (!candidate) {
      return { available: false, reason: 'The terminal backend loaded but exposes no spawn().' };
    }
    return { available: true, module: candidate };
  } catch (error) {
    // Not installed (an unsupported platform, or `--no-optional`), or a binary that will not load.
    // Both are "no terminal here", never a thrown request.
    return { available: false, reason: reasonFor(error) };
  }
}

/** The package is CommonJS, so Node may hand back the namespace, the `default` interop object, or
 *  both. Accept whichever actually carries `spawn`. */
function pickModule(imported: unknown): PtyModule | null {
  for (const candidate of [imported, (imported as { default?: unknown } | null)?.default]) {
    if (candidate && typeof (candidate as PtyModule).spawn === 'function') return candidate as PtyModule;
  }
  return null;
}

function reasonFor(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return 'The terminal backend (@lydell/node-pty) is not installed for this platform.';
  }
  const message = error instanceof Error ? error.message : String(error);
  return `The terminal backend could not be loaded: ${message}`;
}
