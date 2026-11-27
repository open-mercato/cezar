/**
 * `--preview-url` (#1608): the app address a project workspace opens on arrival. Only an
 * http(s) address is accepted — `javascript:`/`file:`/`data:` in an iframe the cockpit renders
 * are script injection or a disk read — and credentials in the URL are refused so they never
 * land in a browser history or a printed line. The path, query and port are kept exactly.
 */
export function parsePreviewUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { error: '--preview-url needs an address, e.g. http://127.0.0.1:3000' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `--preview-url is not a valid address: ${trimmed}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `--preview-url must be http:// or https://, not ${parsed.protocol}` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { error: '--preview-url must not carry a username or password' };
  }
  return { url: parsed.toString() };
}

/** The project's pre-task workspace: preview + the project-checkout terminal, no run. */
export function projectWorkspacePath(projectId: string, previewUrl?: string): string {
  const base = `/p/${encodeURIComponent(projectId)}/workspace`;
  return previewUrl ? `${base}?preview=${encodeURIComponent(previewUrl)}` : base;
}
