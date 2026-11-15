import { useHealth } from '@/api/queries'
import { MachineCard } from './machine-card'
import { ManagerSection } from './manager-section'
import { ResourcesCards } from './resources-section'

/**
 * Settings → Behaviour (design doc, Proposal 8): Resources and Manager as one page — the
 * machine's live totals first (they answer "how is the machine" before the knobs answer "how
 * hard may cezar push it"), then the limits, monitoring, new-task defaults and — on a server
 * that has managers — which approvals confirm first. The Manager card is gated the way its page
 * was: never on a guess, only once health says `managers: true`.
 */
export function BehaviourSection() {
  const managers = useHealth().data?.capabilities?.managers === true
  return (
    <div data-slot="behaviour-section" className="flex w-full flex-col gap-5">
      <MachineCard />
      {/* Anchors on the wrappers, not the cards: an old link must land while the data loads. */}
      <div id="resources" className="scroll-mt-16"><ResourcesCards /></div>
      {managers ? <div id="manager" className="scroll-mt-16"><ManagerSection /></div> : null}
    </div>
  )
}
