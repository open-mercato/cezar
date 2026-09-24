import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { todoTaskText, type TodoItem } from '../../src/todos.js';

/**
 * The server half of the cross-process drift guard (#374). `POST /api/todos/:id/start` builds
 * the task text here; the cockpit rebuilds it in the bundle (`todoTaskText` in
 * web/app/src/routes/inbox.tsx) to prefill `/new` with exactly what that route would have run.
 * Nothing links the two at compile time — different process, different bundle — so both assert
 * the same fixture. Change this builder and this suite goes red; "fix" it by editing the
 * fixture and inbox.test.tsx goes red instead. The drift always surfaces.
 */
interface Fixture {
  cases: Array<{ name: string; todo: Pick<TodoItem, 'summary' | 'suggestedPrompt' | 'suggestedArgs'>; expected: string }>;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/todo-task-text.json', import.meta.url)), 'utf8'),
) as Fixture;

test('the shared fixture is the whole contract, not a token case', () => {
  assert.ok(fixture.cases.length >= 5);
});

for (const { name, todo, expected } of fixture.cases) {
  test(`todoTaskText: ${name}`, () => {
    assert.equal(todoTaskText(todo), expected);
  });
}
