# Security Policy

## Supported Versions

cezar is pre-1.0, so only the latest minor release line receives security fixes.
Please upgrade to the newest release before reporting an issue.

| Version  | Supported          |
| -------- | ------------------ |
| 0.13.x   | :white_check_mark: |
| < 0.13   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests or discussions.**

Instead, email **[security@openmercato.com](mailto:security@openmercato.com)** with:

- a description of the vulnerability and its potential impact,
- the affected version (`cezar --version`) and platform (OS, Node version),
- step-by-step instructions to reproduce it, or a proof of concept,
- any suggested fix or mitigation, if you have one.

### What to expect

- **Acknowledgement** within 3 business days of your report.
- **Initial assessment** within 7 business days, telling you whether we accept
  the report and how severe we consider it.
- **Progress updates** at least every 14 days until the issue is resolved.
- **If accepted**, we will develop a fix, publish a patched release and credit
  you in the release notes (unless you prefer to stay anonymous).
- **If declined**, we will explain why — for example, if the behavior is
  intended or falls outside the scope below.

Please give us a reasonable amount of time to release a fix before disclosing
the issue publicly. We will coordinate the disclosure date with you.

## Scope

cezar is a local tool: the server binds to `127.0.0.1` and state lives in plain
files under `.ai/cezar/` and `~/.cezar/`. Reports we are especially interested in:

- ways for a web page, another local user or a remote host to reach or drive
  the cockpit API (DNS rebinding, CSRF, origin-guard bypasses, WebSocket abuse),
- command or code execution beyond what a task's agent is already allowed to do,
- leakage of credentials, tokens or tracker secrets managed by cezar,
- path traversal or writes outside cezar's own state directories and worktrees.

Out of scope: actions a coding agent takes with the permissions you granted it,
vulnerabilities in the agent CLIs themselves (Claude Code, Codex, OpenCode) or
in `gh` — please report those to their respective maintainers.
