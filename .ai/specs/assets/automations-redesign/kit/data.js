// Sample data lifted from the cezar README screenshots (docs/screenshots/task-view.png).
window.CZ_DATA = {
  tasks: [
    { id:'t1', status:'needs review', tone:'violet', title:'Scrubbing bearer tokens out of NDJSON tool results before they land on disk', wf:'fix-and-verify', branch:'cez/f5d26a78', adds:87, dels:6, tokens:'96.5k', cost:'$0.83', mem:'peak 475 MB', age:'38m', bucket:'needs' },
    { id:'t2', status:'needs review', tone:'violet', title:'Fuzzy palette search via a scored subsequence match', wf:'quick-task', branch:'cez/0a1b2c3d', adds:64, dels:21, tokens:'71.2k', cost:'$0.62', mem:'peak 427 MB', age:'52m', bucket:'needs', group:'g1', variant:'A' },
    { id:'t3', status:'needs review', tone:'violet', title:'Fuzzy palette search — smallest diff, ranked by match position', wf:'quick-task', branch:'cez/1b2c3d4e', adds:39, dels:12, tokens:'58.9k', cost:'$0.49', mem:'peak 369 MB', age:'52m', bucket:'needs', group:'g1', variant:'B' },
    { id:'t4', status:'running', tone:'pending', pulse:true, title:'Backing off SSE reconnects — the cockpit hammered /api/events', wf:'quick-task', branch:'cez/b7e4d913', adds:46, dels:9, tokens:'31.7k', cost:'$0.27', cpu:'12%', mem:'313 MB', live:true, age:'5m', bucket:'working' },
    { id:'t5', status:'running', tone:'pending', pulse:true, title:'Adding --json output to `cez export`, with a snapshot test', wf:'fix-and-verify', branch:'cez/a3f1c8d2', adds:118, dels:14, tokens:'48.3k', cost:'$0.41', cpu:'4%', mem:'393 MB', live:true, age:'9m', bucket:'working' },
    { id:'t6', status:'queued', tone:'neutral', title:'Upgrade Tailwind v4 and drop the shim', wf:'fix-and-verify', tokens:'0', queue:3, age:'2m', bucket:'working' },
    { id:'t7', status:'queued', tone:'neutral', title:'Document the autonomous flag in the README', wf:'quick-task', tokens:'0', queue:2, age:'3m', bucket:'working' },
    { id:'t8', status:'queued', tone:'neutral', title:'Cache the GitHub issue list for 60s', wf:'quick-task', tokens:'0', queue:1, age:'4m', bucket:'working' },
    { id:'t9', status:'done', tone:'success', title:'Stream the diff view instead of buffering it', wf:'fix-and-verify', branch:'cez/2c3d4e5f', adds:203, dels:88, pr:'#412', tokens:'134.8k', cost:'$1.12', mem:'peak 489 MB', age:'1h', bucket:'recent', unread:true },
    { id:'t10', status:'done', tone:'success', title:'Warn when the base branch has moved under a worktree', wf:'fix-and-verify', branch:'cez/3d4e5f60', adds:71, dels:9, tokens:'62.4k', cost:'$0.53', mem:'peak 383 MB', age:'2h', bucket:'recent' },
    { id:'t11', status:'done', tone:'success', title:'Add per-step cost to the run summary', wf:'fix-and-verify', branch:'cez/4e5f6071', adds:52, dels:17, tokens:'44.1k', cost:'$0.38', mem:'peak 355 MB', age:'3h', bucket:'recent' },
    { id:'t12', status:'done', tone:'success', title:'Persist the queue across a cockpit restart', wf:'fix-and-verify', branch:'cez/5f607182', adds:96, dels:31, pr:'#408', tokens:'88.9k', cost:'$0.74', mem:'peak 444 MB', age:'4h', bucket:'recent' },
    { id:'t13', status:'failed', tone:'danger', title:'Heartbeat bump — verify stayed red after 2 retries', wf:'fix-and-verify', branch:'cez/93a4b5c6', adds:28, dels:11, tokens:'73.6k', cost:'$0.61', mem:'peak 399 MB', age:'4h', bucket:'recent' },
    { id:'t14', status:'done', tone:'success', title:'Clean up worktrees when a variant loses', wf:'fix-and-verify', branch:'cez/60718293', adds:44, dels:58, tokens:'51.3k', cost:'$0.44', mem:'peak 342 MB', age:'5h', bucket:'recent', read:true },
    { id:'t15', status:'done', tone:'success', title:'Show peak memory per run in the task table', wf:'fix-and-verify', branch:'cez/718293a4', adds:61, dels:8, tokens:'39.7k', cost:'$0.33', mem:'peak 328 MB', age:'6h', bucket:'recent', read:true },
  ],
  nav: [ ['list-checks','Tasks','tasks'], ['inbox','Inbox','inbox',2], ['git-branch','Git','git'], ['github','GitHub','github'], ['zap','Automations','automations'], ['sparkles','Skills','skills'], ['workflow','Workflows','workflows'], ['settings','Settings','settings'] ],
  // Scheduled + GitHub automations. Demo clock: Wed 2026-09-16 10:24 local.
  now: new Date(2026, 8, 16, 10, 24),
  automations: [
    { id:'a1', name:'Nightly dependency bump', kind:'schedule', sched:{ type:'daily', hour:4, minute:0 }, enabled:true, prompt:'Run npm outdated, bump patch and minor versions, run the test suite, open a draft PR titled "chore: nightly deps" if anything changed.', workflow:'fix-and-verify', runner:'claude', model:'sonnet', autonomous:true, budget:'$2.00', dispatch:true, maxChildren:4, reviewChild:true, last:{ tone:'success', label:'done', age:'6h', task:'t15', cost:'$0.33' }, runs7d:7, cost7d:'$2.41' },
    { id:'a2', name:'Triage new issues', kind:'github', event:'issue.opened', every:5, enabled:true, prompt:'Read {{github.url}}. Label it (bug / feature / question), add a one-paragraph repro or clarification request, never close it.', workflow:'quick-task', runner:'claude', model:'haiku', autonomous:true, budget:'$0.50', last:{ tone:'success', label:'done', age:'41m', task:'t10', cost:'$0.08' }, runs7d:19, cost7d:'$1.52' },
    { id:'a3', name:'Weekday morning CI sweep', kind:'schedule', sched:{ type:'weekdays', hour:7, minute:30 }, enabled:true, prompt:'List workflows that failed on main since yesterday 07:30. For each, find the root cause and open one task per distinct failure with a proposed fix.', workflow:'quick-task', runner:'codex', model:'gpt-5-codex', autonomous:true, budget:'$1.00', dispatch:true, maxChildren:6, reviewChild:false, last:{ tone:'danger', label:'failed', age:'3h', task:'t13', cost:'$0.61' }, runs7d:5, cost7d:'$2.90' },
    { id:'a4', name:'Stale PR nudge', kind:'schedule', sched:{ type:'hours', every:6 }, enabled:true, prompt:'For every open PR with no activity in 48h, summarize what is blocking it and post a short comment asking the author. Skip drafts.', workflow:'quick-task', runner:'claude', model:'sonnet', autonomous:true, budget:'$0.40', last:{ tone:'success', label:'done', age:'4h', task:'t11', cost:'$0.12' }, runs7d:28, cost7d:'$3.08' },
    { id:'a5', name:'Weekly changelog draft', kind:'schedule', sched:{ type:'weekly', day:5, hour:16, minute:0 }, enabled:true, prompt:'Collect merged PRs since last Friday 16:00, group by area, write CHANGELOG.md entries in the existing voice, open a draft PR.', workflow:'fix-and-verify', runner:'claude', model:'opus', autonomous:false, budget:'$3.00', last:{ tone:'success', label:'done', age:'5d', task:'t12', cost:'$1.12' }, runs7d:1, cost7d:'$1.12' },
    { id:'a6', name:'Flaky test hunt', kind:'schedule', sched:{ type:'weekly', day:2, hour:2, minute:0 }, enabled:false, prompt:'Run the unit suite 5×. Any test that fails at least once but not always: quarantine it with a TODO and open an issue with the failure log.', workflow:'fix-and-verify', runner:'claude', model:'sonnet', autonomous:true, budget:'$4.00', dispatch:true, maxChildren:8, reviewChild:true, last:{ tone:'success', label:'done', age:'8d', task:'t14', cost:'$2.70' }, runs7d:0, cost7d:'—' },
    { id:'a7', name:'Review open PRs', kind:'github', event:'pull_request.opened', every:10, enabled:true, prompt:'Review {{github.url}} for real issues only: correctness, security, missing tests. Comment inline; never approve or merge.', workflow:'quick-task', runner:'claude', model:'sonnet', autonomous:true, budget:'$0.80', last:{ tone:'violet', label:'needs review', age:'52m', task:'t2', cost:'$0.62' }, runs7d:6, cost7d:'$2.35' },
  ],
  templates: {
    builtin: [
      { name:'Nightly dependency bump', when:'Every day at 04:00', kind:'schedule', prompt:'Run npm outdated, bump patch and minor versions, run the test suite, open a draft PR if anything changed.' },
      { name:'Triage new issues', when:'On issue.opened · every 5 min', kind:'github', prompt:'Read {{github.url}}. Label it, add a repro or a clarification request. Never close it.' },
      { name:'Weekly changelog draft', when:'Fridays at 16:00', kind:'schedule', prompt:'Collect merged PRs since last week, write CHANGELOG entries, open a draft PR.' },
      { name:'Stale PR nudge', when:'Every 6 hours', kind:'schedule', prompt:'Comment on PRs idle for 48h with what is blocking them.' },
      { name:'Flaky test hunt', when:'Tuesdays at 02:00', kind:'schedule', prompt:'Run the suite 5×, quarantine intermittent tests, open an issue per test.' },
      { name:'Security advisories', when:'Every day at 06:00', kind:'schedule', prompt:'Run npm audit; for each high/critical advisory open a task with the upgrade path.' },
    ],
    mine: [
      { project:'storefront', name:'Sync translations', when:'Weekdays at 09:00', kind:'schedule', prompt:'Pull new keys from src/locales/en.json, machine-translate missing pl/de entries, open a PR.' },
      { project:'storefront', name:'Lighthouse budget check', when:'Every day at 05:00', kind:'schedule', prompt:'Run lighthouse against staging; if any budget regresses > 5%, bisect the last day of commits.' },
      { project:'api', name:'Contract drift', when:'Every 12 hours', kind:'schedule', prompt:'Diff the OpenAPI spec against the generated client; regenerate and open a PR when they diverge.' },
      { project:'infra', name:'Cert expiry watch', when:'Mondays at 08:00', kind:'schedule', prompt:'List TLS certs expiring within 21 days and open one task per host.' },
    ],
  },
};
