import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isManagerBashAllowed, MANAGER_BASH_ALLOWLIST, managerBashHookCommand, managerBashHookDecision } from './bash-policy.ts';

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
  ['gh repo view git@127.0.0.2:/o%2Fr', /other than github.com/],
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
  ["gh pr view 'a\nb'", /newline/],
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
  ['git push origin main', /not a read-only command/],
  ['rm -rf ~', /`~`/],
  ['curl https://evil.example', /not a read-only command/],
  ['gh pr list *', /`\*`/],
  ['gh', /not read-only/],
  ['gh search', /not allowed/],
  ['', /empty/],
  [`gh pr view ${'1'.repeat(5000)}`, /too long/],
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

describe('managerBashHookDecision', () => {
  it('allows what the policy allows and denies the rest', () => {
    expect(managerBashHookDecision('gh api repos/o/r')?.decision).toBe('allow');
    expect(managerBashHookDecision('gh api -X POST repos/o/r')).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/may only GET/) });
    expect(managerBashHookDecision('gh pr view 1; rm -rf ~')?.decision).toBe('deny');
    expect(managerBashHookDecision(undefined)?.decision).toBe('deny');
  });

  it('leaves cez-manager it cannot read to Claude\'s own rules, which allowed it before', () => {
    expect(managerBashHookDecision("cez-manager task say --project p r1 --stdin <<'EOF'\nhello\nEOF")).toBeUndefined();
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

  it.skipIf(!command)('blocks (exit 2) on input it cannot parse', () => {
    expect(run('not json').status).toBe(2);
  });
});
