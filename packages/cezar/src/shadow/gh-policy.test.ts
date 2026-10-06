import { describe, expect, it } from 'vitest';
import { classifyGh, ghFileReferences, ghTargetRepo } from './gh-policy.ts';

/**
 * The gh policy is the whole of shadow mode's forge boundary, so it is pinned row by row. The
 * cases that matter most are the ones that must NOT pass through: a write that looks like help, a
 * raw API call with fields, a GraphQL mutation, an approval, a credential read.
 */
describe('classifyGh', () => {
  const verdict = (line: string) => classifyGh(line.split(' ').filter(Boolean));

  it.each([
    'pr list',
    'pr view 12 --json title',
    'pr diff 12',
    'pr checks 12',
    'pr checkout 12',
    'co 12',
    'issue view 3 --comments',
    'issue list --label bug',
    'repo view open-mercato/cezar',
    'run view 99 --log-failed',
    'search prs is:open',
    'status',
    'auth status',
    'api repos/o/r/pulls',
    'api repos/o/r/pulls --paginate --jq .[].number',
    'api -X GET search/issues -f q=bug', // an explicit GET with fields stays a read
    'release download v1.0.0',
    'workflow list',
    '--version',
    'pr create --help',
    'help pr',
  ])('reads pass through: gh %s', (line) => {
    expect(verdict(line).effect).toBe('read');
  });

  it.each([
    ['pr create --title Fix --body x', 'pr create'],
    ['pr comment 12 --body done', 'pr comment'],
    ['pr edit 12 --add-label ready', 'pr edit'],
    ['pr ready 12', 'pr ready'],
    ['pr review 12 --comment --body nit', 'pr review'],
    ['issue create --title Bug', 'issue create'],
    ['issue comment 3 --body ack', 'issue comment'],
    ['issue close 3', 'issue close'],
  ])('reversible writes are click-promotable: gh %s', (line, command) => {
    expect(verdict(line)).toMatchObject({ effect: 'write', promotable: 'click', command });
  });

  it.each([
    'pr merge 12 --squash',
    'pr review 12 --approve',
    'pr review 12 -a',
    'pr update-branch 12',
    'issue delete 3',
    'issue comment 3 --delete-last',
    'api repos/o/r/issues -f title=x', // fields without -X default to POST
    'api -X DELETE repos/o/r',
    'api --method=PATCH repos/o/r -f name=y',
    'api -XPOST repos/o/r/hooks',
    'api repos/o/r/contents/x --input body.json',
    'release create v1.0.0',
    'repo fork',
    'repo create my-new-repo --public',
    'repo edit --visibility public',
    'workflow run deploy.yml',
    'run rerun 99',
    'label create urgent',
    'variable set FOO',
    'copilot suggest', // an extension or a future command: fail closed
  ])('irreversible or governance writes are manual only: gh %s', (line) => {
    expect(verdict(line)).toMatchObject({ effect: 'write', promotable: 'manual' });
  });

  it.each([
    'auth token',
    'auth login --with-token',
    'auth status --show-token',
    'auth setup-git',
    'secret set NPM_TOKEN --body x',
    'extension install owner/gh-ext',
    'alias set pv pr-view',
    'config set editor vim',
    'ssh-key add key.pub',
  ])('credential and setup changes are denied: gh %s', (line) => {
    expect(verdict(line)).toMatchObject({ effect: 'deny', promotable: 'never' });
  });

  it('reads a GraphQL query as a read and a mutation as a manual write', () => {
    expect(classifyGh(['api', 'graphql', '-f', 'query=query { viewer { login } }']).effect).toBe('read');
    expect(classifyGh(['api', 'graphql', '-f', 'query=mutation { addStar(input: {}) { clientMutationId } }'])).toMatchObject({
      effect: 'write',
      promotable: 'manual',
    });
  });

  it('fails closed on GraphQL it cannot read: a query from a file', () => {
    expect(classifyGh(['api', 'graphql', '-F', 'query=@q.graphql'])).toMatchObject({ effect: 'write', promotable: 'manual' });
  });

  it('does not let a write that merely contains a help flag pass as help', () => {
    // `--body -h` is a body whose text is "-h"; gh would create the issue.
    expect(classifyGh(['issue', 'create', '--title', 'x', '--body', '-h'])).toMatchObject({ effect: 'write' });
  });

  it('finds the subcommand behind a -R flag', () => {
    expect(classifyGh(['pr', '-R', 'o/r', 'create', '--title', 't'])).toMatchObject({ command: 'pr create', promotable: 'click' });
    expect(classifyGh(['pr', '--repo', 'o/r', 'list'])).toMatchObject({ effect: 'read' });
  });

  it('treats an unknown top-level command as a manual write rather than a read', () => {
    expect(classifyGh(['frobnicate'])).toMatchObject({ effect: 'write', promotable: 'manual', command: 'frobnicate (unknown)' });
  });

  /**
   * The review findings, pinned: each argv below is one gh (cobra + pflag) reads differently
   * from a reader that skips unknown flags or matches only `-a` exactly. Every one must fail
   * closed - never a read the shim would execute, never a click cezar would promote.
   */
  it.each([
    ['pr -t create merge 42 --squash', 'gh runs `pr merge`: a flag before the subcommand is read as its value'],
    ['pr -t view create --title x', 'gh runs `pr create`'],
    ['pr review 42 -a=true', 'an attached approval'],
    ['pr review 42 -ab LGTM', 'an approval inside a cluster'],
    ['pr create -dF body.md', 'a body file hidden in a cluster'],
    ['issue create -tTitle -bBody', 'attached short values'],
    ['api repos/o/r/issues -fbody=x', 'an attached field makes it a POST'],
    ['api repos/o/r/issues -f=title=x', 'an attached field after ='],
    ['api repos/o/r/issues -Ftitle=x', 'an attached typed field'],
    ['api -iXPOST repos/o/r/hooks', 'a method inside a cluster'],
    ['api --made-up-flag repos/o/r', 'an option the policy does not know'],
    ['-R o/r pr create', 'a flag before the group'],
  ])('fails closed on gh %s (%s)', (line) => {
    const verdict = classifyGh(line.split(' '));
    expect(verdict.effect).not.toBe('read');
    expect(verdict.promotable).not.toBe('click');
  });

  it('reads -t=true on auth status as the token flag it is', () => {
    expect(classifyGh(['auth', 'status', '-t=true'])).toMatchObject({ effect: 'deny' });
  });

  it('keeps leaf commands readable with their own flags', () => {
    expect(classifyGh(['browse', '-n'])).toMatchObject({ effect: 'read' });
    expect(classifyGh(['status', '--org', 'acme'])).toMatchObject({ effect: 'read' });
    expect(classifyGh(['api', '-X', 'GET', 'repos/o/r', '-H', 'Accept: x'])).toMatchObject({ effect: 'read' });
  });
});

describe('ghTargetRepo', () => {
  it('names the repository an explicit -R or --repo points at', () => {
    expect(ghTargetRepo(['issue', 'create', '-R', 'other/repo'])).toBe('other/repo');
    expect(ghTargetRepo(['pr', 'create', '--repo=o/r'])).toBe('o/r');
    expect(ghTargetRepo(['pr', 'create'])).toBeUndefined();
  });
});

describe('ghFileReferences', () => {
  it('finds body files for pr and issue writes, including stdin and the = spelling', () => {
    expect(ghFileReferences(['pr', 'create', '--body-file', 'body.md'])).toEqual([
      { index: 3, flag: '--body-file', value: 'body.md', inline: false },
    ]);
    expect(ghFileReferences(['issue', 'comment', '3', '-F', '-'])).toEqual([
      { index: 4, flag: '-F', value: '-', inline: false },
    ]);
    expect(ghFileReferences(['pr', 'create', '--body-file=b.md'])).toEqual([
      { index: 2, flag: '--body-file', value: 'b.md', inline: true },
    ]);
  });

  it('never reads -F as a file under gh api, where it means --field', () => {
    expect(ghFileReferences(['api', 'repos/o/r/issues', '-F', 'title=x'])).toEqual([]);
  });
});
