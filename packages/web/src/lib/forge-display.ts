import type { ComponentType, SVGProps } from 'react'

import type { ForgeKind } from '@open-mercato/cezar-api-client'
import { GithubIcon, GitlabIcon } from '@/components/icons'

/**
 * The forge-flavored bits of copy the cockpit swaps by `health.forge?.kind` / a project's own
 * `forge` field (spec 2026-08-10-forge-provider-adapters, Step 3.8): the nav item's label and
 * icon, the unavailable-state hint's CLI, and any prose that used to hard-code "GitHub".
 *
 * An absent or unrecognized kind reads as GitHub — today's text, unchanged — so a payload from
 * before this forge widened (`forge: null`, or a kind this cockpit build predates) degrades to
 * the one forge every earlier server ever spoke of, rather than to something unlabeled.
 */

/** The tab's display name. */
export function forgeLabel(kind: ForgeKind | null | undefined): 'GitHub' | 'GitLab' {
  return kind === 'gitlab' ? 'GitLab' : 'GitHub'
}

/** The brand mark beside the label — see `GithubIcon`/`GitlabIcon` in `components/icons.tsx`. */
export function forgeIcon(kind: ForgeKind | null | undefined): ComponentType<SVGProps<SVGSVGElement>> {
  return kind === 'gitlab' ? GitlabIcon : GithubIcon
}

/** The CLI name and its login command, for the tab's unavailable-state hint. */
export function forgeCli(kind: ForgeKind | null | undefined): { cli: string; authCommand: string } {
  return kind === 'gitlab'
    ? { cli: 'glab', authCommand: 'glab auth login' }
    : { cli: 'gh', authCommand: 'gh auth login' }
}

/**
 * The noun for a code-review request on this forge — "pull request" on GitHub, "merge request"
 * on GitLab — for every place the tab used to hard-code "pull request" (Step 3.8-review-fix). One
 * helper rather than a ternary at each call site, so the two forms can't drift apart.
 */
export function forgePrNoun(
  kind: ForgeKind | null | undefined,
  options: { plural?: boolean; capitalized?: boolean } = {},
): string {
  const { plural = false, capitalized = false } = options
  const noun = kind === 'gitlab' ? 'merge request' : 'pull request'
  const word = plural ? `${noun}s` : noun
  return capitalized ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word
}
