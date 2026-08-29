/**
 * The `/skills` Suspense fallback — the static page header while the lazy catalog chunk (and
 * its markdown stack) loads. A SEPARATE lightweight module on purpose: importing it must not
 * pull `skills.tsx`'s markdown chain into the main bundle (mirrors workflows-loading.tsx).
 */
export function SkillsLoading() {
  return (
    <div data-route="skills" className="flex min-h-full flex-col">
      <h1 className="sr-only">Skills</h1>
      <p data-slot="skills-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
        Loading skills…
      </p>
    </div>
  )
}
