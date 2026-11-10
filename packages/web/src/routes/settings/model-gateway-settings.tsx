import * as React from 'react'
import { useLocation } from 'react-router'

import { useAgentSetup, useModelGateway, useProviderStatus } from '@/api/queries'
import { AgentSetupList } from '@/components/agent-setup'
import { ModelGatewayPanel } from '@/components/model-gateway'

/**
 * Settings → Agents → Model gateway (spec 2026-11-10-model-gateway): one API key — OpenRouter or
 * any OpenAI-compatible endpoint — and its models run on OpenCode, installed from here if missing.
 */
export function ModelGatewaySettings() {
  const gateway = useModelGateway()
  const setup = useAgentSetup()
  const status = useProviderStatus()
  const opencode = status.data?.providers.find((row) => row.provider === 'opencode')
  const needsOpenCode = Boolean(gateway.data?.gateway) && opencode?.status === 'not-installed'
  // The promos link here by `#model-gateway`; the page renders after the browser looked for it.
  const { hash } = useLocation()
  const section = React.useRef<HTMLElement>(null)
  const loaded = gateway.data !== undefined
  React.useEffect(() => {
    if (hash === '#model-gateway' && loaded) section.current?.scrollIntoView({ block: 'start' })
  }, [hash, loaded])
  return (
    <section ref={section} id="model-gateway" data-slot="model-gateway-settings" className="scroll-mt-20">
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-foreground">Model gateway</h2>
        <p className="text-ui text-muted-foreground">
          One API key for many models — OpenRouter, or your own OpenAI-compatible API. Tasks use them on OpenCode.
        </p>
      </div>
      <ModelGatewayPanel />
      {needsOpenCode ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-ui text-muted-foreground">These models run on OpenCode, which is not installed yet.</p>
          {setup.data?.available ? <AgentSetupList setup={setup.data} status={status.data} only="opencode" /> : null}
        </div>
      ) : null}
    </section>
  )
}
