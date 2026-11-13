import type { PhonePairingCodeResponse, PhonesResponse, RelayAccountResendResponse, RelayAccountResponse, StartPhonePairingResponse } from '@open-mercato/cezar-api-client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { cez, unwrap } from './client'
import { onWorkspaceEvent } from './global-events'

/** Settings > Connect a phone (spec `2026-11-01-relay-qr-pairing`). */

const phones = () => cez.api.v1.workspace.phones
const PATH = '/workspace/phones'

export const phoneKeys = { list: ['workspace', 'phones'] as const, account: ['workspace', 'phone-account'] as const }

export async function getPhones(opts?: { signal?: AbortSignal }): Promise<PhonesResponse> {
  return unwrap(await phones().$get({}, { init: { signal: opts?.signal } }), PATH)
}

export async function startPhonePairing(): Promise<StartPhonePairingResponse> {
  return unwrap(await phones().pairing.$post({}), `${PATH}/pairing`)
}

export async function revealPhoneCode(id: string): Promise<PhonePairingCodeResponse> {
  return unwrap(await phones().pairing[':id'].code.$post({ param: { id } }), `${PATH}/pairing/${id}/code`)
}

export async function approvePhonePairing(id: string) {
  return unwrap(await phones().pairing[':id'].approve.$post({ param: { id } }), `${PATH}/pairing/${id}/approve`)
}

export async function denyPhonePairing(id: string) {
  return unwrap(await phones().pairing[':id'].deny.$post({ param: { id } }), `${PATH}/pairing/${id}/deny`)
}

export async function renamePhone(deviceId: string, label: string) {
  return unwrap(await phones()[':deviceId'].$patch({ param: { deviceId }, json: { label } }), `${PATH}/${deviceId}`)
}

export async function removePhone(deviceId: string) {
  return unwrap(await phones()[':deviceId'].$delete({ param: { deviceId } }), `${PATH}/${deviceId}`)
}

// ---- relay account (RELAY_PROTOCOL.md § 18) ----

/** Asks the relay, so only Settings and the one-time prompt read it. */
export async function getRelayAccount(opts?: { signal?: AbortSignal }): Promise<RelayAccountResponse> {
  return unwrap(await phones().account.$get({}, { init: { signal: opts?.signal } }), `${PATH}/account`)
}

export async function setRelayAccount(email: string, termsVersion: string): Promise<RelayAccountResponse> {
  return unwrap(await phones().account.$post({ json: { email, termsVersion, accepted: true } }), `${PATH}/account`)
}

export async function resendRelayAccountCode(): Promise<RelayAccountResendResponse> {
  return unwrap(await phones().account.resend.$post({}), `${PATH}/account/resend`)
}

export async function confirmRelayAccount(code: string): Promise<RelayAccountResponse> {
  return unwrap(await phones().account.confirm.$post({ json: { code } }), `${PATH}/account/confirm`)
}

export async function deleteRelayAccount() {
  return unwrap(await phones().account.delete.$post({}), `${PATH}/account/delete`)
}

export async function dismissRelayAccountPrompt() {
  return unwrap(await phones().account.dismiss.$post({}), `${PATH}/account/dismiss`)
}

/** Read on mount and after each action. Pending re-reads each minute, so a link confirmed in the mail shows. */
export function useRelayAccount(enabled = true) {
  return useQuery({
    queryKey: phoneKeys.account,
    queryFn: ({ signal }) => getRelayAccount({ signal }),
    enabled,
    refetchInterval: (query) => (query.state.data?.status && query.state.data.status.state !== 'confirmed' ? 60_000 : false),
  })
}

/** Polls nothing: `phone-pairing` on the one workspace stream says when to read again. */
export function usePhones() {
  const queryClient = useQueryClient()
  useEffect(() => onWorkspaceEvent((name) => {
    if (name === 'phone-pairing') void queryClient.invalidateQueries({ queryKey: phoneKeys.list })
  }), [queryClient])
  return useQuery({ queryKey: phoneKeys.list, queryFn: ({ signal }) => getPhones({ signal }) })
}
