import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountUsageSwitchesSchema } from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'

/** The per-account "Allow agents to check this account's usage" switches (issue #1745). */
const switchesKey = ['workspace', 'account-usage', 'switch'] as const

export function useAccountUsageSwitches() {
  return useQuery({
    queryKey: switchesKey,
    queryFn: async ({ signal }) => accountUsageSwitchesSchema.parse(await unwrap(
      await cez.api.v1.workspace['account-usage'].switch.$get({}, { init: { signal } }),
      '/workspace/account-usage/switch',
    )),
  })
}

export function useSetAccountUsageSwitch() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: { account: string; allowed: boolean }) => accountUsageSwitchesSchema.parse(await unwrap(
      await cez.api.v1.workspace['account-usage'].switch.$put({ json: input }),
      '/workspace/account-usage/switch',
    )),
    onSuccess: (switches) => { client.setQueryData(switchesKey, switches) },
  })
}
