/**
 * Side-effect import: `import '../test-fixtures/no-real-namer.testkit.ts';`
 *
 * Keeps a test file from launching the developer's REAL agent CLI as a task namer.
 *
 * `RunManager.startRun` fires the namer (`autoNameRun` → `generateRunName`) for every run unless
 * `CEZ_AUTONAME=0`, or `CEZ_DRY_RUN=1` without `CEZ_AUTONAME=1`. A test that drives real check
 * steps or a stub transport sets neither, so each `startRun` spawns `claude --print …` with the
 * temp repository as its cwd. On CI there is no `claude` on PATH and the spawn fails at once,
 * which is why nobody noticed. On a machine that has one installed it is a real, billed model
 * call per run that lives up to 2 × `NAMER_TIMEOUT_MS` (40 s) — and on Windows a live process's
 * cwd cannot be deleted, so the test's teardown fails on `EBUSY` long after its body passed.
 *
 * `??=` so an explicit setting wins: the suite runner's own environment, and the naming tests,
 * which set `CEZ_AUTONAME=1` themselves and restore whatever they found.
 */
process.env.CEZ_AUTONAME ??= '0';
