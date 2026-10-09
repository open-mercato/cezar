import { Page, PageBody, PageHeader } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The `/skills` Suspense fallback — the static page header while the lazy catalog chunk (and
 * its markdown stack) loads. A SEPARATE lightweight module on purpose: importing it must not
 * pull `skills.tsx`'s markdown chain into the main bundle (mirrors workflows-loading.tsx).
 */
export function SkillsLoading() {
  return (
    <Page data-route="skills">
      <PageHeader title="Skills" description="Markdown playbooks agents can follow." />
      <PageBody
        data-slot="skills-loading"
        role="status"
        aria-label="Loading skills…"
        className="grid items-start gap-6 md:grid-cols-[19rem_minmax(0,1fr)] lg:grid-cols-[21rem_minmax(0,1fr)]"
      >
        <Skeleton className="h-72 w-full rounded-xl" />
        <Skeleton className="hidden h-96 w-full rounded-xl md:block" />
        <span className="sr-only">Loading skills…</span>
      </PageBody>
    </Page>
  )
}
