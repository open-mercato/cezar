# Browse ClickUp tasks as an issue tracker

Status: Phase 1 implemented against the docs with mocked responses; Phase 0 still needs a real token. Extends [Browse Jira and Linear tasks](2026-09-18-jira-linear-tracker-browsing.md)
and follows `docs/adding-issue-tracker.md`.

## Decisions

- ClickUp is a third `TrackerKind` behind the existing `TrackerProvider` seam: no new route family,
  screen, persistence file or task composer.
- **Per project.** Each cezar project has its own token (the managed dotenv connection) and its own
  saved scope (`.ai/cezar/tracker.json`). Two projects may use the same workspace or token, but each
  connects separately. No global or environment token.
- **A project connects one Space, Folder or List.** All three are selectable. One association per
  project, as for every provider.
- Phase 1 is read-only and has no automations, so agents never receive the token (the docs mention
  no token scopes, so assume it carries the user's full access).

## Scope model

| Level | `externalId` | Task filter | `externalName` |
| --- | --- | --- | --- |
| Space | `space:<id>` | `space_ids[]` | `Space` |
| Folder | `folder:<id>` | `project_ids[]` | `Space / Folder` |
| List | `list:<id>` | `list_ids[]` | `Space / Folder / List` |

`source.id` is the workspace (team) ID and `source.webUrl` is `https://app.clickup.com/<id>`. Names
and hierarchy are resolved server-side in `resolveAssociation`, never taken from the client.

## Picker

A flat list would cost one or more requests per space (a real workspace has 57; the lowest rate
limit is 100 requests/min per token), so discovery drills down on demand:

- `trackerCandidatesQuerySchema` gains optional `parent`; `trackerCandidateSchema` gains optional
  `hasChildren`. Both stay absent for Jira and Linear, whose pickers do not change.
- No `parent`: spaces (`GET /team/{id}/space`). `parent=space:<id>`: folders and folderless lists.
  `parent=folder:<id>`: that folder's lists.
- Every row can be connected, and rows with `hasChildren` can also be opened.
- `parent` joins the query key and the adapter's cursor scope.
- `q` filters only the level on screen. Those responses are complete rather than first pages, so
  this is not partial filtering, but search does not find a folder from the space level.

## Task reads

- Source: `GET /team/{id}/task`, 100 per page, `subtasks=true`, `order_by=updated`.
- No text search exists, so `searchItems` scans at most 3 vendor pages within 8s and continues
  through the cursor (vendor page + offset). An empty page with `truncated: true` is valid, and the
  list must say the scan can continue rather than "no issues match".
- Search first tries `q` as a task ID, then as a custom ID (`custom_task_ids=true&team_id`).
- `tags[]` is sent and then re-checked locally to keep AND semantics. `active` is enforced locally
  from `status.type` for the same reason.
- `getItem` checks `team_id` and scope membership (`space`, `folder`, `list`, `locations`), and
  always revalidates the vendor.
- `TrackerItem` is unchanged: `id`=`id`, `title`=`name`, `body`=`markdown_description` falling back
  to `text_content`, `labels`=`tags[].name`, `status`=`status.status`, `author`=`creator.username`,
  millisecond dates to ISO. Page order can shift during paging, so the cockpit de-duplicates rows.

## Credentials

`{ kind: 'clickup', token, workspaceId? }`, stored as `CLICKUP_API_TOKEN` and optional
`CLICKUP_WORKSPACE_ID`. With one workspace, it is discovered. With several and no ID, discovery
fails with a reason naming them. Existing Jira and Linear connection files must keep decoding.

## Phase 0: verify with a real token (read-only)

Not settled by the docs:

1. Does the team tasks endpoint return `last_page`? If not, a short page ends the list.
2. Does a folder response embed its lists (the docs show a string array)? If not, opening a folder
   costs one more request.
3. Subfolders appear flat with `parent_folder`. A folder scope shows only tasks directly in it, so a
   subfolder is connected separately. Check that this matches what users expect.
4. `tags[]` AND/OR, and whether `include_closed=false` hides `done` statuses.
5. Do `space_ids[]`, `project_ids[]` and `list_ids[]` include tasks that live in several lists?
6. What status does a task from another workspace return? `transport.ts` maps 401/403 to
   `unauthorized`, which must not read as an outage or a bad token on a direct lookup.
7. Does a 100-task page fit the 8 MB cap this adapter sets (others keep 2 MB)?
8. Do team-task rows really carry `space`, `folder` and `list`? The adapter requires them, so a
   missing field fails loudly as `invalid_response` rather than showing an empty list. Do folder and
   list responses carry `space`, and which direction does `order_by=updated` sort?

## Phase 1 sites that compile but misbehave

Non-exhaustive `jira ? … : linear` branches: `tracker-section.tsx:89`, `connection-env.ts:12,27-33`,
`agent-credentials.ts:24` (returns `{}` for ClickUp in Phase 1), `editor-tracker-fields.tsx:62`.
Settings' "use read-only access" text needs a ClickUp-specific warning.

## Later phases (separate designs)

- **Run link, all providers:** manual launches keep the ticket only as prompt text
  (`tracker-handoff.tsx`). Add an optional `trackerRef` to the run record, then chips both ways.
- **Write-back:** comment with the PR link, move status.
- **Automations:** `issue.opened` first. Requires `workflows/run.ts:1720` (secret redaction),
  `task-template.ts:139`, `webhooks/links.ts:20`, and the hardcoded provider enums in `runs.ts`,
  `store.ts`, `automations/types.ts`, `event-scan.ts`, `webhooks/source.ts`, `event-source.ts`.
