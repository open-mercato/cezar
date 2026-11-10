Summary: Private GitHub attachment images fail to load in issue and PR bodies and comments.

Root cause: fetchGithubComments returns raw Markdown; github.tsx:1105 and :1796 feed it to Markdown, which renders github.com/user-attachments URLs directly. The browser cannot authenticate those cross-site image requests. This is confirmed by code inspection; private-repository HTTP behavior remains to be exercised in the fix's controlled tests.

Files to change:
- packages/contract/src/github.ts — bounded attachment URL input and raster data response schemas.
- packages/cezar/src/server/forge/github-assets.ts and its test — bounded credentialed image retrieval, explicit redirect allowlist and raster verification.
- packages/cezar/src/server/server.ts and github-assets-api.test.ts — chained, body-validated project API route behind existing origin/auth guards; no-store response.
- packages/web/src/routes/task-thread/markdown.tsx — optional image component preserving existing link policy.
- packages/web/src/routes/github/github-markdown.tsx, github.tsx and github.test.tsx — fetch matching images through authenticated project API, render raster data, cover both body/comment formats and public fallback.
- packages/web/src/api/client.ts — typed API call using existing credentials/base/scope handling.
- .ai/analysis/1902 and .ai/trackers/github.md — required chain evidence and ownership protocol reconciliation.

Approach: Add a small POST image loader returning raster data through the normal JSON client, then use an image-only Markdown component for GitHub content. Validate the initial URL and every redirect; send credentials only to the exact github.com attachment path, with bounded time, size, concurrency and no persistent asset cache. Pin regressions with route and rendering tests and prove red without the production fix.

Risks: Credential forwarding, malicious redirects, executable content, oversized/slow responses, project scope changes, and hosted cross-origin authentication need explicit checks. GitHub Enterprise, SVG and video remain unsupported; existing non-GitHub images keep their behavior. No startup, environment, or user configuration changes.
