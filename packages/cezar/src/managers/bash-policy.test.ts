import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  isManagerBashAllowed,
  MANAGER_BASH_ALLOWLIST,
  MANAGER_BASH_DENIED,
  MANAGER_BASH_FILTERS,
  MANAGER_TEXT_IN_FILES,
  managerBashHookCommand,
  managerBashHookDecision,
  managerBashPatternIssue,
  managerBashPromptSection,
  managerBashSuggestion,
  managerShellPlan,
} from './bash-policy.ts';

const ALLOWED = [
  'cez-manager tasks --json',
  'cez-manager task create --project p1 --workflow review-pr "Review PR 12"',
  'gh pr view 12',
  'gh pr view 12 --json title,body,files --jq .title',
  'gh pr list --state open --search "is:draft review:required"',
  'gh pr diff 12 --name-only',
  'gh pr checks 12',
  'gh issue view 7 -R owner/repo --comments',
  'gh pr list --repo=owner/repo -q ".[].number" --json number',
  'gh pr view https://github.com/owner/repo/pull/12',
  'gh pr view feature/a/b',
  'gh issue list --label bug --limit 20',
  'gh run view 123 --log-failed',
  'gh run list --branch main',
  'gh repo view owner/repo',
  'gh search prs "is:open author:me" --json number,title',
  'gh search issues cezar --limit 5',
  'gh search code "manager" --repo open-mercato/cezar',
  'gh api repos/owner/repo/pulls/12',
  "gh api 'repos/owner/repo/pulls?state=open&per_page=50' --paginate",
  "gh api 'repos/{owner}/{repo}/issues' -X GET",
  'gh api repos/owner/repo/issues --method GET',
  'gh api repos/owner/repo/issues --method=get',
  'gh api repos/owner/repo/issues -XGET',
  'gh api /repos/owner/repo/commits -H "Accept: application/vnd.github+json" --jq ".[].sha"',
  'gh pr list --json number,title | jq -r ".[] | .title"',
  "gh pr list --json number | jq '.[] | .number' | head -n 5",
  "gh api repos/o/r/pulls | jq --arg n 12 '.[] | select(.number == ($n | tonumber))'",
  'gh pr diff 12 | grep -n "TODO"',
  'gh pr diff 12 | grep -c -e "^+" | wc -l',
  'gh issue list | grep -iv wontfix | head -20',
  'gh pr list | wc -l',
  'gh pr diff 12 | head -c 4000',
  'cez-manager tasks --json | jq length',
  // The 2026-11-13 handover's denials (acceptance).
  'gh api user --jq .login',
  'gh api user',
  'gh api repos/shopware/shopware/pulls/comments/1234567',
  'gh search prs --repo shopware/shopware --involves patzick --state open',
  "gh pr view 2875 --json files --jq '.files[].path' | grep -E 'src/.*\\.ts$'",
  `gh pr view 2875 --json headRepository,statusCheckRollup --jq '.statusCheckRollup[] | select(.conclusion == "FAILURE") | .name // "?"'`,
  `gh pr view 1 --json title --jq '.title | test("fix"; "i")'`,
  'gh pr status',
  'gh release list --limit 5',
  'gh release view v1.2.0 --json tagName',
  'gh pr list --json number,author | jq -r ".[].author.login" | sort | uniq -c | sort -rn | head -n 3',
  'gh pr diff 12 | tail -n 20',
  'gh pr diff 12 | tail -n +5',
  'gh pr list | cut -f1,3 -d " "',
  'gh pr list | cut -f1',
  'gh pr list | sort -k2,2 -t ,',
  // Quoted newlines are literal; a quoted-delimiter heredoc expands nothing.
  "gh pr view 'a\nb'",
  'cez-manager task create --project p1 --dispatch "Line one.\n\nLine two, with \\"quotes\\"."',
  "cez-manager task say --project p r1 --stdin <<'EOF'\nhello `whoami` $(rm -rf ~)\nEOF",
  'cez-manager task create --project p --stdin <<"EOF"\nbody\nEOF\n',
];

const REFUSED: Array<[string, RegExp]> = [
  ['gh pr merge 12', /not read-only/],
  ['gh pr merge 12 --squash --auto', /not read-only/],
  ['gh pr review 12 --approve', /not read-only/],
  ['gh pr comment 12 -b hi', /not read-only/],
  ['gh pr close 12', /not read-only/],
  ['gh issue create -t x -b y', /not read-only/],
  ['gh repo delete owner/repo --yes', /not read-only/],
  ['gh workflow run deploy.yml', /not read-only/],
  ['gh pr edit 12 --title x', /not read-only/],
  ['gh pr ready 12', /not read-only/],
  ['gh issue comment 7 -b hi', /not read-only/],
  ['gh issue edit 7 --add-label x', /not read-only/],
  ['gh issue close 7', /not read-only/],
  ['gh run rerun 123', /not read-only/],
  ['gh release create v1', /not read-only/],
  ['gh release delete v1', /not read-only/],
  ['gh pr view 12 --web', /browser/],
  ['gh pr view 12 -cw', /browser/],
  ['gh search prs cezar -w', /browser/],
  ['gh pr view 1 -w=true', /browser/],
  ['gh pr view 1 -cw=1', /browser/],
  ["gh pr list --json number --jq '$ENV.GH_TOKEN'", /environment/],
  ['gh pr view 1 --jq env', /environment/],
  ['gh pr view 1 -q=env', /separate flags/],
  ['gh pr view 1 -R exfil.invalid/o/r', /OWNER\/REPO/],
  ['gh pr view 1 --repo=exfil.invalid/o/r', /OWNER\/REPO/],
  ['gh pr view 1 -Rexfil.invalid/o/r', /separate flags/],
  ['gh pr view 1 -cR exfil.invalid/o/r', /separate flags/],
  ['gh pr view 1 -R', /needs a value/],
  ['gh pr view https://localhost:1/o/r/pull/1', /other than github.com/],
  ['gh pr view http://github.com.evil.invalid/o/r/pull/1', /other than github.com/],
  ['gh issue view https://example.invalid/o/r/issues/1', /other than github.com/],
  ['gh repo view localhost:1/o/r', /other than github.com/],
  ['gh repo view localhost/o/r', /other than github.com/],
  ['gh repo view example.invalid/o', /other than github.com/],
  ['gh repo view git@evil.invalid:o/r', /other than github.com/],
  ["gh pr list --search --jq --jq '$ENV.X' --json number", /needs a value/],
  ['gh pr list --search -q --web', /needs a value/],
  ['gh issue list --search -q --web', /needs a value/],
  ['gh pr list --search -q --repo localhost/o/r', /needs a value/],
  ['gh pr list --search -R --repo=localhost/o/r', /needs a value/],
  ['gh repo view git@127.0.0.2:/o%2Fr', /other than github.com/],
  ["gh pr view 'https://evil.invalid/o/r/pull/1 x'", /other than github.com/],
  // gh's HOST/OWNER/REPO split takes these characters after the host (#2222).
  ["gh repo view 'evil.invalid/o/r )'", /other than github.com/],
  ["gh repo view 'git@evil.invalid:o/r)'", /other than github.com/],
  ["gh repo view 'localhost/o/r x'", /other than github.com/],
  ["gh repo view '[::1]/o/r'", /other than github.com/],
  ["gh repo view 'git@evil.invalid:o)/r'", /other than github.com/],
  ["gh repo view 'git@evil.invalid:o x/r'", /other than github.com/],
  ["gh pr view 'evil.invalid/o/r/pull/1 '", /other than github.com/],
  ['gh api -X POST repos/o/r/issues', /may only GET/],
  ['gh api repos/o/r/issues -XPOST', /may only GET/],
  ['gh api --method PATCH repos/o/r/pulls/1', /may only GET/],
  ['gh api --method=DELETE repos/o/r/git/refs/heads/x', /may only GET/],
  ['gh api repos/o/r/issues -f title=x', /not allowed/],
  ['gh api repos/o/r/issues -F title=x', /not allowed/],
  ['gh api repos/o/r/issues --field title=x', /not allowed/],
  ['gh api repos/o/r/issues --raw-field title=x', /not allowed/],
  ['gh api repos/o/r/issues --input body.json', /not allowed/],
  ['gh api repos/o/r/issues -X GET -f title=x', /not allowed/],
  ["gh api graphql -f query='mutation { addStar(input: {}) { clientMutationId } }'", /not allowed/],
  ['gh api graphql', /POST/],
  ['gh api repos/o/r --hostname evil.example', /not allowed/],
  ['gh api https://evil.example/x', /plain API path/],
  ['gh api repos/o/r -H "X-HTTP-Method-Override: DELETE"', /header/],
  ['gh api repos/o/r --jq env', /environment/],
  ['gh api repos/o/r repos/o/s', /one endpoint/],
  ['gh pr view 1; rm -rf ~', /`;`/],
  ['gh pr view 1 && gh pr merge 1', /`&`/],
  ['gh pr view 1 || gh pr merge 1', /`\|\|`/],
  ['gh pr view 1 & gh pr merge 1', /`&`/],
  ['gh pr view $(cat x)', /`\$`/],
  ['gh pr view "$(cat x)"', /expansion/],
  ['gh pr view `cat x`', /`/],
  ['gh pr view "`cat x`"', /expansion/],
  ['gh pr view $PR', /`\$`/],
  ['gh pr list | sh', /cannot read from a pipe/],
  ['gh pr list | bash -c "gh pr merge 1"', /cannot read from a pipe/],
  ['gh pr list | xargs -n1 gh pr merge', /cannot read from a pipe/],
  ['gh pr list | tee out.txt', /cannot read from a pipe/],
  ['gh pr list > out', /`>`/],
  ['gh pr list >> out', /`>`/],
  ['gh pr list 2>/dev/null', /`>`/],
  ['gh pr list < in', /`<`/],
  ['(gh pr merge 1)', /`\(`/],
  ['{ gh pr merge 1; }', /`\{`/],
  ['gh pr view 1\ngh pr merge 1', /newline/],
  ['gh pr view 1\rgh pr merge 1', /newline/],
  ['gh pr view "a\n$(rm x)"', /expansion/],
  ["cez-manager tasks <<'EOF'\nx\nEOF\nrm -rf ~", /after a heredoc/],
  ["cez-manager tasks <<'EOF'\nx", /unterminated heredoc/],
  ["gh pr merge 1 <<'EOF'\nx\nEOF", /lone `cez-manager`/],
  ["cez-manager tasks | jq . <<'EOF'\nx\nEOF", /lone `cez-manager`/],
  ['cez-manager tasks <<EOF\nx\nEOF', /`<`/],
  ['gh pr list | tail -f', /not allowed/],
  ['gh pr list | tail /etc/passwd', /not allowed/],
  ['gh pr list | sort -o out', /no files/],
  ['gh pr list | sort /etc/passwd', /no files/],
  ['gh pr list | sort --compress-program=sh', /no files/],
  ['gh pr list | uniq in out', /no files/],
  ['gh pr list | cut -f1 /etc/passwd', /no files/],
  ['gh pr view 1 |', /empty pipe/],
  ['| gh pr view 1', /empty pipe/],
  ['gh pr view "1', /unterminated/],
  ['gh pr view \\; rm x', /`\\`/],
  ['gh pr list | jq env', /environment/],
  ['gh pr list | jq -n .', /not allowed/],
  ['gh pr list | jq "$ENV"', /expansion/],
  ["gh pr list | jq '$ENV.GITHUB_TOKEN'", /environment/],
  ["gh pr list | jq 'input_filename'", /environment or files/],
  ["gh pr list | jq 'import \"x\" as x; .'", /environment or files/],
  ['gh pr list | jq --rawfile k /etc/passwd .', /not allowed/],
  ['gh pr list | jq -f prog.jq', /not allowed/],
  ['gh pr list | jq . /etc/passwd', /only the pipe/],
  ['gh pr list | grep x /etc/passwd', /only the pipe/],
  ['gh pr list | grep -r x', /not allowed/],
  ['gh pr list | grep -f patterns', /not allowed/],
  ['gh pr list | head /etc/passwd', /not allowed/],
  ['gh pr list | wc /etc/passwd', /only -l/],
  ['GH_HOST=evil gh pr view 1', /not a read-only command/],
  ['env gh pr merge 1', /not a read-only command/],
  ['git push origin main', /not read-only/],
  ['git status', /not a read-only command/],
  ['rm -rf ~', /`~`/],
  ['curl https://evil.example', /not a read-only command/],
  ['gh pr list *', /`\*`/],
  ['gh', /not read-only/],
  ['gh search', /not allowed/],
  ['', /empty/],
  [`gh pr view ${'1'.repeat(13_000)}`, /too long/],
];

describe('isManagerBashAllowed', () => {
  it.each(ALLOWED)('allows %s', (command) => {
    expect(isManagerBashAllowed(command)).toEqual({ ok: true });
  });

  it.each(REFUSED)('refuses %j', (command, reason) => {
    const verdict = isManagerBashAllowed(command);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(reason);
  });

  it('every prefix rule in the fallback floor is a command the policy allows', () => {
    for (const prefix of MANAGER_BASH_ALLOWLIST) {
      expect(isManagerBashAllowed(`${prefix} 1`), prefix).toEqual({ ok: true });
    }
    // The floor must hold when the hook cannot run: no `gh api`, no bare `gh`, no filters.
    expect(MANAGER_BASH_ALLOWLIST.some((prefix) => /^(gh|gh api|git|jq|grep|head|wc)$/.test(prefix))).toBe(false);
  });
});

describe('the handover acceptance', () => {
  it('a 2 KB multi-line --dispatch objective passes the hook outright', () => {
    const objective = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: fix the "thing", in src/a-${i}.ts, then test.`).join('\n\n');
    expect(objective.length).toBeGreaterThan(2_000);
    expect(managerBashHookDecision(`cez-manager task create --project p1 --title "Fix" --dispatch '${objective}'`)?.decision).toBe('allow');
    expect(managerBashHookDecision(`cez-manager task create --project p1 --dispatch "${objective.replace(/"/g, '\\"')}"`)?.decision).toBe('allow');
    expect(managerBashHookDecision(`cez-manager task create --project p1 --dispatch --stdin <<'EOF'\n${objective} with \`code\` and $HOME\nEOF`)?.decision).toBe('allow');
  });

  it('every explicitly denied write is denied, flags and all', () => {
    for (const prefix of MANAGER_BASH_DENIED) {
      expect(managerBashHookDecision(`${prefix} 1 --yes`)?.decision, prefix).toBe('deny');
      expect(managerBashHookDecision(`${prefix} 1`, [prefix])?.decision, `${prefix} user-allowed`).toBe('deny');
    }
    expect(managerBashHookDecision('gh api -X POST repos/o/r/issues')?.decision).toBe('deny');
  });
});

describe('user-allowed patterns', () => {
  it('accept only gh <group> <read verb>, never a write, a credential or a built-in', () => {
    expect(managerBashPatternIssue('gh label list')).toBeUndefined();
    expect(managerBashPatternIssue('gh workflow view')).toBeUndefined();
    expect(managerBashPatternIssue('gh label create')).toMatch(/read-only verb/);
    expect(managerBashPatternIssue('gh pr merge')).toMatch(/read-only verb/);
    expect(managerBashPatternIssue('gh auth status')).toMatch(/cannot be allowed/);
    expect(managerBashPatternIssue('gh secret list')).toMatch(/cannot be allowed/);
    expect(managerBashPatternIssue('gh api user')).toMatch(/cannot be allowed/);
    // An extension or a `!` alias is any program, whatever its verb.
    expect(managerBashPatternIssue('gh my-ext list')).toMatch(/cannot be allowed/);
    expect(managerBashSuggestion('gh my-ext list')).toBeUndefined();
    // A built-in read keeps its stricter checks; as a user pattern it would skip them.
    expect(managerBashPatternIssue('gh repo view')).toMatch(/already allowed/);
    expect(isManagerBashAllowed('gh repo view localhost/o/r', ['gh repo view']).ok).toBe(false);
    expect(isManagerBashAllowed('gh repo view git@evil.invalid:o/r', ['gh repo view']).ok).toBe(false);
    expect(managerBashPatternIssue('git log')).toMatch(/only a/);
    expect(managerBashPatternIssue('gh label')).toMatch(/only a/);
    expect(managerBashPatternIssue('gh label list; rm')).toMatch(/only a/);
  });

  it('allow the pattern with the built-in reads\' flag and host checks', () => {
    expect(isManagerBashAllowed('gh label list --repo o/r').ok).toBe(false);
    expect(isManagerBashAllowed('gh label list --repo o/r', ['gh label list'])).toEqual({ ok: true });
    expect(isManagerBashAllowed('gh label list | grep bug', ['gh label list'])).toEqual({ ok: true });
    expect(isManagerBashAllowed('gh label list --web', ['gh label list']).ok).toBe(false);
    expect(isManagerBashAllowed('gh label list -R evil.invalid/o/r', ['gh label list']).ok).toBe(false);
    expect(isManagerBashAllowed('gh label list; rm -rf ~', ['gh label list']).ok).toBe(false);
    expect(isManagerBashAllowed('gh label create x', ['gh label list']).ok).toBe(false);
    // An unvetted pattern smuggled into the list does nothing.
    expect(isManagerBashAllowed('gh label create x', ['gh label create']).ok).toBe(false);
  });

  it('suggest a pattern only for a refused command the user may allow', () => {
    expect(managerBashSuggestion('gh label list --limit 5 | head')).toBe('gh label list');
    expect(managerBashSuggestion('gh pr view 1')).toBeUndefined();
    expect(managerBashSuggestion('gh pr merge 1')).toBeUndefined();
    expect(managerBashSuggestion('rm -rf ~')).toBeUndefined();
    expect(managerBashSuggestion('gh label list; rm')).toBeUndefined();
  });
});

describe('managerBashPromptSection', () => {
  const section = managerBashPromptSection();
  it('names every built-in read, filter and denial, and nothing it would refuse', () => {
    for (const prefix of MANAGER_BASH_ALLOWLIST) {
      const [program, group, verb] = prefix.split(' ');
      if (program === 'cez-manager') continue;
      expect(section, prefix).toMatch(new RegExp(`gh ${group} [a-z|]*\\b${verb}\\b`));
    }
    for (const filter of MANAGER_BASH_FILTERS) expect(section).toContain(filter);
    for (const denied of MANAGER_BASH_DENIED) expect(section).toContain(denied);
    // Each read line it lists is a command the policy allows.
    for (const line of section.split('\n').filter((text) => /^ {2}gh (?!api)/.test(text))) {
      for (const form of line.trim().split(', ')) {
        const [, group, verbs] = form.split(' ');
        for (const verb of verbs!.split('|')) expect(isManagerBashAllowed(`gh ${group} ${verb} 1`), `gh ${group} ${verb}`).toEqual({ ok: true });
      }
    }
  });

  it('lists the user\'s patterns, and only vetted ones', () => {
    const own = managerBashPromptSection(['gh label list', 'gh label create']);
    expect(own).toContain('gh label list    (the user allowed these)');
    expect(own).not.toContain('gh label create');
  });

  // #2258: Claude's sandbox lets only a plain cez-manager call out, so a Claude manager files text.
  it('sends a Claude manager\'s text through --file, and keeps the heredoc elsewhere', () => {
    expect(section).toContain("--stdin <<'EOF'");
    expect(section).not.toContain(MANAGER_TEXT_IN_FILES);
    const files = managerBashPromptSection([], { textInFiles: true });
    expect(files).toContain(MANAGER_TEXT_IN_FILES);
    expect(files).not.toContain('<<');
  });
});

describe('managerBashHookDecision', () => {
  it('allows what the policy allows and denies the rest', () => {
    expect(managerBashHookDecision('gh api repos/o/r')?.decision).toBe('allow');
    expect(managerBashHookDecision('gh api -X POST repos/o/r')).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/may only GET/) });
    expect(managerBashHookDecision('gh pr view 1; rm -rf ~')?.decision).toBe('deny');
    expect(managerBashHookDecision(undefined)?.decision).toBe('deny');
    expect(managerBashHookDecision('gh label list')?.decision).toBe('deny');
    expect(managerBashHookDecision('gh label list', ['gh label list'])?.decision).toBe('allow');
  });

  it('leaves cez-manager it cannot read to Claude\'s own rules, which allowed it before', () => {
    expect(managerBashHookDecision('cez-manager task say --project p r1 --stdin <<EOF\nhello $USER\nEOF')).toBeUndefined();
    expect(managerBashHookDecision('cez-manager tasks | sh')).toBeUndefined();
    expect(managerBashHookDecision('cez-managerx; rm -rf ~')?.decision).toBe('deny');
  });
});

describe('the hook entrypoint', () => {
  const command = managerBashHookCommand();
  const run = (input: string) => spawnSync('/bin/sh', ['-c', command!], { input, encoding: 'utf8', timeout: 30_000 });

  it.skipIf(!command)('answers Claude\'s PreToolUse JSON', () => {
    const allow = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh api repos/o/r' } }));
    expect(allow.status).toBe(0);
    expect(JSON.parse(allow.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    const deny = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } }));
    expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it.skipIf(!command)('reads the user\'s patterns from its environment', () => {
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh label list' } });
    const env = { ...process.env, CEZ_MANAGER_BASH_ALLOW: JSON.stringify(['gh label list']) };
    const allowed = spawnSync('/bin/sh', ['-c', command!], { input, encoding: 'utf8', timeout: 30_000, env });
    expect(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
    expect(JSON.parse(run(input).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it.skipIf(!command)('blocks (exit 2) on input it cannot parse', () => {
    expect(run('not json').status).toBe(2);
  });
});

describe('managerShellPlan (the Codex manager fence)', () => {
  it('returns the argv pipeline the policy read', () => {
    expect(managerShellPlan('gh pr view 12 --json title | jq -r .title')).toEqual({ ok: true, pipeline: [['gh', 'pr', 'view', '12', '--json', 'title'], ['jq', '-r', '.title']] });
    expect(managerShellPlan('cez-manager task create --project p1 "Fix the login"')).toEqual({ ok: true, pipeline: [['cez-manager', 'task', 'create', '--project', 'p1', 'Fix the login']] });
  });
  it('passes a heredoc body as stdin, never to a shell', () => {
    expect(managerShellPlan("cez-manager task create --project p1 --stdin <<'EOF'\nline one $HOME\n`two`\nEOF")).toEqual({
      ok: true, pipeline: [['cez-manager', 'task', 'create', '--project', 'p1', '--stdin']], stdin: 'line one $HOME\n`two`\n',
    });
  });
  it.each(['gh pr merge 12', 'git push', 'cez-manager tasks; rm -rf /', 'gh pr view 12 > out', 'gh pr view $(id)', 'rm -rf /', 'gh pr view 12 | sh', 'gh api repos/o/r -X POST'])('refuses %s', (command) => {
    expect(managerShellPlan(command)).toMatchObject({ ok: false });
  });
  it('agrees with isManagerBashAllowed on every allowed command', () => {
    for (const command of ALLOWED) expect(managerShellPlan(command).ok).toBe(isManagerBashAllowed(command).ok);
  });
  it('honours the user-allowed patterns', () => {
    expect(managerShellPlan('gh label list').ok).toBe(false);
    expect(managerShellPlan('gh label list', ['gh label list'])).toMatchObject({ ok: true, pipeline: [['gh', 'label', 'list']] });
  });
});
