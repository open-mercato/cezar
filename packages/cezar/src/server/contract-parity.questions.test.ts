import { hc, type InferResponseType } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { QuestionMutationResponse, QuestionsResponse } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/** The Questions inbox routes answer exactly their contract shapes (spec 2026-11-17-questions-inbox). */
const client = hc<AppType>('http://127.0.0.1');
const questions = client.api.v1.workspace.questions;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _List = Assert<Exact<QuestionsResponse, InferResponseType<typeof questions.$get, 200>>>;
type _Answer = Assert<Exact<QuestionMutationResponse, InferResponseType<(typeof questions)[':key']['answer']['$post'], 200>>>;
type _Dismiss = Assert<Exact<QuestionMutationResponse, InferResponseType<(typeof questions)[':key']['dismiss']['$post'], 200>>>;
// Never invoked: compile-time guarantees that the body and param validators reached AppType.
function typedInputs() {
  questions[':key'].answer.$post({ param: { key: 'm:a:b' }, json: { text: 'yes' } });
  // @ts-expect-error the answer is required
  questions[':key'].answer.$post({ param: { key: 'm:a:b' }, json: {} });
  questions[':key'].dismiss.$post({ param: { key: 'm:a:b' } });
}
describe('questions response parity', () => {
  it('keeps the chained routes visible to the typed client', () => expect([questions, typedInputs]).toBeDefined());
});
