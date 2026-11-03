# Issue #894 UI QA evidence

## Result

⚠️ Not passed in a live browser. A retry used staged user-space libraries and a healthy QA app,
but Chrome exited before launch because the task TMP path made `SingletonSocket` too long. No live
UI result is claimed.

## Automated evidence

- Focused catalog/model/path/descriptor/Agent Config tests: 48 passed.
- The new Agent Config test covers the Pi tab, absent global settings file, shared `AGENTS.md`,
  Settings and Memory groups.
- Existing hosted read-only Agent Config coverage remains green in the focused suite.

## Follow-up browser scenario

1. Open Settings → Agent Config on a local cockpit.
2. Select the Pi tab and verify Settings contains `~/.pi/agent/settings.json` (or the resolved
   `PI_CODING_AGENT_DIR/settings.json`) and `.pi/settings.json`, including an `absent` marker when
   files do not exist.
3. Verify Memory & instructions contains the Pi-owned global `AGENTS.md` and shared project
   `AGENTS.md`; verify no auth/models/MCP files appear.
4. Repeat in hosted mode and verify the read-only banner and no Save action.
