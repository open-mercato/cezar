# Run — fix: ubuntu-vps vhost emits a standalone `http2` directive nginx < 1.25.1 rejects

- Date: 2026-09-16
- Issue: #910
- Branch: `fix/ubuntu-vps-nginx-http2-directive`
- Engine: om-auto-create-pr

## Goal

`server-install --platform ubuntu-vps` must complete its SSL step on the current Ubuntu LTS, while keeping HTTP/2 on the cockpit's TLS listener.

## Context

`nginxVhost()` emits the standalone `http2 on;` directive inside the plain `:80` server block. That directive was introduced in **nginx 1.25.1**. Ubuntu 24.04 LTS ships **nginx 1.24.0** and Debian stable is older still, so on every host this platform documents, `nginx -t` fails with `unknown directive "http2"` and `certbot --nginx` aborts. The wizard's retry loop cannot clear it, because the vhost is regenerated unchanged.

HTTP/2 itself is load-bearing and must be preserved: without it the browser's ~6-connections-per-origin HTTP/1.1 cap is exhausted by cezar's long-lived SSE run streams.

Before 1.25.1, HTTP/2 is enabled *only* as a `listen` parameter (`listen 443 ssl http2;`). That form still works on 1.25.1+ (deprecation warning only), but the directive form is the non-deprecated spelling there — so the fix detects the installed nginx once and uses the spelling that version actually accepts.

## Scope

- `packages/cezar/src/server-install/platforms/ubuntu-vps.ts` — version detection, version-aware vhost emission, TLS-listener post-processing in the SSL step.
- `packages/cezar/src/server-install/platforms/ubuntu-vps.test.ts` — regression coverage for both nginx version branches.
- `packages/cezar/src/server-install/strategies.test.ts` — one assertion there pins the same broken string; it has to move with the generator.

### Non-goals

- Adding the upstream `nginx.org` apt repository to reach nginx ≥ 1.25.1 (explicitly out of scope on the issue — it changes the host's package sources).
- The `macosx-ngrok` platform (generates no nginx vhost).
- Any change to the SSE proxy settings (`proxy_buffering off`, `proxy_read_timeout`) — correct as emitted.
- Turning the SSL step's "did not verify" into a terminal error (issue #910 item 5 — its own concern).
- No public API, event id, DI key or on-disk state shape changes; the installed nginx version is read per run, never persisted, so `server.json` is untouched.

## Implementation Plan

### Phase 1: version-aware vhost generation

1.1 Add `parseNginxVersion()` / `supportsHttp2Directive()` / `detectNginxVersion()` to `ubuntu-vps.ts`. `nginx -v` prints to **stderr**; an unreadable version must degrade to "old", the syntax both versions accept.

1.2 Take an optional nginx version in `nginxVhost()`, emit `http2 on;` only for ≥ 1.25.1, and rewrite the comment block so it states the version boundary instead of claiming the directive is unconditionally valid on `:80`.

### Phase 2: wire it through the install steps

2.1 `nginx-proxy` step: read the installed nginx version right after the package lands and pass it to `nginxVhost()`.

2.2 `ssl` step: pass the same version when it rewrites the vhost for the domain, and — on pre-1.25.1 — append the `http2` parameter to certbot's `listen 443 ssl;` once the certificate is in place. Best-effort/skippable: HTTP/2 is a performance property, never worth failing a working HTTPS install over.

### Phase 3: regression tests

3.1 Unit-test the version helpers across the 1.25.1 boundary and the unknown/garbage inputs.

3.2 Replace the assertion that pins `http2 on;` with both-branch coverage of `nginxVhost()`, plus a guard that the pre-certbot `:80` block carries nothing a 1.24 nginx rejects.

3.3 Cover the steps end to end against a fake runner reporting 1.24.0 vs 1.25.3: the written vhost, and whether the TLS-listener post-processing runs.

### Phase 4: validation and PR

4.1 Run the full gate (`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`).

4.2 Reuse the draft PR, refresh the body, apply labels, review pass, flip to ready.

## Risks

- **The post-certbot `sed` must match certbot's real output.** certbot writes `listen 443 ssl; # managed by Certbot` and `listen [::]:443 ssl ipv6only=on;`. The expression appends `http2` before the first `;` only on `listen` lines that mention 443 and `ssl` and do not already say `http2`, so it is idempotent and leaves the `:80` redirect block certbot adds alone. Covered by a unit test over representative listener lines.
- **Unknown nginx version.** Degrades to the `listen` parameter form, which every nginx from 1.9.5 on accepts — the failure mode is a deprecation warning on ≥ 1.25.1, never a parse error.
- **Existing installs.** Unchanged until they run `--reconfigure nginx-proxy` / `--reinstall`, at which point they pick up the corrected vhost.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

PR: #994

### Phase 1: version-aware vhost generation

- [x] 1.1 nginx version helpers (parse, compare, detect) — 669919d1
- [x] 1.2 nginxVhost emits the directive only on >= 1.25.1, comment corrected — 669919d1

### Phase 2: wire it through the install steps

- [x] 2.1 nginx-proxy passes the detected version to nginxVhost — 669919d1
- [x] 2.2 ssl step enables HTTP/2 on certbot's TLS listener on pre-1.25.1 — 669919d1, d5001dc9

### Phase 3: regression tests

- [x] 3.1 version-helper unit tests — d5001dc9
- [x] 3.2 nginxVhost both-branch tests replace the pinned assertion — d5001dc9
- [x] 3.3 step-level tests over a fake runner for both nginx versions — d5001dc9

### Phase 4: validation and PR

- [x] 4.1 full validation gate green

  | command | result |
  |---|---|
  | `npm run typecheck` | pass (api-client + server + web) |
  | `npm test` | 7178 passed, 3 failed — all three pre-existing and environmental, none in `server-install` (see below) |
  | `npm run test:unit` | 36/36 pass |
  | `npm run build` | pass, `check:pack ok — 530 files` |
  | `npm run test:package` | 16/16 pass |

  The `npm test` failures reproduce with this branch's `server-install` changes reverted to `origin/main`, and are caused by the sandbox's environment rather than the repo: `TMPDIR` points *inside* the repository, so the ~10 suites asserting behavior "outside a git repository" see a git root; and the ambient `CEZ_BIN` / `CEZ_TODOS_FILE` / `CEZ_*` variables of the running cockpit leak into the test process, so the system-prompt and agent-profile suites see blocks they assert are absent. Every `server-install` suite passes.

- [x] 4.2 PR body, labels, review pass, ready
