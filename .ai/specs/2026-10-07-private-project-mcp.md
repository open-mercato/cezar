# Private, per-project MCP servers

## TLDR

A user with a personal MCP server — one whose credentials belong to them, not the team — needs it
in **one** project, **never committed**, and working on **every** agent cezar runs. None of the
agents' own scopes gives all three at once inside cezar:

| Option | One project | Never committed | Reaches cezar runs |
|---|---|---|---|
| Repo `.mcp.json` / `opencode.json` / `.codex/config.toml` | yes | **no** — it is the shared file | yes |
| Uncommitted `.mcp.json` hidden by `.git/info/exclude` | yes | yes | **no** — a worktree is a fresh checkout; and impossible when `.mcp.json` is already committed |
| `claude mcp add --scope local` (`~/.claude.json`, keyed by path) | yes | yes | **no** — runs execute in `.ai/cezar/worktrees/<runId>`, a different path; Claude only |
| User scope (`~/.claude.json`, `~/.codex/config.toml`, …) | **no** | yes | yes |

This spec adds one cezar-owned file, **`<repo>/.ai/cezar/mcp.local.json`**, in the `.mcp.json`
shape. cezar reads it at every agent launch and injects the servers through each agent's own
documented launch-time channel. Nothing is written into the worktree, so a committed `.mcp.json`
is irrelevant and an agent cannot commit the file by accident.

## The file

```json
{
  "mcpServers": {
    "tracker": { "command": "npx", "args": ["-y", "tracker-mcp"], "env": { "TOKEN": "…" } },
    "docs":    { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

- `type` is `stdio` | `http` | `sse`. When it is omitted, `command` means stdio and `url` means http.
- Server names are `[A-Za-z0-9_-]{1,64}`. Codex has the strictest rule, so it is used for every agent.
- Values are literal. Agent child envs are least-privilege (`agent-env.ts`, #427), so `${VAR}`
  expansion against the host env would mostly expand to nothing. Tokens go in the file itself,
  which is why it is private.
- **Location**: cezar's data dir, beside `config.json`. It is per project by construction, it sits
  outside every worktree, and deleting `.ai/cezar/` removes it along with all other project state.
  `~/.cezar/projects/<id>/` was rejected: the project id is a registry slug, and the file would
  then outlive the checkout it configures.
- **Never committed**: `mcp.local.json` (and its atomic-write temp name) are in
  `DATA_GITIGNORE_ENTRIES`. A write through Settings re-runs `ensureDataGitignore` before the
  bytes land and writes `0600`.
- **Degradation**: an absent file means no servers and no note. A broken file, or a broken entry,
  becomes a run note and is skipped one entry at a time. It never fails a run (zero-config rule).

## Injection per agent

Verified live on 2026-10-07 against Claude Code 2.1.280, codex-cli 0.142.4 and opencode 1.17.18. Each was
given a stdio probe server that records its argv and env on start.

| Runner | Channel | Notes |
|---|---|---|
| `claude` | `--mcp-config <file>` | Adds to the repo/user MCP config (not `--strict-mcp-config`). The file is a `0600` temp file removed when the session ends: argv is world-readable via `ps`, a file is not. The servers' tools are added to `--allowedTools` as `mcp__<name>`, because `--permission-mode dontAsk` would otherwise deny every call. **Verified**: probe started with its env. |
| `codex` | `thread/start` / `thread/resume` `config` | One dotted key per server, `mcp_servers.<name>`, so the user's own `[mcp_servers]` table is extended, not replaced. HTTP uses `url` + `http_headers`. SSE is not supported by Codex and becomes a note. **Verified**: `mcpServer/startupStatus/updated` reported the probe `ready` next to the user's own servers. |
| `opencode` | `OPENCODE_CONFIG_CONTENT` | Loaded after the project config (confirmed in the binary's config loader), so a private server wins a name clash. stdio → `{type:"local", command:[…], environment}`; http/sse → `{type:"remote", url, headers}`. Any inline value already in the child env is merged into, not overwritten. **Verified**: `opencode mcp list` showed the probe `connected`. |
| `junie`, `copilot` | ACP `session/new` / `session/load` `mcpServers` | stdio is mandatory for ACP agents. http/sse are sent only when `initialize` advertised `agentCapabilities.mcpCapabilities.<transport>`; otherwise they are skipped with a note. Copilot advertises both (`.ai/runs/2026-09-27-copilot-cli-runner/copilot-acp-notes.md`). Not verified live (neither CLI was installed); unit-tested against the ACP wire shape. |
| `cursor`, `pi` | none | The Cursor Agent CLI reads MCP only from `.cursor/mcp.json` / `~/.cursor/mcp.json` and has no per-launch flag. pi has no MCP support. A run gets the note `private MCP: <runner> cannot attach <names> — …`, never silence. |

The run manager loads the file **per launch**: the opening step, each workflow step, and every
Continue / auto-resume. An edit therefore applies to the next session without a restart. Each
launch that attaches servers records the note `private MCP servers from .ai/cezar/mcp.local.json: <names>`.

The planner and other one-shot helper calls do not receive private servers. They are not task sessions.

## Precedence

Private servers are **added** to whatever MCP config the agent already loads (user, project,
committed `.mcp.json`). On a name clash the private entry wins where the agent defines an order:
OpenCode (`OPENCODE_CONFIG_CONTENT` loads last) and Codex (CLI-level overrides beat config files).
Claude's behaviour on a duplicate name across `--mcp-config` and `.mcp.json` is the CLI's own;
renaming the private entry avoids the question.

## Cockpit

The file is the catalog entry `cezar.private.mcp` (`src/agent-config/catalog.ts`). It is listed in
the MCP group of every agent that can take it, and uses the existing raw editor, stale-write guard
and hosted-mode write refusal (`PUT /agent-config/:id` 409s without `localHandoff`). That refusal
matters here too: an MCP `command` is code execution. The listing carries `private: true` (contract
`agentConfigFileSchema`), which renders a `private` badge and the effect line "Private to this
project — added to every run at launch … Never committed." An absent file opens on a starter in the
`.mcp.json` shape.

## Security

- The file is readable by the agent process like any file under the repo. That is inherent: the
  agent is handed these servers anyway. It is not world-readable (`0600`), and it is never in argv.
- Writing it is a local-machine capability, gated exactly like every other agent-config write.
- Nothing new is exposed over the network, and no `CEZ_*` flag is added. The feature is inert until
  the user creates the file.

## Tests

- `src/core/private-mcp.test.ts`: parsing and per-entry salvage, every translation (Claude file
  `0600` and kept out of argv, Codex dotted keys + SSE skip, OpenCode merge, ACP capability gating),
  the runner support table, and the catalog write path (`0600`, git-ignored even next to a
  committed `.mcp.json`).
- `src/workflows/private-mcp-launch.test.ts`: the engine puts the servers on the opening and the
  Continue spec, re-reads the file between them, notes unsupported runners, and survives a broken
  file.
