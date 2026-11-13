import { AccountsCards } from './accounts-section'
import { GlobalInstructionsCard } from './global-instructions-section'
import { SkillsCard } from './skills-section'

/**
 * Settings → Agents (design doc, Proposal 8): Agent accounts, global Instructions and Skills as
 * one page — they are one decision, "which agents run my tasks, and with what". Each card keeps
 * the id of the page it replaced, so `/settings/global/accounts` lands on `#accounts`.
 */
export function AgentsGlobalSection() {
  return (
    <div data-slot="agents-global-section" className="flex w-full flex-col gap-5">
      {/* Anchors on the wrappers, not the cards: an old link must land while the data loads. */}
      <div id="accounts" className="scroll-mt-16"><AccountsCards /></div>
      <div id="global-instructions" className="scroll-mt-16"><GlobalInstructionsCard /></div>
      <div id="skills" className="scroll-mt-16"><SkillsCard /></div>
    </div>
  )
}
