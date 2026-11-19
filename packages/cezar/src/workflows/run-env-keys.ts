/**
 * The variables a cockpit sets for its own agents and check steps (.env.example). The test suite
 * drops them at load (`vitest.setup.ts`): run inside a cezar task it would inherit them, and a case
 * that spawns an agent without its own env then writes into the OUTER run — mock-claude's
 * `demo.html` landed in a live task's Assets that way. `agent-profile-wiring.test.ts` fails when a
 * run hands its agent a `CEZ_*` key missing here.
 */
export const RUN_SCOPED_ENV: readonly string[] = [
  'CEZ_TASK_ID', 'CEZ_HANDOFF_FILE', 'CEZ_TODOS_FILE', 'CEZ_ARTIFACTS_DIR', 'CEZ_API_URL', 'CEZ_PROJECT_ID',
  'CEZ_BIN', 'CEZ_TREE_DIR', 'CEZ_RUN_ID', 'CEZ_WORKTREE', 'CEZ_BRANCH', 'CEZ_BASE', 'CEZ_STEP_ID',
  'CEZ_ATTEMPT', 'CEZ_SHARED_CACHE_DIR', 'CEZ_GITHUB_REPO', 'CEZ_GITHUB_NUMBER', 'CEZ_GITHUB_EVENT',
  'CEZ_PR_HEAD_SHA', 'CEZ_PR_HEAD_REF', 'CEZ_PR_BASE_REF', 'CEZ_REMOTE',
];
