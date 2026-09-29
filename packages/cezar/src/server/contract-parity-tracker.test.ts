import type { InferResponseType, InferRequestType } from 'hono/client';
import { hc } from 'hono/client';
import { it, expect } from 'vitest';
import type {
  TrackerWatchInput, TrackerWatchHandle, TrackerWatchSnapshot,
  TrackerAssociationResponse, TrackerAssociationSavedResponse, TrackerClearedResponse,
  TrackerCandidatesResponse, TrackerItemsResponse, TrackerItemResponse,
  TrackerErrorResponse, TrackerAssociationInput, TrackerCandidatesQueryInput,
  TrackerCredentials, TrackerConnectionResponse, TrackerListQueryInput, TrackerSearchQueryInput, TrackerItemParams, TrackerItemQuery,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const tracker = client.api.v1.tracker;
const scoped = client.api.v1.p[':projectId'].tracker;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type Checks = [
  Assert<Mutual<TrackerItemQuery, InferRequestType<typeof tracker[':id']['$get']>['query']>>,
  Assert<Mutual<TrackerItemQuery, InferRequestType<typeof scoped[':id']['$get']>['query']>>,
  Assert<Mutual<TrackerWatchInput, InferRequestType<typeof scoped.watch.$post>['json']>>,
  Assert<Mutual<TrackerWatchHandle, InferResponseType<typeof scoped.watch.$post, 200>>>,
  Assert<Mutual<TrackerWatchSnapshot, InferResponseType<typeof scoped.watch[':watchId']['$get'], 200>>>,
  Assert<Mutual<TrackerWatchSnapshot, InferResponseType<typeof scoped.watch[':watchId']['$post'], 200>>>,
  Assert<Mutual<TrackerCredentials, InferRequestType<typeof scoped.connection.$put>['json']>>,
  Assert<Mutual<TrackerConnectionResponse, InferResponseType<typeof scoped.connection.$get, 200>>>,
  Assert<Mutual<TrackerConnectionResponse, InferResponseType<typeof scoped.connection.$put, 200>>>,
  Assert<Mutual<TrackerClearedResponse, InferResponseType<typeof scoped.connection.$delete, 200>>>,
  Assert<Mutual<TrackerCandidatesResponse, InferResponseType<typeof scoped.candidates.$get, 200>>>,
  Assert<Mutual<TrackerListQueryInput, InferRequestType<typeof tracker.$get>['query']>>,
  Assert<Mutual<TrackerSearchQueryInput, InferRequestType<typeof tracker.search.$get>['query']>>,
  Assert<Mutual<TrackerListQueryInput, InferRequestType<typeof scoped.$get>['query']>>,
  Assert<Mutual<TrackerSearchQueryInput, InferRequestType<typeof scoped.search.$get>['query']>>,
  Assert<Mutual<TrackerItemParams, InferRequestType<typeof tracker[':id']['$get']>['param']>>,
  Assert<Mutual<TrackerItemParams & { projectId: string }, InferRequestType<typeof scoped[':id']['$get']>['param']>>,
  Assert<Mutual<TrackerErrorResponse, InferResponseType<typeof tracker.$get, 400>>>,
  Assert<Mutual<TrackerErrorResponse, InferResponseType<typeof tracker.search.$get, 400>>>,
  Assert<Mutual<TrackerErrorResponse, InferResponseType<typeof tracker.candidates.$get, 400>>>,
  Assert<Mutual<TrackerErrorResponse, InferResponseType<typeof tracker.association.$put, 404>>>,
  Assert<Mutual<TrackerErrorResponse, InferResponseType<typeof tracker.association.$delete, 409>>>,
  Assert<Mutual<TrackerCandidatesResponse, InferResponseType<typeof tracker.candidates.$get, 200>>>,
  Assert<Mutual<TrackerAssociationResponse, InferResponseType<typeof tracker.association.$get, 200>>>,
  Assert<Mutual<TrackerAssociationSavedResponse, InferResponseType<typeof tracker.association.$put, 200>>>,
  Assert<Mutual<TrackerClearedResponse, InferResponseType<typeof tracker.association.$delete, 200>>>,
  Assert<Mutual<TrackerItemsResponse, InferResponseType<typeof tracker.$get, 200>>>,
  Assert<Mutual<TrackerItemsResponse, InferResponseType<typeof tracker.search.$get, 200>>>,
  Assert<Mutual<TrackerItemResponse, InferResponseType<typeof tracker[':id']['$get'], 200>>>,
  Assert<Mutual<TrackerItemResponse, InferResponseType<typeof scoped[':id']['$get'], 200>>>,
  Assert<Mutual<TrackerErrorResponse, InferResponseType<typeof tracker.association.$put, 409>>>,
  Assert<Mutual<TrackerErrorResponse, InferResponseType<typeof tracker[':id']['$get'], 404>>>,
  Assert<Mutual<TrackerAssociationInput, InferRequestType<typeof tracker.association.$put>['json']>>,
  Assert<Mutual<TrackerCandidatesQueryInput, InferRequestType<typeof tracker.candidates.$get>['query']>>,
];
it('pins exact HTTP branches and middleware input types', () => {
  const falseComparator: Mutual<{a: string}, {a: string; b: number}> = false;
  expect(falseComparator).toBe(false);
});
