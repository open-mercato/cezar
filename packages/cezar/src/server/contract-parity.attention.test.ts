import { hc, type InferResponseType } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { AttentionResponse, PhoneNotificationsResponse } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/** The attention list and phone notification routes answer exactly their contract shapes (spec 2026-11-20-phone-notifications-inbox). */
const client = hc<AppType>('http://127.0.0.1');
const workspace = client.api.v1.workspace;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _List = Assert<Exact<AttentionResponse, InferResponseType<typeof workspace.attention.$get, 200>>>;
type _Mine = Assert<Exact<PhoneNotificationsResponse, InferResponseType<typeof workspace.phone.notifications.$get, 200>>>;
type _SetMine = Assert<Exact<PhoneNotificationsResponse, InferResponseType<typeof workspace.phone.notifications.$put, 200>>>;
type _SetOne = Assert<Exact<PhoneNotificationsResponse, InferResponseType<(typeof workspace.phones)[':deviceId']['notifications']['$put'], 200>>>;
// Never invoked: compile-time guarantees that the body validators reached AppType.
function typedInputs() {
  workspace.phone.notifications.$put({ json: { push: ['question'], badge: [], quietHours: null } });
  // @ts-expect-error an unknown kind
  workspace.phone.notifications.$put({ json: { push: ['everything'], badge: [], quietHours: null } });
}
describe('attention response parity', () => {
  it('keeps the chained routes visible to the typed client', () => expect([workspace.attention, typedInputs]).toBeDefined());
});
