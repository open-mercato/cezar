# Zero-config simlock

**Goal.** Installing `simlock` on the cezar host is the only human step for parallel tasks to get
one mobile device each, on every runner.

| Need | Mechanism | Why |
| --- | --- | --- |
| Discovery | `simlock` on the server's `PATH`, re-read at each launch and settle | No setting, no restart. `CEZ_SIMLOCK=0` and `CEZ_DRY_RUN=1` turn it off. |
| Identity | `SIMLOCK_AGENT_ID=cezar:<runId>`, `AGENT_DEVICE_SESSION=cezar-<runId>` in `agentEnv` | Without it simlock identifies only Claude Code and Codex; other runners get a new requester per command and no one-lease limit. `CEZ_ENV_PASSTHROUGH` would make every session one requester. |
| Telling the agent | One system-prompt paragraph pointing at `simlock instructions` | `simlock setup` writes files and covers two tools. The rules stay simlock's own. |
| Giving it back | On a run's transition to a terminal status: `daemon status --json`, `list --leases`, `release <id>` | A cancelled agent's detached lease otherwise holds a device until its TTL. `list` alone would start a stopped daemon. |

**Transitions.** A lease leaves through: the agent's own release, the settle sweep, a delete of an
unsettled run, or simlock's TTL, which is the backstop for every failure and for a server that died
mid-run. An unanswered `CEZ:ASK` (`awaitingAnswerSince`) is a hold and is swept at its real outcome.

**Not covered.** Gateways and remote `agent-device` tokens: those leases are held by the token, so
they end at their TTL. Mobile e2e check steps are a separate change.
