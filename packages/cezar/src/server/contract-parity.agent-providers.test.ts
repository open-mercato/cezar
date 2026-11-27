import { hc, type InferRequestType, type InferResponseType } from 'hono/client';
import { expect, it } from 'vitest';
import type { z } from 'zod';
import type { AgentProviderEntry, AgentProviderMethod, AgentProvidersResponse, providerMethodInputSchema,
  providerActiveInputSchema, providerModelsResponseSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const providers = hc<AppType>('http://localhost').api.v1['agent-providers'];
const active = providers[':runner'].active;
const method = providers[':runner'].methods[':methodId'];
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Check<T extends true> = T;
type Checks = [
  Check<Equal<InferResponseType<typeof providers.$get, 200>, AgentProvidersResponse>>,
  Check<Equal<InferResponseType<typeof active.$put, 200>, AgentProviderEntry>>,
  Check<Equal<InferResponseType<typeof method.$put, 200>, AgentProviderMethod>>,
  Check<Equal<InferResponseType<typeof method.models.$post, 200>, z.output<typeof providerModelsResponseSchema>>>,
  Check<Equal<InferRequestType<typeof method.$put>['json'], z.input<typeof providerMethodInputSchema>>>,
  Check<Equal<InferRequestType<typeof active.$put>['json'], z.input<typeof providerActiveInputSchema>>>,
];
it('keeps workspace provider routes in the typed client', () => {
  const checks: Checks = [true, true, true, true, true, true];
  expect(checks.every(Boolean)).toBe(true);
});
