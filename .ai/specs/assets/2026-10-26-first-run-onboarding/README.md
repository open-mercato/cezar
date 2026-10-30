# First-run onboarding — screens

Screenshots of the running cockpit (branch `feat/first-run-onboarding`). Dialogs sit centred over the content column, not the whole window. Every screen comes as
`NN-name.png` (1440 px, dark), `NN-name-light.png` (1440 px, light) and, where the layout changes,
`NN-name-mobile.png` (390 px, dark). Spec: `../../2026-10-26-first-run-onboarding.md`.

| # | Screen | When the user sees it | Variants |
| --- | --- | --- | --- |
| 01 | Sign in to an agent | No agent CLI is signed in. Step 1 of 3. "Sign in" opens the CLI login and the page advances by itself; a missing CLI gets numbered steps with its install command. "Continue anyway" skips it for good. | dark, light, mobile |
| 02 | Pick a project, nothing found | The folder has no git and no repositories were found on disk. Three choice cards; the recommended one is marked. | dark, light, mobile |
| 03 | Pick a project, repositories found | Repositories from the registry, the agent's history and a shallow scan; search, Enter opens. `gh` signed in, so "Clone from GitHub". | dark, light, mobile |
| 04 | Pick a project, GitHub not connected | Same list, with "Connect GitHub" in place of Clone. | dark, light |
| 05 | Welcome, fresh repository | Only the initial commit and no issues: bootstrap suggestions, then skills. Design Mode announcement above. | dark, light, mobile |
| 06 | Welcome, GitHub issues | The repository's open issues as one-click tasks, with labels, author, age, comments. | dark, light, mobile |
| 07 | Welcome, recent work | No GitHub: the last commits as a starting point. | dark, light, mobile |
| 08 | After the first task | The task table with the setup pill (worktree scripts, Connect / Publish to GitHub). | dark, light |
| 12 | Welcome with activity (variant) | A project with a month of history: tasks per day between the suggestions and the start-from list. Never shown on an empty project. | dark, light, mobile |
| 14 | Connect GitHub, code | cezar runs the GitHub sign-in itself: the one-time code with Copy, GitHub already open in the browser, "Waiting for GitHub…". Closes itself when GitHub approves. | dark, light, mobile |
| 14b | Connect GitHub, no CLI | The GitHub CLI is not installed: an install link and Try again. | dark, light |
| 14c | Connect GitHub, denied | GitHub refused or the code expired: `gh`'s own line and Try again. | dark, light |
| 14d | After GitHub connected | The pick-a-project screen right after approval: toast, and "Clone from GitHub" in place of Connect. | dark, light |
| 15 | Initialize git | What git is for, and that cezar runs the three commands itself. | dark, light, mobile |
| 16 | Publish to GitHub, sign in | The same sign-in inside Publish, when `gh` is not signed in yet. | dark, light |
| 17 | Publish to GitHub, after sign-in | The owner and repository name, right after the code was approved. | dark, light |
| 18 | New project (existing dialog) | Reached from "New project" on the pick-a-project screen. Unchanged by this work. | dark, light |
| 19 | Clone from GitHub (existing dialog) | Reached from "Clone from GitHub". Unchanged by this work. | dark, light |
| 20 | Welcome back | Two weeks or more away: a card above the table with "Welcome back", one sentence of good news ("One task is ready for your review, and there are 5 new features to try.") and two buttons, Review task and See what's new. "New" dots on Automations, Workflows and Settings; "What's new" in the sidebar footer. | dark, light, mobile |
| 21 | What's new | One change per page with a miniature of it, the date, one sentence and a way to the feature. Dots and Back/Next in the footer; the dialog keeps its size from page to page. Pages 1 to 5: task tabs, task palette, Design Mode, worktree scripts, workflow editor. | dark, light, mobile |
