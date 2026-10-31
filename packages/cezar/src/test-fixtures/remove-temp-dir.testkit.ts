import { rm } from 'node:fs/promises';

/**
 * Remove a test's temporary directory once nothing holds it any more.
 *
 * Why not `rmSync(dir, { recursive: true, force: true })`: a run leaves short-lived children
 * behind it for a few hundred milliseconds after the manager says it is done — the
 * `git diff --shortstat` of turn-end bookkeeping, an agent process that was just told to stop —
 * and their working directory is inside the temp repository. POSIX unlinks a directory that is
 * some process's cwd; Windows refuses (`EBUSY`/`EPERM`) until that process has exited.
 *
 * Why not `rmSync(..., { maxRetries })` either: since Node moved `rmSync` to its native
 * implementation, the retry never happens for this error on Windows. The refusal surfaces as
 * `EPERM, Permission denied` after 0 ms however many retries were asked for (measured on Node
 * 24.18: `rmSync` with `maxRetries: 20, retryDelay: 100` against a directory a child holds as
 * its cwd for 400 ms fails at once; `fs.promises.rm` with the same options succeeds after
 * ~330 ms). The promise API still runs the JavaScript retry loop, which does treat `EBUSY`,
 * `EPERM` and `ENOTEMPTY` as "try again", so that is the one to use.
 *
 * The wait is bounded and linear (`retryDelay * attempt`): about 5 s in total at the values
 * below, and a directory that is free — every POSIX run, and most Windows ones — is removed on
 * the first attempt with no delay at all. A holder that outlives the bound is a real leak and
 * still fails the test, which is the point: this absorbs a process that is on its way out, it
 * does not hide one that never leaves. (Two such leaks were found this way and fixed at the
 * source instead: a namer launched by a disposed manager, and tests that started the developer's
 * real agent CLI — see `no-real-namer.testkit.ts`.) A test that leaves live sessions behind
 * must end them first: {@link stopRuns}.
 */
export async function removeTempDir(...dirs: Array<string | undefined>): Promise<void> {
  for (const dir of dirs) {
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** The slice of `RunManager` / `RunStore` that {@link stopRuns} needs — structural, so this
 *  file imports nothing from the engine it helps to test. */
interface StoppableManager {
  cancel(runId: string): boolean;
  isActive(runId: string): boolean;
  dispose(): void;
}
interface ListableStore {
  listRuns(): Array<{ id: string }>;
}

/**
 * End every run a manager still owns, wait for the cancellations to settle, then dispose it —
 * the teardown a suite needs before {@link removeTempDir} when its runs can outlive their test
 * (a session parked at `waiting` is a live agent process whose cwd is the temp repository).
 *
 * Disposing alone is not enough: `dispose()` deliberately ends no session. Never throws — a run
 * that refuses to stop shows up as the directory that cannot be removed afterwards, which names
 * the leak better than a second error would.
 */
export async function stopRuns(manager: StoppableManager, store: ListableStore, timeoutMs = 8_000): Promise<void> {
  try {
    const ids = store.listRuns().map(({ id }) => id);
    for (const id of ids) manager.cancel(id);
    const deadline = Date.now() + timeoutMs;
    while (ids.some((id) => manager.isActive(id)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    manager.dispose();
  }
}
