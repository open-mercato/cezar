import type { SVGProps } from 'react'

/** Brand marks that lucide does not ship.
 *
 *  lucide-react 1.x removed every brand icon (no `GithubIcon`), so the forge nav item would
 *  otherwise have no mark. The path is the one the mockups use, kept at lucide's 24×24 viewBox
 *  and `currentColor` fill so it sizes and themes exactly like its neighbours in the nav.
 */
export function GithubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 1.9a10.1 10.1 0 0 0-3.2 19.7c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .9-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.1 10.1 0 0 0 12 1.9z" />
    </svg>
  )
}

/** The GitLab "tanuki" mark, at the same viewBox/`currentColor` convention as `GithubIcon` above
 *  (spec 2026-08-10-forge-provider-adapters, Step 3.8): the forge nav item swaps to this icon
 *  whenever `/api/health` classifies the project's remote as `gitlab`. */
export function GitlabIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M23.6 9.593l-.033-.086L20.301.982a.852.852 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44l-2.205 6.748H7.53L5.325 1.07a.858.858 0 0 0-.29-.441.875.875 0 0 0-1 .054.858.858 0 0 0-.336.405L1.006 9.507l-.032.086a6.066 6.066 0 0 0 2.012 7.011l.011.008.028.02 4.985 3.736 2.468 1.868 1.502 1.136a1.008 1.008 0 0 0 1.223 0l1.502-1.136 2.468-1.868 5.013-3.757.011-.01A6.065 6.065 0 0 0 23.6 9.593z" />
    </svg>
  )
}
