import { describe, it, expect } from 'vitest';
import {
  classifyGitHubError,
  toGitHubApiError,
  GitHubApiError,
  isAuthOrRateLimitError,
} from '@cezar/core';

// Octokit RequestError-shaped fixtures: `.status` plus `.response.headers` /
// `.response.data.message`. These mirror the real signals GitHub sends so the
// classifier can tell a transient anti-burst limit from a missing permission —
// the distinction that the old single "rate limit exceeded or access forbidden"
// message erased.
function ghError(opts: {
  status: number;
  headers?: Record<string, string>;
  message?: string;
}): unknown {
  return {
    status: opts.status,
    message: opts.message ?? '',
    response: { headers: opts.headers ?? {}, data: { message: opts.message ?? '' } },
  };
}

describe('classifyGitHubError', () => {
  it('classifies 401 as auth', () => {
    expect(classifyGitHubError(ghError({ status: 401 })).kind).toBe('auth');
  });

  it('classifies a secondary rate limit by message', () => {
    const c = classifyGitHubError(
      ghError({
        status: 403,
        message: 'You have exceeded a secondary rate limit',
        headers: { 'retry-after': '30' },
      }),
    );
    expect(c.kind).toBe('secondary-rate-limit');
    expect(c.retryAfterMs).toBe(30_000);
  });

  it('classifies a Retry-After 403 with remaining budget as secondary', () => {
    const c = classifyGitHubError(
      ghError({ status: 403, headers: { 'retry-after': '5', 'x-ratelimit-remaining': '4999' } }),
    );
    expect(c.kind).toBe('secondary-rate-limit');
    expect(c.retryAfterMs).toBe(5_000);
  });

  it('classifies x-ratelimit-remaining: 0 as a primary rate limit', () => {
    const c = classifyGitHubError(
      ghError({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
        message: 'API rate limit exceeded',
      }),
    );
    expect(c.kind).toBe('primary-rate-limit');
  });

  it('classifies a bare 403 (no rate-limit signal) as a permission denial', () => {
    const c = classifyGitHubError(
      ghError({ status: 403, message: 'Resource not accessible by integration' }),
    );
    expect(c.kind).toBe('permission');
  });

  it('classifies 404 as not-found', () => {
    expect(classifyGitHubError(ghError({ status: 404 })).kind).toBe('not-found');
  });
});

describe('toGitHubApiError', () => {
  it('produces a permission message that does NOT mention rate limits', () => {
    const err = toGitHubApiError(
      ghError({ status: 403, message: 'Resource not accessible by integration' }),
      classifyGitHubError(
        ghError({ status: 403, message: 'Resource not accessible by integration' }),
      ),
      { owner: 'o', repo: 'r' },
    );
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.kind).toBe('permission');
    expect(err.message).toMatch(/denied this action/);
    expect(err.message).not.toMatch(/rate limit/i);
  });

  it('an App-token 403 ("integration") blames the App installation', () => {
    const raw = ghError({ status: 403, message: 'Resource not accessible by integration' });
    const err = toGitHubApiError(raw, classifyGitHubError(raw), { owner: 'o', repo: 'r' });
    expect(err.message).toMatch(/GitHub App installation lacks permission/);
  });

  it('a user-token 403 (no "integration") points at the missing Triage role', () => {
    // A read-access user can comment but not label — exactly the contributor case.
    const raw = ghError({ status: 403, message: 'Must have triage permission' });
    const err = toGitHubApiError(raw, classifyGitHubError(raw), { owner: 'o', repo: 'r' });
    expect(err.message).toMatch(/Triage/);
    expect(err.message).toMatch(/install the Cezar GitHub App/);
  });

  it('preserves the classified kind + status for callers', () => {
    const classified = classifyGitHubError(
      ghError({ status: 403, message: 'secondary rate limit' }),
    );
    const err = toGitHubApiError(new Error('x'), classified);
    expect(err.kind).toBe('secondary-rate-limit');
    expect(err.status).toBe(403);
  });
});

describe('isAuthOrRateLimitError', () => {
  it('recognizes a GitHubApiError permission as fatal-for-the-token', () => {
    const err = new GitHubApiError('nope', { kind: 'permission', status: 403, message: '' });
    expect(isAuthOrRateLimitError(err)).toBe(true);
  });

  it('recognizes a raw 429', () => {
    expect(isAuthOrRateLimitError({ status: 429 })).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isAuthOrRateLimitError(new Error('boom'))).toBe(false);
  });
});
