import { hc, type InferResponseType } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { AttentionOverridesResponse, AttentionResponse, PhonePushPrefs } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/** The attention list and phone notification routes answer exactly their contract shapes (spec 2026-11-20-phone-notifications-inbox). */
const client = hc<AppType>('http://127.0.0.1');
const workspace = client.api.v1.workspace;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _List = Assert<Exact<AttentionResponse, InferResponseType<typeof workspace.attention.$get, 200>>>;
type _Set = Assert<Exact<AttentionOverridesResponse, InferResponseType<typeof workspace.attention.overrides.$post, 200>>>;
type _Clear = Assert<Exact<AttentionOverridesResponse, InferResponseType<typeof workspace.attention.overrides.clear.$post, 200>>>;
type _Mine = Assert<Exact<PhonePushPrefs, InferResponseType<typeof workspace.phone.push.prefs.$get, 200>>>;
type _SetMine = Assert<Exact<PhonePushPrefs, InferResponseType<typeof workspace.phone.push.prefs.$put, 200>>>;
type _SetOne = Assert<Exact<PhonePushPrefs, InferResponseType<(typeof workspace.phones)[':deviceId']['prefs']['$put'], 200>>>;
// Never invoked: compile-time guarantees that the body validators reached AppType.
function typedInputs() {
  workspace.attention.overrides.$post({ json: { key: 'k', mode: 'dismiss', until: '2026-11-24T09:00:00.000Z' } });
  // @ts-expect-error an unknown mode
  workspace.attention.overrides.$post({ json: { key: 'k', mode: 'hide' } });
  workspace.attention.overrides.clear.$post({ json: { key: 'k' } });
  workspace.phone.push.prefs.$put({ json: { push: ['question'], icon: [], understands: ['attention', 'count'] } });
  // @ts-expect-error an unknown kind
  workspace.phone.push.prefs.$put({ json: { push: ['everything'], icon: [], understands: ['attention'] } });
  // The computer edits the settings, never what the app understands.
  workspace.phones[':deviceId'].prefs.$put({ param: { deviceId: 'x' }, json: { push: [], icon: [] } });
}
describe('attention response parity', () => {
  it('keeps the chained routes visible to the typed client', () => expect([workspace.attention, typedInputs]).toBeDefined());
});
