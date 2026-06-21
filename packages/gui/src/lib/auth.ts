import { createSupabaseServerClient } from './supabase/server';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
  githubToken: string | null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const {
    data: { session },
  } = await supabase.auth.getSession();

  let githubToken = session?.provider_token ?? null;
  if (githubToken) {
    // Session still has a fresh provider_token (just-signed-in case).
    // Mirror it to the persisted store so later refreshes survive.
    await supabase.from('user_github_tokens').upsert({
      user_id: user.id,
      provider_token: githubToken,
      provider_refresh_token: session?.provider_refresh_token ?? null,
      updated_at: new Date().toISOString(),
    });
  } else {
    const { data } = await supabase
      .from('user_github_tokens')
      .select('provider_token')
      .eq('user_id', user.id)
      .maybeSingle();
    githubToken = data?.provider_token ?? null;
  }

  return {
    id: user.id,
    email: user.email ?? '',
    name: user.user_metadata?.full_name ?? user.user_metadata?.user_name ?? user.email ?? '',
    avatarUrl: user.user_metadata?.avatar_url ?? '',
    githubToken,
  };
}
