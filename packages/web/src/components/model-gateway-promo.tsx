import { ArrowRightIcon, XIcon } from 'lucide-react'

import { useModelGateway, useWorkspaceUiState } from '@/api/queries'
import { useOnboardingWrite } from '@/components/onboarding-kit'
import { MODEL_GATEWAY_COPY, MODEL_GATEWAY_SETTINGS_PATH } from '@/lib/model-gateway-copy'
import { Link } from '@/lib/project-router'

/** The id its close is remembered under, beside the announcements the user has closed. */
export const MODEL_GATEWAY_PROMO_ID = 'model-gateway-banner-2026-11'

/**
 * The model gateway's line at the top of every page (spec 2026-11-10-model-gateway): until the user
 * closes it or saves a gateway. Silent while either answer is unknown, so it never flashes.
 */
export function ModelGatewayPromo() {
  const uiState = useWorkspaceUiState()
  const gateway = useModelGateway()
  const write = useOnboardingWrite()
  const dismissed = uiState.data?.onboarding?.dismissedAnnouncements
  if (!uiState.data || !gateway.data || gateway.data.gateway || gateway.data.error) return null
  if (dismissed?.includes(MODEL_GATEWAY_PROMO_ID)) return null
  const close = () => write({ dismissedAnnouncements: [...(dismissed ?? []), MODEL_GATEWAY_PROMO_ID].slice(-50) })
  const copy = MODEL_GATEWAY_COPY.banner
  return (
    <div data-slot="model-gateway-promo" role="status" className="flex min-h-9 items-center gap-2 border-b border-border bg-violet/10 px-4 text-sm text-foreground">
      <span className="eyebrow shrink-0 rounded-full bg-violet/20 px-2 py-0.5 text-violet">{copy.eyebrow}</span>
      <span className="min-w-0 truncate">{copy.text}</span>
      <Link
        to={MODEL_GATEWAY_SETTINGS_PATH}
        className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copy.action}
        <ArrowRightIcon className="size-3.5" aria-hidden="true" />
      </Link>
      <button
        type="button"
        aria-label="Dismiss the model gateway note"
        onClick={close}
        className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}
