/**
 * Thin delegate — the gh-CLI listing logic moved behind the forge-driver seam
 * (`src/server/forge/github.ts`, cockpit-ui redesign spec §"Forge-driver
 * seam"). Kept so existing imports and the protected `/api/github` response
 * shape (BACKWARD_COMPATIBILITY.md §2) stay exactly as they were.
 */
export {
  fetchGithub,
  fetchGithubChecks,
  fetchGithubComments,
  fetchGithubPrDiff,
  GithubPrNotFoundError,
  GH_MAX_LIMIT,
  GH_CHECKS_MAX,
} from './forge/github.ts';
export type { GithubData, GithubItem, GithubChecksData } from './forge/github.ts';
export type {
  ForgeComment,
  ForgeCommentsData,
  ForgeTimelineEvent,
  ForgeTimelineEventKind,
  ForgePrDiffResult,
  ForgePrChange,
} from './forge/types.ts';
