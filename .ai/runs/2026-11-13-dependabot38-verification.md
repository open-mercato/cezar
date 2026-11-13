# Dependabot38 verification

Repository open-mercato/cezar. Source: open-mercato/cezar:dependabot:38; GHSA-238p-pmpm-9mq7:katex:package-lock.json. Branch fix/dependabot38-remove-katex; PR2163.

Direct parent Streamdown2.5.0 requires Mermaid^11.12.2, resolving Mermaid11.17.2 -> KaTeX^0.16.47, resolving0.16.47. Reported range >=0.11.0,<0.18.2. The physical original graph was installed with npm ci. A direct original KaTeX rendering probe gives controlAllowsJavascript=false, pollutedAllowsJavascript=true when Object.prototype.trust=true; the prototype property is always deleted in finally. This demonstrates the upstream gadget under a pre-existing-pollution precondition, not an exploitable pollution source in cezar.

Upgrade the direct parent to first compatible Streamdown2.6.0, which no longer imports Mermaid. The existing custom Pele diagram plugin still renders Mermaid. Only existing locked versions changed are Streamdown2.5->2.6 and required Remend1.3.0->1.3.1;97 package entries removed, none added. Complete lock enumeration and physical import resolution show zero KaTeX/Mermaid; npm ls --all exits0 and npm audit no longer lists target. Audit still has13 unrelated findings (5moderate/8high), which remain outside this source group and are not treated as a gate waiver.

Upstream adds code/table scroll bounds400/300px. The new height regression fails on upgraded source without compatibility props; with both maxHeight props0 it passes. Snapshots were inspected and refreshed only for upstream dir=ltr, aria labels/hidden icons, fixed CSS variable syntax, and block line spans. Full-height transcript defaults remain pinned.

All configured commands ran in order, each prefixed exactly timeout600 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp:

| Command | Result |
|---|---|
| npm run typecheck | PASS |
| npm test | PASS:15464tests,8existing skips |
| npm run test:unit | PASS:51tests |
| npm run build | PASS,including check:pack |
| npm run test:package | PASS:34tests |

Focused command: timeout120 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- packages/web/src/routes/task-thread/markdown.test.tsx packages/web/src/routes/task-thread/markdown-streaming.test.tsx packages/web/src/routes/task-thread/markdown-mermaid.test.tsx packages/web/src/lib/remend-links.test.ts --project web --testTimeout=30000:63passed. Red compatibility probe: same runner with -t 'full transcript height' before maxHeight props:1failed,43filtered.

Browser: provisioned configured agent-browser, set AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage,--disable-gpu only for this isolated test process because runner has no usable Chrome sandbox. No application setting/workflow/env contract change. Boot: timeout300 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp AGENT_BROWSER_ARGS=... CEZ_AGENT_MODELS_LOCKED=1 sh .ai/scripts/test-env-up.sh. Real browser command: timeout300 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp AGENT_BROWSER_ARGS=... CEZ_AGENT_MODELS_LOCKED=1 npm test -- packages/web/e2e/task-thread.e2e.ts --config packages/web/e2e/vitest.config.ts. Result17passed/6failed. Changed-consumer assertions pass, including streaming, real flowchart/sequence rendering, malicious diagram directives/links/images blocked, overflow and mobile layout. Six failures reference removed header h1/plan-mirror selectors and old Terminal/Notes-tab expectations. Original main dependency lock, web manifest and Markdown component were temporarily restored from12b78202 and rebuilt; the identical suite also gives17passed/6failed with exactly the same six failure names and selector errors. Final source/lock bytes were restored in finally, npm ci repeated and full build passed. This establishes these six failures as pre-existing test-selector drift, not a passing full-browser-suite claim.

No production code beyond the two compatibility props changes. No API/startup/configuration/default/env contract changes. release/v0.19.x has the vulnerable parent, backport label requested. Source alert remains open on main pending merge/rescan. No issue, merge, auto-merge, advisory publication, alert dismissal or settings/workflow change.


## Browser failure analysis

| Failed test | Evidence/diagnosis | Owner and next action |
|---|---|---|
| plan dock mirror | plan-mirror selector absent on both original/fixed builds | Existing E2E test maintenance; update against observed current header separately |
| auto-summary header | task-thread h1 selector absent on both builds | Existing E2E test maintenance; use current observed task title separately |
| layout strip | expected Terminal card; current Assets card on both builds | Existing E2E test maintenance; reconcile current navigation contract separately |
| Notes tab | old run-tabs link absent on both builds | Existing E2E test maintenance; use observed current tab control separately |
| inline rename | obsolete h1 wait times out on both builds | Existing E2E test maintenance; assert current title control separately |
| mobile header | old h1 selector absent on both builds | Existing E2E test maintenance; use observed current mobile header separately |

No assertions were removed, skips introduced, unrelated test repairs made, or product regressions waived. Screenshots show real light/dark/mobile Mermaid rendering using the unchanged custom renderer. Full consumer verification and required QA/native approval must remain explicit on PR; no merge is authorized.
