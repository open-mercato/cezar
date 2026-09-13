/**
 * What a task is told about GitHub automations, and the playbook the built-in
 * `create-cezar-automation` skill runs under (spec `.ai/specs/2026-09-13-automations-from-prompt.md`).
 *
 * Two texts, one mechanism. `AUTOMATIONS_PROMPT` is the SHORT part composed into every task's
 * system prompt while automations are on and reachable — enough for an agent to recognise "do X
 * whenever Y happens on GitHub" as an automation rather than a one-off, and to know the CLI that
 * creates one. `CREATE_AUTOMATION_SKILL_BODY` is the full playbook: it goes into the run only when
 * the user picks the skill (or the agent, having read the short part, runs `cez automation schema`
 * to get the same reference). Neither is composed when the cockpit cannot serve the routes — an
 * agent told about a CLI whose every call is refused reads the refusal as an instruction (the
 * dispatch lesson, spec 2026-09-10-dispatch A2/A8).
 *
 * The CLI contract below is the ONLY place an agent learns the `cez automation` commands, so it
 * restates the definition keys of `automationDefinitionSchema` (`./types.ts`) one for one.
 */

export const CREATE_AUTOMATION_SKILL_NAME = 'create-cezar-automation';

/**
 * The definition reference, as `cez automation schema` prints it and as the skill body embeds
 * it. Kept as one string so the two can never disagree about a key or a bound.
 */
export const AUTOMATION_SCHEMA_REFERENCE = `An automation definition is one JSON object:

{
  "name": "Review every new pull request",          // required, 1-200 chars
  "description": "What this automation is for",      // optional, up to 2000 chars
  "events": ["pull_request.opened"],                 // 1-4 of: pull_request.opened, issue.opened, issue.labeled, issue.unlabeled
  "intervalSeconds": 300,                            // required: how often GitHub is polled, in seconds, 60-86400 (300 is the usual choice)
  "filters": {                                       // required, may be {}; every key optional; a candidate must pass ALL given filters
    "authors": ["octocat"],                          //   GitHub logins that opened it
    "assignees": ["octocat"],                        //   current assignees
    "allLabels": ["bug"],                            //   must carry every one of these labels
    "anyLabels": ["bug", "regression"],              //   must carry at least one of these
    "excludeLabels": ["wontfix"],                    //   must carry none of these
    "changedLabels": ["needs-agent"],                //   REQUIRED for issue.labeled / issue.unlabeled: the label whose change fires it
    "lookbackDays": 7,                               //   1-90 (default 7): how far back one poll looks
    "maxRecords": 25                                 //   1-100 (default 25): the most candidates one poll considers
  },
  "task": {                                          // the ordinary cezar task each match launches
    "prompt": "Review pull request #{{github.number}} ({{github.title}}) at {{github.url}}: read the diff, run the tests, and post your findings as a review.",
    "workflow": "quick-task",                        // a workflow name — OR inline "steps", never both
    "steps": [{ "id": "task", "skill": "om-auto-review-pr", "prompt": "{{task}}" }],  // to run a skill: one agent step naming it
    "runner": "claude",                              // optional: claude | codex | opencode | pi
    "model": "sonnet",                               // optional
    "variants": 1,                                   // 1 | 2 | 3 competing runs per match
    "worktree": true,                                // isolate each run in its own git worktree (recommended)
    "autonomous": true,                              // never park to ask — an automation has no one watching (recommended)
    "generateFollowups": false,
    "systemPrompt": "Extra guidance for every launched run"  // optional
  }
}

name, events, intervalSeconds, filters and task are required; no other top-level key is accepted.

Prompt placeholders, substituted per match: {{github.kind}} (issue | pull request), {{github.number}}, {{github.title}}, {{github.url}}, {{github.author}}, {{github.assignees}}, {{github.labels}} and {{github.event}}. Any other {{…}} is rejected. The matched item's title, author, labels and URL are also appended to every launched task as untrusted context, so the prompt need not repeat them.

A new automation is PAUSED unless created with --enable. Enabling establishes a current-time baseline: only pull requests and issues that appear AFTER it are ever launched, never the backlog. Editing a definition never re-considers what an earlier revision already saw.`;

/** The part composed into EVERY task's system prompt while automations are on and reachable. */
export const AUTOMATIONS_PROMPT = `GitHub automations. This cockpit can watch this repository's GitHub for you: an automation is a bounded poll — a new pull request, a new issue, a label added to or removed from an issue, optionally filtered by author, assignee or labels — that launches an ordinary cezar task for every match, with a prompt template you write. When the user asks for something to happen "whenever", "every time" or "each time" a pull request or issue appears or is labelled, they are asking for an automation: create one instead of doing the work once, and instead of polling GitHub yourself.

Always through the cockpit's own binary, node "$CEZ_BIN", because a cez on your PATH may be an older install without this command; every "cez automation …" below means node "$CEZ_BIN" automation …:

  cez automation schema                              the definition shape, every key, every bound, the prompt placeholders
  cez automation create --file <def.json> [--enable]  create one (paused unless --enable); --json '<json>' or stdin work too
  cez automation check <id> [--execute]              preview what the filter matches right now (launches nothing without --execute)
  cez automation list | show <id> | update <id> --file <def.json> | enable <id> | pause <id> | delete <id>

Write the definition to a file and read cez automation schema first. Create it PAUSED and run a preview check so the user can see what it would have matched, unless they explicitly asked for it to be enabled; only enable when the user asked, and say so. Never enable an automation whose filter you have not previewed. The command prints the automation's id and its page in the cockpit — put that link in your final message. If cez automation is refused or CEZ_BIN is unset, stop and report that automations are unavailable on this cockpit: do not write a cron job, a GitHub Action or a polling script in the repository as a substitute.`;

/**
 * The built-in skill's body — the full playbook a run under `create-cezar-automation` follows.
 * The user picks it in the composer (or `/create-cezar-automation`); a prompt template assigned
 * to it pre-fills the box with the two questions every automation needs answered.
 */
export const CREATE_AUTOMATION_SKILL_BODY = `# Create a cezar automation

You turn the user's request into a GitHub automation on this cockpit: a bounded poll of this repository's pull requests or issues that launches an ordinary cezar task for every match. You do NOT do the recurring work yourself, and you do not add cron jobs, GitHub Actions, webhooks or polling scripts to the repository — the cockpit already polls.

## 1. Understand the request

Every automation answers two questions. Find both in the user's message before writing anything:

- **Trigger** — which event: a new pull request (\`pull_request.opened\`), a new issue (\`issue.opened\`), a label added to an issue (\`issue.labeled\`) or removed from one (\`issue.unlabeled\`); and which filters narrow it — authors, assignees, labels it must or must not carry. A label event needs the label whose change fires it (\`filters.changedLabels\`).
- **Task** — what the launched task must do for each match, as a prompt template. Write it the way you would brief a colleague who sees only that text plus the item's number, title, URL, author and labels: the goal, the checks to run, how to finish (a review comment, a draft PR, a report). Use \`{{github.number}}\`, \`{{github.title}}\`, \`{{github.url}}\` and the other placeholders \`cez automation schema\` lists.

If the user named a skill, workflow, runner or model for the launched tasks, use it (a skill is one inline step: \`"steps": [{ "id": "task", "skill": "<name>", "prompt": "{{task}}" }]\`). Otherwise leave those keys out so the cockpit's defaults apply. Default \`"worktree": true\` and \`"autonomous": true\` — an automation runs unattended, so a task that parks to ask a question waits forever. Pick an interval that matches how urgent a match is (300 seconds is the default; an hourly triage needs 3600). If the request leaves the trigger or the task genuinely open, ask one precise question and stop; do not guess a filter that could launch tasks on the wrong items.

## 2. Create it

Run \`node "$CEZ_BIN" automation schema\` and read it. Write the definition as JSON to a file outside the repository (your temp directory is fine) and create it:

    node "$CEZ_BIN" automation create --file <def.json>

The automation is created PAUSED. The command prints its id and the cockpit page where the user can edit it. If the user explicitly asked for it to be switched on, add \`--enable\`; otherwise leave it paused and say how to enable it. If the command is refused, stop and report exactly what it printed — do not work around it.

## 3. Preview before anyone enables it

    node "$CEZ_BIN" automation check <id>

This runs the filter against GitHub right now and counts the matches without launching anything. Report the count. Zero matches on a filter that should match something means a wrong label, author or event — fix the definition (\`cez automation update <id> --file <def.json>\`) and preview again. Enabling establishes a current-time baseline, so a preview is the only way to see what the filter does to existing items.

## 4. Finish

Your final message names the automation, its id, the cockpit link the create command printed, whether it is paused or enabled, what the preview matched, and the exact prompt template it will launch. Keep the definition file you wrote out of the repository.

## Reference

${AUTOMATION_SCHEMA_REFERENCE}`;
