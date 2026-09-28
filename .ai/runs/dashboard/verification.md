# Dashboard — verification and delivery

Behavior is specified in [Workspace dashboard](../../specs/2026-09-18-observability-dashboard.md)
and [Usage, trends and export](../../specs/2026-09-19-dashboard-costs.md).
Publication progress: [execution plan](../2026-09-20-dashboard-publication.md).

## Delivered behavior

Overview and Usage & cost provide eight sortable modules, view-scoped restore actions,
workspace-persisted preferences, task drill-downs, enabled-automation deadlines and local
PDF/CSV exports of visible modules and loaded rows. Optional reported USD/token metrics
remain independent of process telemetry. GitHub is demand-driven and distinguishes absent
configuration, stale results and failed refreshes. Operations URLs remain a compatibility path.

## Boundary and regression coverage

Service tests cover single-project scope, request guards, validated pagination, immutable
snapshots and expiry, deleted projects/tasks, policy changes during pending reads, inaccessible
or partly corrupt indexes, read-only cold-project access, forge host selection and demand limits.
Contract parity covers the consuming typed client; existing SSE payloads remain valid.

Preference tests cover unknown fields and future widget IDs through file/GET/PUT round-trips,
reorder/reset and unrelated writes. Eight supported IDs have capacity separate from the 200
future-ID budget. Cost expiry recovery retains the snapshot timezone. UI tests cover missing,
loading, failed and partial data, interactive charts, drawer navigation, filters and export scope.
Exports distinguish missing values from zero and escape spreadsheet formulas and printable text.

During publication, current main changed OpenCode's turn boundary: the runner cost stub now
emits session.idle, preserving all 18 assertions. The dashboard route also uses a lazy boundary
so unrelated screens do not import its widgets/report renderer eagerly; its guard was verified
failing before the fix. These are follow-up commits, not rewrites of published history.

## Validation

Fresh publication gate on code head 58b8c310, based on upstream main 4763447f:

| Command | Result |
| --- | --- |
| npm run typecheck | PASS — all four workspaces |
| npm test | PASS — 425 files, 7448 tests |
| npm run test:unit | PASS — 36 core CLI/module tests |
| npm run build | PASS — service, web and check:pack (567 files / 104 web assets) |
| npm run test:package | PASS — 16 packaged CLI E2E tests |

The dashboard now has a separate production chunk: 81.73 kB / 23.69 kB gzip.
The initial JS entry is 358.49 kB / 99.12 kB gzip. No dependency was added.
The first post-rebase suite exposed six OpenCode fixture timeouts; the explicit turn-idle
fixture fix passed all 18 focused cases and the subsequent complete gate above.

Fresh Chromium verification on 58b8c310 passed cold loading of both views, Needs-you drawer,
keyboard reorder, persisted reload, mobile width and console checks. CSV matched all 45 Overview
and 185 Usage on-screen rows. PDF generation produced 3/4 pages; all were rasterized and their
text extracted, with representative pages visually inspected. Test fixtures are isolated from
the user's workspace. Automations were disabled in this fresh fixture.

- [Synthetic UI and print evidence](https://github.com/open-mercato/cezar/pull/1047#issuecomment-5748333690)
- [Automated review and full gate](https://github.com/open-mercato/cezar/pull/1047#issuecomment-5748337031)

Prior Chromium checks exercised layout persistence, keyboard reorder, mobile width, automation
schedule/check states, GitHub retries and Needs-you drawer focus restoration. Four PDF/CSV pairs
covered Overview/Usage with all or selected modules visible: 64/188/43/180 data records plus
context rows matched captured screen annotations; PDFs had 4/3/3/2 pages. A forced snapshot
expiry preserved the Europe/Warsaw cohort boundary. Those local fixture checks are historical
supporting evidence; the publication PR names the fresh checks separately.

## Material limits

- Reported usage covers retained-task lifetime values, not billing or a complete spend history.
  Task completion does not prove accepted business outcomes.
- Core RunStore's pre-existing all-or-nothing malformed-index behavior is not changed here;
  dashboard coverage now discloses it. The disk-only diagnostic reader salvages valid entries.
- Whether Claude's per-turn total_cost_usd accumulates across a continued session was not
  verified against a real provider. The dashboard displays the runner/store's existing reports
  and does not claim reconciliation with provider invoices.
- Browser evidence uses synthetic projects and controlled failures. It is not a production
  acceptance environment or a formal accessibility/security audit. Manual QA remains required.
- Preview servers, generated reports, local paths, workspace state and private project data are
  excluded from the implementation branch. Public screenshots use isolated synthetic fixtures.


## Local review fixes — 2026-09-25 (uncommitted)

Resolved the six follow-up findings against local head `02052879`:

- Cold diagnostic reads preserve saved running/waiting/queued states, disclose partial
  live-state coverage, and never invent failed outcomes or completion timestamps.
- Operational snapshot, task and feed responses omit optional USD fields when the
  visibility policy is disabled, including cached data, without mutating snapshots.
- Git repository probe failures preserve stale results; successful remote changes or
  removal detach old identities so unrelated historical results cannot reappear.
- Pending GitHub sources remain manually refreshable after the bounded follow-up.
- Dashboard filter changes preserve history-entry identity and Back restoration.
- Displaced task lookup failures show an explicit error and Retry instead of endless checking.

Regression cases were demonstrated failing before the fixes. Independent review of the
combined changes found no blocking issue. Shared route, contract, cache and navigation
conventions were retained; no dependency, state migration or event was introduced.

Validation: full suite 426 files / 7463 tests passed; all-workspace typecheck, build and
check:pack passed; test:unit 36 and test:package 16 passed. The final coverage wording
follow-up passed the focused 21 web tests and web typecheck.

Fresh isolated Chromium checks passed Overview/Usage loading, Needs-you drawer, keyboard
reorder and reload persistence, mobile width and console checks. CSV values matched all
45 Overview and 185 Usage screen records. PDFs generated 3 and 4 pages; all pages were
rasterized and their text extracted, with representative pages visually inspected.
These checks used synthetic fixtures with automations disabled, not real provider acceptance.
The temporary verification server was stopped. No commit, push or PR mutation was performed.


## Additional local review fixes — 2026-09-25 (uncommitted)

Closed the three follow-up findings against `888114cb`:

- Dashboard opts into strict remote discovery through the existing Git helper. Failed
  enumeration/URL reads preserve stale cached source data; confirmed removal detaches it.
  Other helper callers keep their existing behavior.
- GitHub rows absent from the current source/window leave the displayed/exported results
  immediately. Insertions remain staged; explicitly stale cached rows remain qualified.
- Back restoration no longer depends on a hidden operational query. It preserves entry
  state, retries delayed DOM/size layout within the existing five-second bound, and stops
  when the user interacts.

New regressions failed before fixes, then passed: four real-Git boundary tests, three feed
and export tests, and five navigation tests. The shell-based Git fixture is skipped on
Windows; its actual subprocess assertions ran on Linux. Independent review found no blockers.

Fresh validation: full suite 430 files / 7476 tests PASS; all-workspace typecheck and final
web typecheck PASS; build/check:pack PASS (567 files / 104 web assets); test:unit 36 PASS;
test:package 16 PASS. Commands used system temporary storage outside the repository.
Chromium on isolated synthetic fixtures confirmed direct Costs → task → Back restores the
250px scroll position without page errors. Feed tests verify detached rows are absent from
both CSV and printable HTML. No new full PDF visual audit or real-provider QA is claimed.
The temporary browser fixture server was stopped. No commit, push or PR mutation performed.

## Fresh-start fixes — 2026-09-25

Dashboard automations now use a typed workspace projection over existing files. Regression
coverage proves cold contexts/recovery are untouched, state is not created or rewritten,
missing files are empty and corrupt/unreadable data remains unavailable. No prompt content,
forge probe or scheduler activation is introduced. The route is inventoried in BC §2.

Fresh nonrepositories and unborn Git repositories no longer show false GitHub errors;
missing roots, damaged metadata and transient remote failures retain their error/stale
semantics. Independent review caught Git's filesystem-boundary diagnostic, reproduced on
/dev/shm and fixed with a RED→GREEN regression and matching discovery boundary.

Usage retains accepted source/date qualifications until updates are accepted. Complete
empty Usage/Trends show neutral compact copy and omit hidden numeric export rows; partial
sources, missing reports and older-born completion throughput remain distinct.

Validation: full suite 431 files / 7491 tests PASS before the final filesystem-boundary
follow-up; final affected Git suites 4 files / 35 tests PASS. All-workspace typecheck,
build/check:pack (570 files / 104 web assets), unit36 and package16 PASS; final server
build/typecheck PASS. Tests use temporary storage outside the repository. Chromium on an
isolated empty project with automations default-on verified Overview and Costs at desktop
and 390px mobile, no page errors or horizontal overflow, neutral unconfigured GitHub state,
compact empty cards, light theme and explicit initial503 error states. Export regression
tests verify empty/partial displayed content; no new full PDF/provider QA is claimed.
No commit, push or PR mutation performed.

## Snapshot qualification and focus fixes — 2026-09-25

Saved cost snapshots now conservatively retain incomplete coverage and omitted counts across
source recovery; new failures can worsen the qualification, while a fresh capture reflects
recovered rows. Existing deletion/project invalidation remains intact. Usage task Sheets now
restore focus to their View tasks or project-row opener, following Overview's convention.

Regression pass observed the original coverage/focus failures before fixes. Final focused
validation: 5 files /44 tests PASS, all-workspace typecheck and server/web builds PASS,
clean diff check. Independent review found no blocking findings. Chromium reproduced
View tasks → Enter → Escape with focus now back on View tasks; next Tab stays in dashboard.
Backend runtime repro preserves unavailable coverage on the old0-row snapshot while the
fresh snapshot contains the recovered task. No full-suite rerun was needed for these bounded
fixes (prior full431/7492 result belongs to the preceding review). No commits or pushes.

## Unborn Git and feed update fixes — 2026-09-25

Unborn repository identity is now an explicit getRepoInfo option used only by dashboard
forge discovery. Default callers again receive null before the first commit, preserving
RunManager's serial in-place first-task path. Existing committed-repository worktree failures
still fail closed. A real Git/RunManager regression runs a local command under the root lease;
removing the fix makes it fail before workflow execution (RED confirmed).

Feed staging removes detached GitHub identities before comparing positions. Surviving rows
no longer create phantom update counts merely by shifting indices. Tests retain real insert
and reorder behavior and preserve stale source rows.

Both original regressions failed before the implementation. Final targeted gate:9 files /57
tests PASS; all-workspace typecheck, build/check:pack PASS. Independent review found no
issues. No full-suite or new browser/PDF rerun claimed for these bounded changes. Prior
full-suite lock-age flake remains outside this fix. No commits, pushes or PR mutations.

## Zero-cost settlement and Usage drilldown fixes — 2026-09-25

Dispatch keeps a settled child's reservation when its reported cost is zero or absent.
Zero remains a valid displayed report, but does not establish complete final cost; this
preserves the pre-dashboard budget rule without adding state or altering positive-cost
settlement. The real RunManager/OpenCode regression exercises preliminary zero, 10,500
tokens and failure before final cost, retaining the $2 child reservation.

Usage project and View tasks drilldowns open the displayed accepted cohort. Refreshes
arriving after opening remain candidates behind the Sheet's existing update control,
including its accepted-snapshot pagination and expiry behavior.

Both regressions failed before fixes. Validation: full432 files /7503 tests PASS,
all-workspace typecheck (including server build) PASS, web build and diff-check PASS.
Independent review of this bounded diff found no issues. No new real-provider or browser/PDF
QA claimed. No commits, pushes or PR mutations performed.

## Usage detail coverage — 2026-09-25

Task Sheets now reuse Coverage for accepted partial results (including nonempty expiry
recovery) and separately expose worsening candidate sources. Recovery retains accepted
warnings until Show. Both regression tests failed before the fix; focused29 and full
432 files /7505 tests PASS, web typecheck/build and diff-check PASS. No commits/push.

## Dashboard control and Sheet recovery fixes — 2026-09-25

Usage period and sort controls stay mounted to preserve keyboard focus. Detail sorting
keeps the accepted cohort and still requires Show for an expired snapshot replacement.
The last server visibility policy survives pending or failed ranking requests. Operational
Sheets render their initial loading/error and Retry internally, allowing recovery in place.

Regression tests failed before their fixes. Final focused44, full432 files /7512 tests,
web typecheck/build and diff-check PASS. Chromium confirms period focus remains SELECT
and snapshot503 exposes Retry inside the open Sheet. Independent bounded review is clear
after the retained-policy guard. No commits, pushes or PR mutations.

## Dashboard reconciliation and keyboard regressions — 2026-09-25

Known task transitions survive unrelated bounded reads. Fresh feed and cost rows reconcile
positive identities; historical cost pages carry their capture revision, and authoritative
confirmations advance the observation revision so older pages cannot roll back newer truth.
Feed controls stay mounted while staged rows reset by filter identity. Outcome navigation
stays mounted and focuses the loaded summary. Operational notices follow active demand.

Regression failures were observed before fixes, including missed-event recovery and
same-revision historical-page ordering. Final focused122 and full434 files /7522 tests PASS;
web typecheck/build and diff-check PASS. Chromium confirms feed focus, outcome summary focus,
and no operational error on healthy Costs. Independent re-review is clear. All code changes
are dashboard-specific; no commits, pushes or PR mutations.

## Operational coverage demand — 2026-09-25

Operational Coverage now uses the same needsSnapshot gate as operational errors and
connection notices. Regression cases prove it disappears on Costs, returns on Overview,
and leaves independent partial-cost warnings intact. RED2→GREEN5; full434 files /7524
tests PASS, web typecheck/build and diff-check PASS. Chromium confirms the original
Overview-partial → Costs-complete reproduction is fixed. No commits or push.

## Cached sources, removed projects and Back navigation — 2026-09-25

Pending Git identity discovery retains previously cached GitHub results with stale/loading
coverage at the response deadline. Completed remote removal still detaches rows. Project
removal immediately disables retained task links, including previously unseen identities;
older reads cannot reverse removal, while re-registration or newer positive reads recover.
Explicitly invalid empty start timestamps remain invalid for cycle calculations.

Recent results restores its inner scroll per history entry and source filter, accepts a
clamped position after results shrink, and yields restoration to user interaction. Regression
tests failed before the fixes. Chromium confirms Back restores352→352 and the task focus.
Focused backend28, event/truth60, scroll/navigation/reconciliation13 tests passed. All-workspace
typecheck and build/check:pack passed, followed by final web typecheck/build after the scroll
follow-up. No commits, pushes or issue mutations.
Final full-suite rerun:435 files /7532 tests PASS. The first run exposed an outdated Feed
state mock (corrected) and an OpenCode process-test failure (standalone13 and final full
rerun PASS); no runner implementation was changed for these dashboard fixes.

## Fresh reads and history navigation — 2026-09-25

Fresh operational reads reconcile truth at their request revision even when the server
reuses a snapshot ID; historical pages retain their original revision. Outcome task
links honor task/project tombstones without changing historical metric values.
Dashboard view history has independent entry identities. Outcome and Usage Sheets retain
selection, paging, sorting, scroll and focus across task navigation; explicit reopening
starts a new selection. Restoration waits for slow detail requests to settle, yields to
user interaction, and restores the opener after a history remount. Stored presentation
state is bounded and never overrides current visibility policy.

Regression tests failed before fixes. Final full suite:436 files /7548 tests PASS;
all-workspace typecheck, build and check:pack PASS. The first run had one obsolete
navigation assertion against the background of a correctly restored modal; it was updated
and the full suite rerun. Chromium confirms task→Back Sheet/focus restoration, closing to
the metric opener, separate view scroll restoration60→60 and empty mobile without overflow
or page errors. Test fixtures and browser scripts remain outside the repository.

Deep review covered the full feature diff from4763447f, shared cost/dispatch paths,
telemetry/SSE, API contracts, source/cache lifecycles, preferences, exports and UX history.
A final independent inspection found no further concrete bug after fixing restored-close
focus and slow-loading restoration. This is not a guarantee against every integration
failure: live-provider multi-turn accounting, live GitHub and concurrent independent
server preference writes were not manually exercised in this pass. Local work only.


## Review follow-up — 2026-09-26

Seven findings addressed locally: workspace-client cost visibility survives cached/history
restoration and ignores older in-flight responses; operational project Sheets reconcile
live status/archive changes while historical outcomes retain their captured semantics;
cold reader cache identity detects root permission changes; saved cost coverage retains
its original project cohort; all polling automations use Next check in UI and exports;
project metric accessible names include their count or Unavailable; timestamps sort by
parsed instant with stable identity ties.

Regressions were observed failing before fixes. Focused backend34, cost UI/API45,
automation6 and overview19 tests passed. Independent review found no additional confirmed
issue. All-workspace typecheck and build/check:pack passed.

Final full suite:486 files /8150 tests PASS (213.36s). Diff-check PASS.
Changes remain local and uncommitted; no push or PR/issue mutations.
