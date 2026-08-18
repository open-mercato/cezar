/** Build the versioned API path for one explicit project scope. */
export function projectApiPath(projectId: string | null, suffix: `/${string}`): string {
  return projectId === null
    ? `/api/v1${suffix}`
    : `/api/v1/p/${encodeURIComponent(projectId)}${suffix}`
}

/** Resolve a root-relative Cezar path against one client instance's configured base URL. */
export function resolveCezarUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) return path
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}
