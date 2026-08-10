/**
 * The `/skills` Suspense fallback — the static page header while the lazy catalog chunk (and
 * its markdown stack) loads. A SEPARATE lightweight module on purpose: importing it must not
 * pull `skills.tsx`'s markdown chain into the main bundle (mirrors workflows-loading.tsx).
 */
export function SkillsLoading() {
  return (
    <div data-route="skills" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Skills</h1>
        <p className="text-[13px] text-muted-foreground">Markdown playbooks agents can follow.</p>
      </header>
      <p data-slot="skills-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
        Loading skills…
      </p>
    </div>
  )
}
