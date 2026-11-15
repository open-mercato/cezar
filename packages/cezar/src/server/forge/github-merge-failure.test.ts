import { describe, expect, it } from 'vitest';
import { ghMergeFailure } from './github.ts';

const ARGV = 'gh api --method PUT repos/acme/demo/pulls/128/merge -f merge_method=squash -f sha=0123456789abcdef';
const DOCS = 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request';

/** What promisified `execFile` rejects with when `gh api` gets a non-2xx answer: GitHub's body on
 *  stdout, `gh: <message> (HTTP n)` on stderr, Node's argv preamble in `message`. */
function ghApiError(status: number, message: string): Error {
  const stderr = `gh: ${message} (HTTP ${status})\n`;
  return Object.assign(new Error(`Command failed: ${ARGV}\n${stderr}`), {
    code: 1,
    stdout: JSON.stringify({ message, documentation_url: DOCS, status: String(status) }),
    stderr,
  });
}

// Telemetry a2c8474c: every one of these used to answer 502 "GitHub could not complete the merge."
describe('ghMergeFailure', () => {
  it.each([
    [405, 'Pull Request is not mergeable', 409, 'github-blocked', 'GitHub refused the merge: Pull Request is not mergeable.'],
    [405, 'At least 1 approving review is required by reviewers with write access.', 409, 'github-blocked',
      'GitHub refused the merge: At least 1 approving review is required by reviewers with write access.'],
    [405, 'Merge commits are not allowed on this repository.', 409, 'github-blocked',
      'GitHub refused the merge: Merge commits are not allowed on this repository.'],
    [405, 'Repository rule violations found\n\nChanges must be made through a pull request.\n\n', 409, 'github-blocked',
      'GitHub refused the merge: Repository rule violations found Changes must be made through a pull request.'],
    [409, 'Head branch was modified. Review and try the merge again.', 409, 'stale-head',
      'GitHub refused the merge: Head branch was modified. Review and try the merge again.'],
    [422, 'Required status check "build" is expected.', 409, 'github-blocked',
      'GitHub refused the merge: Required status check "build" is expected.'],
    [403, 'Resource not accessible by integration', 403, undefined, 'GitHub permission denied: Resource not accessible by integration.'],
    [404, 'Not Found', 404, undefined, 'Pull request or repository not found.'],
    [502, 'Server Error', 502, undefined, 'GitHub could not complete the merge: Server Error.'],
  ])('maps HTTP %i "%s" to %i', (http, message, status, code, error) => {
    const result = ghMergeFailure(ghApiError(http, message));
    expect(result).toEqual({ merged: false, status, error, ...(code ? { code } : {}) });
  });

  it('reads the status from stderr when gh printed no JSON body', () => {
    const stderr = 'gh: Pull Request is not mergeable (HTTP 405)\n';
    const result = ghMergeFailure(Object.assign(new Error(`Command failed: ${ARGV}\n${stderr}`), { stdout: '', stderr }));
    expect(result).toMatchObject({ status: 409, error: 'GitHub refused the merge: Pull Request is not mergeable.' });
  });

  it('keeps a transport failure a 502 with gh\'s reason, never the argv', () => {
    const stderr = 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n';
    const result = ghMergeFailure(Object.assign(new Error(`Command failed: ${ARGV}\n${stderr}`), { stdout: '', stderr }));
    expect(result).toEqual({
      merged: false,
      status: 502,
      error: 'GitHub could not complete the merge: error connecting to api.github.com.',
    });
    const killed = ghMergeFailure(Object.assign(new Error(`Command failed: ${ARGV}`), { killed: true, stdout: '', stderr: '' }));
    expect(killed).toEqual({ merged: false, status: 502, error: 'GitHub could not complete the merge.' });
  });
});
