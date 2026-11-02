import type { PhonesResponse, RelayTestFailure } from '@open-mercato/cezar-api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { phoneKeys, setRelayAddress, testRelayAddress } from '@/api/phones'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'

const TEST_FAILURES: Record<RelayTestFailure, string> = {
  'invalid-address': 'That is not a relay address. Use https://host, or http:// only for 127.0.0.1, localhost or [::1], with no path.',
  unreachable: 'Could not reach that address. Check it, and that the relay is running.',
  'not-a-relay': 'Something answered, but it is not a cezar relay.',
  incompatible: 'This relay speaks a protocol version this cezar does not. Update whichever is older.',
  'rate-limited': 'The relay is limiting checks from this computer. Try again later.',
  disabled: 'The relay is switched off by its operator. Try again later.',
  refused: 'The relay refused the check. Make sure this computer’s clock is right.',
}

function ReadOnlyReason({ source }: { source: PhonesResponse['relaySource'] }) {
  if (source === 'env') {
    return (
      <p className="text-sm text-muted-foreground">
        Set by <code>CEZ_RELAY_URL</code> in the environment cezar started with, so it cannot be changed here. Unset it and restart cezar to use this field.
      </p>
    )
  }
  return (
    <p role="alert" className="text-sm text-destructive">
      <code>CEZ_RELAY_URL</code> is set, but it is not a valid relay address, so phones cannot connect. Fix or unset it, then restart cezar.
    </p>
  )
}

/** Nothing here reaches a relay but the Test button, and Save stays off until that passes. */
export function RelayAddressForm({ phones, onSaved }: { phones: PhonesResponse; onSaved: () => void }) {
  const queryClient = useQueryClient()
  const { relayOrigin: origin, relaySource: source } = phones
  const fromEnv = source === 'env' || source === 'env-invalid'
  const [draft, setDraft] = useState<string | null>(null)
  const [passed, setPassed] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<{ address: string | null } | null>(null)
  const value = draft ?? origin
  const address = value.trim()
  const paired = phones.phones.length

  const test = useMutation({
    mutationFn: () => testRelayAddress(address),
    onMutate: () => { setPassed(null); setMessage(null) },
    onSuccess: (result) => {
      if (result.ok) setPassed(address)
      else setMessage(TEST_FAILURES[result.reason])
    },
    onError: (failure: Error) => setMessage(failure.message),
  })
  const save = useMutation({
    mutationFn: (next: string | null) => setRelayAddress(next, paired > 0),
    onSuccess: (updated) => {
      queryClient.setQueryData(phoneKeys.list, updated)
      setDraft(null)
      setPassed(null)
      setMessage(null)
      setConfirming(null)
      onSaved()
      toast(updated.relayOrigin ? 'Relay address saved' : 'Relay address cleared')
    },
    onError: (failure: Error) => { setConfirming(null); setMessage(failure.message) },
  })
  const ask = (next: string | null) => {
    if (paired > 0) setConfirming({ address: next })
    else save.mutate(next)
  }

  return (
    <section aria-labelledby="relay-address" className="space-y-3">
      <h2 id="relay-address" className="text-sm font-medium">Relay</h2>
      <div className="space-y-1">
        <label htmlFor="relay-address-input" className="text-sm">Relay address</label>
        <Input
          id="relay-address-input"
          className="max-w-xl"
          value={source === 'env-invalid' ? '' : value}
          placeholder={fromEnv ? undefined : 'https://relay.example.com'}
          readOnly={fromEnv}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={300}
          onChange={(event) => { setDraft(event.target.value); setPassed(null); setMessage(null) }}
        />
      </div>
      {fromEnv ? <ReadOnlyReason source={source} /> : null}
      <div className="flex flex-wrap gap-2">
        {source === 'env-invalid' ? null : (
          <Button variant="outline" size="sm" disabled={!address || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Testing…' : 'Test'}
          </Button>
        )}
        {fromEnv ? null : (
          <Button size="sm" disabled={passed !== address || address === origin || save.isPending} onClick={() => ask(address)}>Save</Button>
        )}
        {source === 'settings' ? (
          <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => ask(null)}>Clear</Button>
        ) : null}
      </div>
      {passed === address && address ? <p role="status" className="text-sm text-muted-foreground">This relay answered and speaks a compatible protocol version.</p> : null}
      {message ? <p role="alert" className="text-sm text-destructive">{message}</p> : null}
      <p className="text-sm text-muted-foreground">
        The relay is end-to-end encrypted, so it cannot read prompts, code or keys. It does see IP addresses and the timing and volume of traffic.
      </p>
      <p className="text-sm text-muted-foreground">
        Scan only inside the Cezar app. A camera app opens the code in a browser, where a relay you do not run could read it and pair as a phone.
      </p>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.address === null ? 'Clear the relay address?' : 'Change the relay address?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {paired === 1 ? 'Your phone disconnects now and leaves the list.' : `All ${paired} phones disconnect now and leave the list.`} To use {paired === 1 ? 'it' : 'them'} again, pair {paired === 1 ? 'it' : 'them'} again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={save.isPending} onClick={() => { if (confirming) save.mutate(confirming.address) }}>
              {confirming?.address === null ? 'Clear and disconnect' : 'Change and disconnect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
