import type { PhonePairingCodeResponse, PhonesResponse, StartPhonePairingResponse } from '@open-mercato/cezar-api-client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { cez, unwrap } from './client'
import { onWorkspaceEvent } from './global-events'

/** Settings > Connect a phone (spec `2026-11-01-relay-qr-pairing`). */

const phones = () => cez.api.v1.workspace.phones
const PATH = '/workspace/phones'

export const phoneKeys = { list: ['workspace', 'phones'] as const }

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

/** Polls nothing: `phone-pairing` on the one workspace stream says when to read again. */
export function usePhones() {
  const queryClient = useQueryClient()
  useEffect(() => onWorkspaceEvent((name) => {
    if (name === 'phone-pairing') void queryClient.invalidateQueries({ queryKey: phoneKeys.list })
  }), [queryClient])
  return useQuery({ queryKey: phoneKeys.list, queryFn: ({ signal }) => getPhones({ signal }) })
}
