import { createSign } from 'node:crypto';
import { Octokit } from '@octokit/rest';

/**
 * Minimal, *additive* GitHub App helper (agent-cockpit refactor — Phase 1, §3.9).
 *
 * If a GitHub App is configured (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`),
 * callers can mint a short-lived **installation token** for repo operations —
 * private-repo skill discovery in this phase, more in later phases. If it is
 * NOT configured, Cezar still works exactly as before via per-user OAuth tokens;
 * this class throws on use rather than changing any login behavior.
 *
 * Deliberately dependency-free: the App JWT is signed with `node:crypto`
 * (RS256), not `jsonwebtoken`. The only external bit is `@octokit/rest`, which
 * the package already depends on.
 */
export class GitHubAppService {
  /** True iff both `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set. */
  static isConfigured(): boolean {
    return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
  }

  // Cache installation tokens with their absolute expiry (ms epoch). Owner-keyed
  // and install-id-keyed caches are kept in separate Maps so the two key spaces
  // can never collide (a lowercased owner login vs. a numeric installation id).
  private static tokenCacheByOwner = new Map<string, { token: string; expiresAt: number }>();
  private static tokenCacheByInstallId = new Map<number, { token: string; expiresAt: number }>();

  /**
   * Returns an installation access token for a specific GitHub App install id.
   * Used by the runner-API claim route when a runner has its own
   * `runners.github_installation_id` set — we skip the owner→install lookup
   * and mint directly. Throws if no App is configured.
   *
   * Cached in {@link tokenCacheByInstallId}, a separate Map from the owner-keyed
   * cache used by {@link getInstallationToken}, so the key spaces never collide.
   */
  async getInstallationTokenById(installationId: number): Promise<string> {
    if (!GitHubAppService.isConfigured()) {
      throw new Error(
        'GitHub App not configured — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or use a user OAuth token',
      );
    }

    const cached = GitHubAppService.tokenCacheByInstallId.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 60_000) {
      return cached.token;
    }

    const appId = process.env.GITHUB_APP_ID!;
    const privateKey = normalizePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY!);
    const jwt = buildAppJwt(appId, privateKey);
    const appOctokit = new Octokit({ auth: jwt });

    const tokenRes = await appOctokit.request('POST /app/installations/{installation_id}/access_tokens', {
      installation_id: installationId,
    });
    const token = tokenRes.data.token;
    // GitHub installation tokens last 60 min; keep a 10-min safety margin when
    // the response omits `expires_at` (Date.parse on an absent value is NaN).
    const expiresAt = tokenRes.data.expires_at ? Date.parse(tokenRes.data.expires_at) : Date.now() + 50 * 60_000;

    GitHubAppService.tokenCacheByInstallId.set(installationId, { token, expiresAt });
    return token;
  }

  /**
   * Returns an installation access token scoped to the installation that has
   * access to `owner` (the org/user that owns the target repo). Throws if no
   * GitHub App is configured, or if no installation matches `owner`.
   */
  async getInstallationToken(owner: string): Promise<string> {
    if (!GitHubAppService.isConfigured()) {
      throw new Error(
        'GitHub App not configured — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or use a user OAuth token',
      );
    }

    const cacheKey = owner.toLowerCase();
    const cached = GitHubAppService.tokenCacheByOwner.get(cacheKey);
    // 60s safety margin so we don't hand back a token that's about to expire.
    if (cached && cached.expiresAt - Date.now() > 60_000) {
      return cached.token;
    }

    const appId = process.env.GITHUB_APP_ID!;
    const privateKey = normalizePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY!);
    const jwt = buildAppJwt(appId, privateKey);

    const appOctokit = new Octokit({ auth: jwt });

    // Find the installation for this owner. `GET /orgs/{org}/installation` works
    // for orgs; `GET /users/{username}/installation` for user accounts — try the
    // org form first, fall back to the user form, then to a full scan.
    let installationId: number | undefined;
    try {
      const res = await appOctokit.request('GET /orgs/{org}/installation', { org: owner });
      installationId = res.data.id;
    } catch {
      try {
        const res = await appOctokit.request('GET /users/{username}/installation', { username: owner });
        installationId = res.data.id;
      } catch {
        const res = await appOctokit.request('GET /app/installations', { per_page: 100 });
        const match = res.data.find(
          (inst) => inst.account && 'login' in inst.account && inst.account.login.toLowerCase() === cacheKey,
        );
        installationId = match?.id;
      }
    }

    if (installationId == null) {
      throw new Error(`GitHub App is not installed on "${owner}" — install it on the org/repo`);
    }

    const tokenRes = await appOctokit.request('POST /app/installations/{installation_id}/access_tokens', {
      installation_id: installationId,
    });
    const token = tokenRes.data.token;
    // GitHub installation tokens last 60 min; keep a 10-min safety margin when
    // the response omits `expires_at` (Date.parse on an absent value is NaN).
    const expiresAt = tokenRes.data.expires_at ? Date.parse(tokenRes.data.expires_at) : Date.now() + 50 * 60_000;

    GitHubAppService.tokenCacheByOwner.set(cacheKey, { token, expiresAt });
    return token;
  }
}

/** Replace literal `\n` sequences with real newlines (common when the key is stored in a single-line env var). */
function normalizePrivateKey(key: string): string {
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

/** Build a GitHub App JWT (RS256): header `{alg:RS256,typ:JWT}`, payload `{iat,exp,iss}`, 9-min expiry. */
function buildAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // `iat` backdated 60s to tolerate minor clock skew; GitHub caps `exp` at 10min.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}
