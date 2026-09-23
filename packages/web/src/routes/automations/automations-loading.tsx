/**
 * The `/automations` Suspense fallback — the static page header while the lazy automations
 * chunk (editor, week/day calendars, template palette, log) loads. A SEPARATE lightweight
 * module on purpose: importing it must not pull `automations-route.tsx`'s heavier chunk into
 * the main bundle (mirrors skills-loading.tsx / workflows-loading.tsx).
 */
export function AutomationsLoading() {
  return (
    <div data-route="automations" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Automations</h1>
        <p className="text-[13px] text-muted-foreground">Scheduled and GitHub-triggered runs.</p>
      </header>
      <p data-slot="automations-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
        Loading automations…
      </p>
    </div>
  )
}
