---
name: security-signals
description: Signals for spotting security-relevant issues even when not explicitly labelled.
cezar-stages:
  - security
---

# Security signals

Goal: flag issues with security implications, even when they aren't labelled
"security". False positives are acceptable here — it's better to flag and
review than to miss a vulnerability.

## Detection categories

- **Authentication bypass** — login or session issues that could allow
  unauthorized access. Examples:
    - Password-reset flow that doesn't invalidate the old session.
    - JWT signature not being verified on a protected route.
    - "Remember me" cookie that survives an explicit logout.
- **Session hijacking** — session fixation, cookie theft, token leakage in
  URLs / logs / referrers. Examples:
    - Session id passed in a query string that ends up in HTTP referer.
    - Cookie set without `Secure` / `HttpOnly` over HTTPS.
    - Server reuses a pre-login session id after sign-in.
- **Privilege escalation** — users gaining access beyond their assigned
  role; horizontal (user A reads user B's data) or vertical (member acts
  as admin). Examples:
    - Endpoint accepting `?user_id=` overrides the session user.
    - Admin-only feature gated only on the client.
    - Role check that compares against a stale cached role.
- **Injection** — SQL, command, path traversal, XSS, template injection,
  prompt injection on AI features. Examples:
    - User input concatenated into a SQL query without parameterisation.
    - File path built from user input without `..` containment.
    - Markdown rendering that allows raw `<script>` tags.
    - Prompt-injection content from a third-party tool steering a Claude
      response — counts as injection even though there's no SQL.
- **Data exposure** — API keys in logs, PII leakage, sensitive data in
  error responses or 4xx bodies, secrets in URLs. Examples:
    - Stack trace returned to the client that names internal services.
    - `/api/users/me` returning password hash or full address book.
    - GitHub token included in a webhook payload echo.
- **Credential logging** — passwords, tokens, or session cookies written
  to logs / consoles / metrics. Examples:
    - `console.log(req.headers)` shipped to a hosted log pipeline.
    - Stripe webhook secret included in a Sentry breadcrumb.
    - Bearer tokens captured by a generic request middleware.
- **Dependency vulnerabilities** — known CVEs in libraries, outdated
  packages with public security fixes. Examples:
    - `npm audit` calling out a high-severity advisory still open.
    - Issue title mentioning a specific CVE id (e.g. `CVE-2024-…`).
    - Bumping a transitive dep that ships a public exploit POC.

## Confidence and severity

- Confidence reflects how clearly the issue describes a security problem
  (0.0–1.0). Flag only when confidence ≥ **0.70**.
- Severity reflects the **potential impact if exploited**, not how clearly
  the issue is written:
    - `critical` — RCE, auth bypass, mass PII leak.
    - `high` — privilege escalation, credential exposure, exploitable
      injection.
    - `medium` — limited data exposure, denial-of-service.
    - `low` — informational, defence-in-depth.

## Read the full body

Security details are often subtle and buried mid-body. Don't rely on the
title alone. Check comments for CVE references or severity clarifications.

## When it's not a security issue

Set `isSecurityRelated: false` and leave category / severity / explanation
empty — don't moralise about unrelated security best-practice.

## Comment style

Any comment you suggest or post must be short and direct: one line —
finding, severity, evidence. No filler, no preamble.
