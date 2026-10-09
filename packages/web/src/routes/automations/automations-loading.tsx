import { Page, PageBody, PageHeader } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The `/automations` Suspense fallback — the static page header while the lazy automations
 * chunk (editor, week/day calendars, template palette, log) loads. A SEPARATE lightweight
 * module on purpose: importing it must not pull `automations-route.tsx`'s heavier chunk into
 * the main bundle (mirrors skills-loading.tsx / workflows-loading.tsx).
 */
export function AutomationsLoading() {
  return (
    <Page data-route="automations" width="wide">
      <PageHeader title="Automations" description="Scheduled and GitHub-triggered runs." />
      <PageBody data-slot="automations-loading" aria-busy="true" aria-label="Loading automations…" className="space-y-2">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-2/3" />
      </PageBody>
    </Page>
  )
}
