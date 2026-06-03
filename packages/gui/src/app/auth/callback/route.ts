import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  // Only allow same-origin relative paths to prevent open-redirect via `next`.
  // Reject protocol-relative (`//evil.com`) and backslash (`/\evil.com`) values.
  const rawNext = searchParams.get('next') ?? '/dashboard';
  const next =
    rawNext.startsWith('/') &&
    !rawNext.startsWith('//') &&
    !rawNext.startsWith('/\\')
      ? rawNext
      : '/dashboard';
  // Use the configured public app URL — `request.nextUrl.origin` is
  // `http://0.0.0.0:3000` inside the standalone container behind Traefik.
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      // Public URL — @supabase/ssr derives the PKCE-verifier cookie name from
      // the URL host. Must match what signInWithGitHub used to set it.
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: (cookiesToSet) => {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          },
        },
      },
    );

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const providerToken = data.session?.provider_token;
      if (providerToken && data.user) {
        await supabase.from('user_github_tokens').upsert({
          user_id: data.user.id,
          provider_token: providerToken,
          provider_refresh_token: data.session?.provider_refresh_token ?? null,
          updated_at: new Date().toISOString(),
        });
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
