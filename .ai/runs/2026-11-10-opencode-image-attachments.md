# Execution plan: OpenCode images in the chat (#1896)

Source doc: https://github.com/open-mercato/cezar/issues/1896

## Goal

An image an OpenCode run reads (`read` on a PNG) shows in the cockpit chat, as it already does for Claude/Copilot.

## Scope

- `opencode-server-runner.ts`: emit the v1 `{ type: 'image' }` (what `workflows/run.ts` persists and the chat renders) once per completed tool part carrying `state.attachments` data-URL images.
- `opencode-ui-mapper.ts`: emit the v2 `image` UiEvent (`itemId` = the tool item) when the part first settles completed — backend parity with `claude-ui-mapper`.
- One shared parser for the attachments, a golden fixture, a runner test through the mock server.

## Non-goals

- Non-image attachments, `file://` URLs, the OpenCode 2.x event adapter, the cockpit renderer.

## Risks

- Repeated completed snapshots of one part → duplicate images. Guarded on both streams.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix

- [ ] 1.1 Emit image events from the OpenCode mapper and runner, with golden fixture and runner tests
- [ ] 1.2 Run the validation gate
