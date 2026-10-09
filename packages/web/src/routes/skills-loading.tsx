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
      >
        <Skeleton className="h-96 w-full rounded-xl" />
        <span className="sr-only">Loading skills…</span>
      </PageBody>
    </Page>
  )
}
