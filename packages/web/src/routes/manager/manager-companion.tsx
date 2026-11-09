import { useEffect, useRef, useState } from 'react'
import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'
import { ManagerMascot } from './manager-mascot'
import { managerMascotActivity, mascotReaction } from './mascot-state'

export function ManagerCompanion({ manager, messages, className }: { manager: ManagerSummary; messages: readonly ManagerMessage[]; className?: string }) {
  const seen = useRef<Map<string, ManagerMessage> | undefined>(undefined)
  const [reaction, setReaction] = useState<{ activity: 'success' | 'alert'; key: string }>()
  useEffect(() => {
    if (messages.length === 0) return
    const previous = seen.current
    seen.current = new Map(messages.map((message) => [message.id, message]))
    if (!previous) return
    const lastSeq = Math.max(...[...previous.values()].map((message) => message.seq))
    const next = [...messages].reverse().find((message) => (previous.has(message.id) || message.seq > lastSeq) && mascotReaction(previous.get(message.id), message))
    if (next) {
      const activity = mascotReaction(previous.get(next.id), next)
      if (activity) setReaction({ activity, key: `${next.id}:${activity}` })
    }
  }, [messages])
  useEffect(() => {
    if (!reaction) return
    const timer = setTimeout(() => setReaction(undefined), 1600)
    return () => clearTimeout(timer)
  }, [reaction])
  if (!manager.mascot) return null
  const activity = managerMascotActivity(manager, messages)
  return <ManagerMascot key={reaction?.key ?? 'steady'} mascot={manager.mascot} activity={activity === 'error' || activity === 'waiting' ? activity : reaction?.activity ?? activity} className={className} />
}
