/**
 * Suggested starting points for "New project → From a template" (spec
 * 2026-09-29-create-new-project). Only a suggestion list: the field still takes any `owner/repo`
 * or GitHub URL, and the server validates whatever is sent.
 *
 * Every entry must be a GitHub TEMPLATE repository (`is_template: true`) and not archived —
 * `gh repo create --template` refuses anything else. Checked with
 * `gh api repos/<slug> --jq '[.is_template, .archived]'` on 2026-09-30; re-check when editing.
 * Preference goes to repos the framework's own organisation (or GitHub) publishes; Hono, Vite,
 * Vue and Vite+ publish none, so those entries are the most-used active community templates.
 */
export interface GithubTemplateSuggestion {
  /** `owner/repo`, exactly what the field is filled with. */
  slug: string
  label: string
  description: string
}

export const GITHUB_TEMPLATE_SUGGESTIONS: readonly GithubTemplateSuggestion[] = [
  { slug: 'github/codespaces-nextjs', label: 'Next.js', description: 'Minimal Next.js app (GitHub)' },
  { slug: 'vercel/ai-chatbot', label: 'Next.js AI chatbot', description: 'Full-featured AI chat app (Vercel)' },
  {
    slug: 'vercel/nextjs-postgres-nextauth-tailwindcss-template',
    label: 'Next.js admin dashboard',
    description: 'Postgres, Auth.js and Tailwind (Vercel)',
  },
  { slug: 'github/codespaces-react', label: 'React + Vite', description: 'React single-page app (GitHub)' },
  { slug: 'antfu-collective/vitesse', label: 'Vue + Vite', description: 'Opinionated Vue starter (Vitesse)' },
  { slug: 'nuxt-ui-templates/starter-vue', label: 'Vue + Nuxt UI', description: 'Vue + Vite with Nuxt UI (Nuxt)' },
  { slug: 'mugnavo/cove', label: 'Vite+', description: 'TanStack Start on Vite+ (vp), Better Auth' },
  { slug: 'w3cj/hono-open-api-starter', label: 'Hono', description: 'Type-safe JSON API with OpenAPI docs' },
  { slug: 'github/codespaces-express', label: 'Express', description: 'Node.js web server (GitHub)' },
  {
    slug: 'andrewmcodes/obsidian-beginner-vault-template',
    label: 'Obsidian vault',
    description: 'Your own knowledge base in Markdown',
  },
  {
    slug: 'chibat/chrome-extension-typescript-starter',
    label: 'Chrome extension',
    description: 'TypeScript extension starter',
  },
  { slug: 'actions/typescript-action', label: 'GitHub Action', description: 'TypeScript action with tests (GitHub)' },
  { slug: 'microsoft/python-package-template', label: 'Python package', description: 'Packaging, tests and CI (Microsoft)' },
  { slug: 'github/codespaces-flask', label: 'Flask', description: 'Python web app (GitHub)' },
  { slug: 'github/codespaces-django', label: 'Django', description: 'Python web framework (GitHub)' },
  { slug: 'github/codespaces-rails', label: 'Ruby on Rails', description: 'Rails app (GitHub)' },
  { slug: 'github/codespaces-jupyter', label: 'Jupyter notebooks', description: 'Data science and ML (GitHub)' },
]

/** Suggestions matching what is typed — label, slug or description, case-insensitive. An empty
 *  query, or one that already IS a suggestion's slug, lists everything so the user can switch. */
export function filterTemplateSuggestions(query: string): readonly GithubTemplateSuggestion[] {
  const q = query.trim().toLowerCase()
  if (q === '' || GITHUB_TEMPLATE_SUGGESTIONS.some((s) => s.slug.toLowerCase() === q)) return GITHUB_TEMPLATE_SUGGESTIONS
  return GITHUB_TEMPLATE_SUGGESTIONS.filter((s) =>
    [s.label, s.slug, s.description].some((field) => field.toLowerCase().includes(q)),
  )
}
