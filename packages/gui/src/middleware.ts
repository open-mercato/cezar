import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// API routes with their own auth must bypass the user-session gate here:
//   /api/cron/*  — CRON_SECRET bearer (scheduler / external cron)
//   /api/runner/* — per-runner bearer token (`authRunner` in api/runner/_auth.ts)
//   /api/github/webhook — HMAC-SHA256 against GITHUB_APP_WEBHOOK_SECRET
// Without these on the public list the middleware redirects to /login and
// callers (the runner daemon, GitHub) JSON-parse the HTML and fail.
const PUBLIC_ROUTES = [
  '/login',
  '/auth/callback',
  '/api/cron',
  '/api/runner',
  '/api/github/webhook',
];

export async function middleware(request: NextRequest) {
  // Short-circuit before any Supabase client construction or Auth round-trip
  // for routes that bring their own auth. Webhook + runner + cron endpoints
  // are hit on a hot loop; paying `auth.getUser()` for an unused session
  // lookup roughly doubles their latency floor.
  const isPublic = PUBLIC_ROUTES.some((r) => request.nextUrl.pathname.startsWith(r));
  if (isPublic) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    // Must match the public URL used by the browser + server clients —
    // @supabase/ssr derives the session cookie name from the URL host, so
    // mixing internal/public URLs causes cookie lookups to silently miss.
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Any response we return INSTEAD of `supabaseResponse` (e.g. a redirect) must
  // carry over the Set-Cookie headers `getAll()` may have refreshed onto
  // `supabaseResponse`. Dropping them re-presents the rotated-out refresh token
  // on the next request → Supabase 400 → silent logout.
  const withSessionCookies = (response: NextResponse) => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie.name, cookie.value, cookie);
    });
    return response;
  };

  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    return withSessionCookies(NextResponse.redirect(loginUrl));
  }

  if (request.nextUrl.pathname === '/login') {
    const dashUrl = request.nextUrl.clone();
    dashUrl.pathname = '/dashboard';
    return withSessionCookies(NextResponse.redirect(dashUrl));
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
