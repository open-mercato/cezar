import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  phoneOkResponseSchema,
  phonePairingCodeResponseSchema,
  phonesResponseSchema,
  renamePhoneInputSchema,
  startPhonePairingResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/** `packages/contract/src/phones.ts` must describe EXACTLY what the routes send and accept. */
describe('src/contract/phones.ts matches the phones routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Assert<T extends true> = T;

  type Phones = typeof client.api.v1.workspace.phones;
  type Pairing = Phones['pairing'];
  type One = Pairing[':id'];
  type Ok = z.infer<typeof phoneOkResponseSchema>;

  type _Checks = [
    Assert<Mutual<z.infer<typeof phonesResponseSchema>, InferResponseType<Phones['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof startPhonePairingResponseSchema>, InferResponseType<Pairing['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof phonePairingCodeResponseSchema>, InferResponseType<One['code']['$post'], 200>>>,
    Assert<Mutual<Ok, InferResponseType<One['approve']['$post'], 200>>>,
    Assert<Mutual<Ok, InferResponseType<One['deny']['$post'], 200>>>,
    Assert<Mutual<Ok, InferResponseType<Phones[':deviceId']['$patch'], 200>>>,
    Assert<Mutual<Ok, InferResponseType<Phones[':deviceId']['$delete'], 200>>>,
    Assert<Mutual<z.input<typeof renamePhoneInputSchema>, InferRequestType<Phones[':deviceId']['$patch']>['json']>>,
  ];

  it('is enforced by the compiler', () => {
    const checked: _Checks | undefined = undefined;
    expect(checked).toBeUndefined();
  });
});
