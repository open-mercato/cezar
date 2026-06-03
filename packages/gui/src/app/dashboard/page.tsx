import { redirect } from 'next/navigation';

// `/dashboard` is the canonical post-auth / post-workspace landing route
// (middleware, app/page.tsx, auth/callback, and the workspace flows all redirect
// here). The cockpit's home is the Inbox, so this route forwards there. Keep this
// redirect in place until those callers are repointed at `/inbox` directly.
export default function DashboardPage() {
  redirect('/inbox');
}
