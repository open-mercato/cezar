import { ChatSkeleton, ListSkeleton, LoadingState } from '@/components/loading-state'
import { Skeleton } from '@/components/ui/skeleton'

// Light on purpose: routes.tsx uses these as the lazy manager chunk's fallback, which must not
// import the chunk.

function ManagerChatSkeleton() {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-3 max-md:box-content max-md:h-13 max-md:bg-card max-md:py-0 max-md:pt-[env(safe-area-inset-top)] md:px-4">
        <Skeleton className="size-8 shrink-0 rounded-full md:hidden" />
        <Skeleton className="h-5 w-40 md:h-7" />
      </div>
      <ChatSkeleton className="mx-auto w-full max-w-[860px] px-4 py-6 md:px-6" />
    </>
  )
}

/** A chat whose manager is still resolving: its header and transcript as placeholders. */
export function ManagerChatLoading() {
  return (
    <LoadingState label="Loading conversation…" className="flex h-full min-h-0 flex-col">
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
