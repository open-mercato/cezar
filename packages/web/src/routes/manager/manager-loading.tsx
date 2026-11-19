import { useLayoutEffect } from 'react'

import { ChatSkeleton, ListSkeleton, LoadingState } from '@/components/loading-state'
import { Skeleton } from '@/components/ui/skeleton'

// Light on purpose: routes.tsx uses these as the lazy manager chunk's fallback, which must not
// import the chunk.

function ManagerChatSkeleton() {
  return (
    <div className="flex min-h-0 flex-1">
      {/* The rail's column, so the chat does not slide right when the list lands (design, Proposal 10). */}
      <div className="w-60 shrink-0 border-r border-border bg-card px-1.5 pt-12 max-md:hidden">
        <ListSkeleton rows={3} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2.5 max-md:box-content max-md:h-13 max-md:py-0 max-md:pt-[env(safe-area-inset-top)] md:px-5">
          {/* The real header's back button and mascot, so the swap does not move the transcript. */}
          <Skeleton className="size-11 shrink-0 rounded-full md:hidden" />
          <Skeleton className="size-10 shrink-0 rounded-full md:size-11" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-40 md:h-4" />
            <Skeleton className="h-3 w-64 max-md:hidden" />
          </div>
        </div>
        <ChatSkeleton className="mx-auto w-full max-w-[860px] px-4 py-6 md:px-6" />
      </div>
    </div>
  )
}

/** The chat's header is the phone's one row (mobile spec, Header); the shell's bar stays mounted. */
export function useHideShellTopBar() {
  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>('[data-slot="mobile-top-bar"]')
    if (!bar) return undefined
    bar.hidden = true
    return () => {
      bar.hidden = false
    }
  }, [])
}

/** A chat whose manager is still resolving: its header and transcript as placeholders. */
export function ManagerChatLoading() {
  // As the chat does, or the bar showing over the placeholder pushes it down when the chat lands.
  useHideShellTopBar()
  return (
    // Shown at once: the chat's own loader follows it, and a delay here is a blank frame.
    <LoadingState label="Loading conversation…" delayMs={0} className="flex h-full min-h-0 flex-col">
      <ManagerChatSkeleton />
    </LoadingState>
  )
}

/** `/manager` before the list arrives: a phone may land on the list, a desktop on a chat. */
export function ManagerIndexLoading() {
  return (
    <LoadingState label="Loading managers…" className="flex h-full min-h-0 flex-col">
      <ListSkeleton rows={4} className="p-2 md:hidden" />
      <div className="flex min-h-0 flex-1 flex-col max-md:hidden"><ManagerChatSkeleton /></div>
    </LoadingState>
  )
}
