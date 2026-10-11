# Code signing policy

> **Draft.** This page is a requirement of the SignPath Foundation programme and is written
> ahead of the application. The wording SignPath requires, and the people named under Roles,
> must be confirmed before the application is sent.

Free code signing provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

## What is signed

The Windows installer of the cezar desktop app, `cezar-windows-x86_64-setup.exe`, and nothing
else. macOS builds are signed by Apple's own scheme; Linux packages are not signed.

Every signed installer is built by GitHub Actions from this repository
(`.github/workflows/desktop-release.yml`) on a GitHub-hosted runner. No installer built on a
developer's machine is ever signed.

## Roles

| Role | Who |
| --- | --- |
| Committers and reviewers | [Members of the open-mercato organization with write access](https://github.com/orgs/open-mercato/people) |
| Approvers | [@pat-lewczuk](https://github.com/pat-lewczuk), [@patzick](https://github.com/patzick) |

Every change reaches `main` through a pull request. A release is started by hand by an
approver; nothing is signed on a push.

## Privacy policy

cezar runs on your machine and has no accounts, no telemetry and no analytics. It does not send
your code, your prompts or your usage anywhere on its own behalf.

It does talk to the network, and only for what you can see it doing:

- **npm registry** (`registry.npmjs.org`) — the desktop app installs cezar from it, and both
  the app and the cockpit ask it which version is newest. The request names the package and
  nothing about you.
- **GitHub releases** (`github.com`) — the desktop app asks whether a newer app version exists
  and downloads it when you accept.
- **GitHub, through your own `gh`** — issues, pull requests and checks of the repository you
  opened, with the credentials you already gave `gh`.
- **The coding agents you run** — Claude Code, Codex and OpenCode talk to their own vendors
  under their own terms. cezar starts them; it does not sit between them and their service.

Set `CEZ_DESKTOP_NO_UPDATE` to stop the desktop app's update check.
