function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

export const supabaseEnv = {
  // Public URL — used by the browser client and as the server-side fallback.
  url: (): string => required('NEXT_PUBLIC_SUPABASE_URL'),
  // Server-side override so SSR traffic stays on the Docker network instead of
  // egressing through Traefik. Auth still works because the user's session
  // JWT travels in the request, not in Supabase-specific cookies tied to the
  // public URL. Falls back to the public URL when unset (Vercel, single-host
  // dev, etc.).
  internalUrl: (): string =>
    process.env.SUPABASE_INTERNAL_URL || required('NEXT_PUBLIC_SUPABASE_URL'),
  anonKey: (): string => required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  serviceRoleKey: (): string => required('SUPABASE_SERVICE_ROLE_KEY'),
};
