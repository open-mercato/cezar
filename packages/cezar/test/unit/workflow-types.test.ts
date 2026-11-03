import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chainStepNote,
  normalizeWorkflowDoc,
  retryableExit,
  skillStackOf,
  skillsToSteps,
  stepsIssue,
  workflowFileSchema,
  type WorkflowStepDef,
} from '../../src/workflows/types.js';

test('portable skill stacks normalize into unique agent steps', () => {
  const parsed = workflowFileSchema.parse({
    name: 'review-twice',
    skills: ['code-review', 'code-review'],
  });

  assert.deepEqual(normalizeWorkflowDoc(parsed), {
    name: 'review-twice',
    steps: [
      { id: 'code-review', name: 'code-review', skill: 'code-review', prompt: '{{task}}' },
      { id: 'code-review-2', name: 'code-review', skill: 'code-review', prompt: '{{task}}' },
    ],
  });
});

test('workflow files require exactly one step representation', () => {
  assert.equal(workflowFileSchema.safeParse({ name: 'empty' }).success, false);
  assert.equal(
    workflowFileSchema.safeParse({
      name: 'ambiguous',
      skills: ['review'],
      steps: [{ id: 'review', prompt: '{{task}}' }],
    }).success,
    false,
  );
});

test('retry targets must refer to an earlier unique step', () => {
  assert.equal(
    stepsIssue([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
    ]),
    null,
  );
  assert.equal(
    stepsIssue([
      { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
      { id: 'implement', prompt: '{{task}}' },
    ]),
    'step "verify": onFail.retry must reference an earlier step (got "implement")',
  );
  assert.equal(
    stepsIssue([
      { id: 'duplicate', prompt: '{{task}}' },
      { id: 'duplicate', command: 'npm test' },
    ]),
    'duplicate step id "duplicate"',
  );
});

test('only plain agent skill steps compact back to a portable stack', () => {
  assert.deepEqual(skillStackOf(skillsToSteps(['implement', 'review'])), ['implement', 'review']);
  assert.equal(skillStackOf([{ id: 'verify', command: 'npm test' }]), null);
  assert.equal(
    skillStackOf([{ id: 'review', name: 'Custom name', skill: 'review', prompt: '{{task}}' }]),
    null,
  );
});

// #410: a chain of 2+ skills gave every step the SAME task text and shared
// one run-level handoff journal — a later step's fresh session had nothing
// telling it "an earlier step's own completion doesn't cover you", so it
// could read the earlier step's "done" signal and self-terminate (`CEZ:DONE`)
// on its first turn without doing its own step's work. `chainStepNote` is the
// prompt-level guard against that; these pin its exact contract.
test('chainStepNote is absent for a single-step run (the common case, unchanged)', () => {
  assert.equal(chainStepNote(skillsToSteps(['implement']), 0), undefined);
});

test('chainStepNote counts AGENT steps only — a lone agent step plus checks is not a chain', () => {
  // The README's canonical workflow (README.md): one agent step + one check
  // that loops back to it. `steps.length` is 2, but there is no step boundary
  // for an agent to misread, so the prompt must stay untouched.
  const readmeShape: WorkflowStepDef[] = [
    { id: 'implement', skill: 'project-conventions', prompt: '{{task}}' },
    { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
  ];
  assert.equal(chainStepNote(readmeShape, 0), undefined);
  // A check step never gets a note of its own — it has no prompt.
  assert.equal(chainStepNote(readmeShape, 1), undefined);
});

test('chainStepNote numbers agent steps, skipping the checks between them', () => {
  const withCheck: WorkflowStepDef[] = [
    { id: 'review', skill: 'om-auto-review-pr', prompt: '{{task}}' },
    { id: 'verify', command: 'npm test' },
    { id: 'ui', skill: 'om-auto-verify-pr-ui', prompt: '{{task}}' },
  ];
  // The second AGENT step is "step 2 of 2", not "step 3 of 3".
  assert.ok(chainStepNote(withCheck, 0)?.includes('step 1 of 2'));
  assert.equal(chainStepNote(withCheck, 1), undefined);
  assert.ok(chainStepNote(withCheck, 2)?.includes('step 2 of 2'));
});

test('chainStepNote names the step position, total, and skill for every step of a chain', () => {
  const steps = skillsToSteps(['om-auto-review-pr', 'om-auto-verify-pr-ui']);
  const first = chainStepNote(steps, 0);
  const second = chainStepNote(steps, 1);

  assert.ok(first?.includes('step 1 of 2'));
  assert.ok(first?.includes('om-auto-review-pr'));
  assert.ok(second?.includes('step 2 of 2'));
  assert.ok(second?.includes('om-auto-verify-pr-ui'));
  for (const note of [first, second]) assert.ok(note?.includes('CEZ:DONE'));
  // The whole point: tell a step that HAS a predecessor that the predecessor's
  // completion isn't its own. On step 1 that premise is false, so it is left out.
  assert.ok(second?.includes("does not mean step 2's work is done"));
  assert.ok(!first?.includes('earlier step'));
});

test('chainStepNote labels a step by its name first, then its skill, then generically', () => {
  // `name` is what the author called the step and what the GUI rail shows; a
  // skill is a support for the step's goal, not the goal itself.
  const named = chainStepNote(
    [
      { id: 'implement', name: 'Implement', skill: 'project-conventions', prompt: '{{task}}' },
      { id: 'review', skill: 'code-review', prompt: '{{task}}' },
    ],
    0,
  );
  assert.ok(named?.includes('"Implement"'));
  assert.ok(!named?.includes('project-conventions'));

  const bare = chainStepNote([{ id: 'step-1', prompt: '{{task}}' }, { id: 'step-2', prompt: '{{task}}' }], 0);
  assert.ok(bare?.includes('this step'));
});

test('retryableExit treats no list and an empty list as "any failure retries"', () => {
  // Every workflow written before `retryOn` existed, and every GUI that
  // serializes "nothing selected" as `[]`, must keep the old loop.
  for (const list of [undefined, []]) {
    assert.equal(retryableExit(list, 1), true);
    assert.equal(retryableExit(list, 2), true);
    assert.equal(retryableExit(list, -1), true);
  }
});

test('retryableExit loops only on the listed codes', () => {
  // `e2e`: 1 is the verdict on the diff, 2-4 are config / engine / internal
  // failures the coding agent cannot fix, 130 is an interrupt.
  assert.equal(retryableExit([1], 1), true);
  for (const code of [2, 3, 4, 130, -1]) assert.equal(retryableExit([1], code), false);
});

test('a retryOn of 0 is a load-time error, not a silent no-op', () => {
  const file = (retryOn: number[]) => ({
    name: 'implement-and-e2e',
    steps: [
      { id: 'implement', prompt: '{{task}}' },
      { id: 'e2e', command: 'npx e2e run', onFail: { retry: 'implement', max: 2, retryOn } },
    ],
  });

  // A check that exits 0 passed and never reaches the loop, so listing it is a
  // misreading of the field — one the loader says out loud.
  assert.equal(workflowFileSchema.safeParse(file([0, 1])).success, false);
  const ok = workflowFileSchema.safeParse(file([1]));
  assert.equal(ok.success, true);
  assert.deepEqual(ok.success && ok.data.steps?.[1]?.onFail, { retry: 'implement', max: 2, retryOn: [1] });
});
