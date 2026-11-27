# Per-agent provider configuration

Source doc: .ai/specs/2026-11-27-per-agent-provider-configuration.md
Spec PR #2548

[Verified CLI versions, supported methods and launch evidence](2026-11-27-provider-cli-evidence.md)

Give each agent a workspace-wide provider choice. Use the same encrypted credential and method store for Settings and headless setup. Keep existing host-configured and subscription-only installations working.

The implementation follows the three phases below. Vendor login remains with each CLI. Projects retain their own account and model defaults. The highest-risk paths are provider selection on Continue, isolation of keys between agents, and keeping hosted and phone clients read-only. Verify those paths with synthetic credentials in isolated homes.

## Progress

### Phase 1: Workspace agents

- [x] 1.1 Verify vendor capabilities against shipped CLIs — b39e324d0
- [x] 1.2 Define provider, model and run contracts — c15958ba6
- [x] 1.3 Implement encrypted storage and atomic changes — 679599f93
- [x] 1.4 Map verified methods to agent launch options — b39e324d0
- [ ] 1.5 Characterize existing launches and wire run selection and replay
- [x] 1.6 Fetch, cache and expose method-served models — 1b53684c7
- [x] 1.7 Register local-write routes and check HTTP compatibility — f71c6f198
- [x] 1.8 Add headless configuration and startup apply — 093c9a922
- [x] 1.9 Build workspace agent settings — 80263f852
- [x] 1.10 Fold account controls into subscription rows — 05888bde6

### Phase 2: Project agents

- [x] 2.1 Show provider availability in project agent settings — 8b420d539

### Phase 3: Composer

- [x] 3.1 Characterize composer availability — 9606823c6
- [x] 3.2 Select and submit method-served models — 63e03c101
- [x] 3.3 Document provider configuration — 3f1eda832
- [x] 3.4 Archive the capability delta — 3f1eda832
