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
