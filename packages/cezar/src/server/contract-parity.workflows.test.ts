import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  agentConfigFileContentSchema,
  agentConfigListingSchema,
} from '@open-mercato/cezar-contract';
import type {
  importableSkillSchema,
  removeTodoResponseSchema,
  skillSchema,
  startTodoResponseSchema,
  todoItemSchema,
} from '@open-mercato/cezar-contract';
import type {
  deleteWorkflowResponseSchema,
  groupResponseSchema,
  parsedWorkflowSchema,
  pickVariantResponseSchema,
  planResponseSchema,
  saveWorkflowResponseSchema,
  workflowsResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * Same guard as `contract-parity.test.ts`, for the workflows / groups / skills / todos /
 * agent-config families. See that file for why every assertion is MUTUAL: one-way
 * assignability passes on genuine drift, in both directions, and did so historically.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract workflows/skills/agent-config schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  // ---- workflows -------------------------------------------------------------------------
  type Workflows200 = InferResponseType<typeof client.api.v1.workflows.$get, 200>;
  type SaveWorkflow201 = InferResponseType<typeof client.api.v1.workflows.$post, 201>;
  type DeleteWorkflow200 = InferResponseType<(typeof client.api.v1.workflows)[':name']['$delete'], 200>;
  type ParseWorkflow200 = InferResponseType<typeof client.api.v1.workflows.parse.$post, 200>;
  type Plan200 = InferResponseType<typeof client.api.v1.plan.$post, 200>;

  // ---- parallel variants -----------------------------------------------------------------
  type Group200 = InferResponseType<(typeof client.api.v1.groups)[':groupId']['$get'], 200>;
  type Pick200 = InferResponseType<(typeof client.api.v1.groups)[':groupId']['pick']['$post'], 200>;

  // ---- skills / todos --------------------------------------------------------------------
  type Skills200 = InferResponseType<typeof client.api.v1.skills.$get, 200>;
  type SkillsRefresh200 = InferResponseType<typeof client.api.v1.skills.refresh.$post, 200>;
  type Importable200 = InferResponseType<typeof client.api.v1.skills.importable.$get, 200>;
  type Todos200 = InferResponseType<typeof client.api.v1.todos.$get, 200>;
  type RemoveTodo200 = InferResponseType<(typeof client.api.v1.todos)[':id']['$delete'], 200>;
  type StartTodo201 = InferResponseType<(typeof client.api.v1.todos)[':id']['start']['$post'], 201>;

  // ---- agent config ----------------------------------------------------------------------
  type AgentConfig200 = InferResponseType<(typeof client.api.v1)['agent-config']['$get'], 200>;
  type AgentConfigFile200 = InferResponseType<(typeof client.api.v1)['agent-config'][':id']['$get'], 200>;
  type AgentConfigPut200 = InferResponseType<(typeof client.api.v1)['agent-config'][':id']['$put'], 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof workflowsResponseSchema>, Workflows200>>,
    Assert<Exact<z.infer<typeof saveWorkflowResponseSchema>, SaveWorkflow201>>,
    Assert<Exact<z.infer<typeof deleteWorkflowResponseSchema>, DeleteWorkflow200>>,
    Assert<Exact<z.infer<typeof parsedWorkflowSchema>, ParseWorkflow200>>,
    Assert<Exact<z.infer<typeof planResponseSchema>, Plan200>>,
    Assert<Exact<z.infer<typeof groupResponseSchema>, Group200>>,
    Assert<Exact<z.infer<typeof pickVariantResponseSchema>, Pick200>>,
    Assert<Exact<z.infer<typeof skillSchema>[], Skills200>>,
    Assert<Exact<z.infer<typeof skillSchema>[], SkillsRefresh200>>,
    Assert<Exact<z.infer<typeof importableSkillSchema>[], Importable200>>,
    Assert<Exact<z.infer<typeof todoItemSchema>[], Todos200>>,
    Assert<Exact<z.infer<typeof removeTodoResponseSchema>, RemoveTodo200>>,
    Assert<Exact<z.infer<typeof startTodoResponseSchema>, StartTodo201>>,
    Assert<Exact<z.infer<typeof agentConfigListingSchema>, AgentConfig200>>,
    Assert<Exact<z.infer<typeof agentConfigFileContentSchema>, AgentConfigFile200>>,
    Assert<Exact<z.infer<typeof agentConfigFileContentSchema>, AgentConfigPut200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
