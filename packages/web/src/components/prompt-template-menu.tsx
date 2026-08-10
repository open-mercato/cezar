import { ChevronDownIcon, NotebookPenIcon, SparklesIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from '@/lib/project-router'

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { PromptTemplate } from '@/lib/prompt-templates'
import { multiWordFilter } from '@/lib/skills'
import { cn } from '@/lib/utils'

/**
 * "Insert a template" — the trigger shared by all three follow-up composers: the GitHub
 * hand-over (`routes/github/hand-to-agent.tsx`), the Inbox's "Add instructions"
 * (`routes/inbox.tsx`), and the /new task composer (`routes/new-task.tsx`). Picking one calls
 * `onInsert` with the snippet text; the composer decides where it lands (caret position via
 * `lib/prompt-templates.ts#insertTemplate`).
 *
 * Searchable (#413 follow-up), so a long list stays usable: Popover + cmdk with `multiWordFilter`
 * — the same grammar as the skill and workflow pickers next to it, rather than a second kind of
 * dropdown. Templates match on their label, their text, and the names of any skills they are
 * assigned to.
 *
 * Renders nothing when the list is empty — a user who cleared every template in Settings gets no
 * trigger, not an empty menu.
 */
export function PromptTemplateMenu({
  templates,
  onInsert,
  triggerClassName,
  disabled,
  /** Drop the "templates" label and render just the icon — the /new composer footer, where the
   *  pill row is already full and every one of these competes with the send button for space. */
  iconOnly = false,
}: {
  templates: readonly PromptTemplate[]
  onInsert: (text: string) => void
  triggerClassName?: string
  disabled?: boolean
  iconOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // Navigated imperatively rather than rendered as a <Link>: a link inside a CommandItem gets
  // its navigation swallowed by cmdk's own onSelect handling of the row.
  const navigate = useNavigate()

  if (templates.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="prompt-template-trigger"
          aria-label="Insert a prompt template"
          title="Insert a prompt template"
          disabled={disabled}
          className={cn(
            'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
            iconOnly ? 'w-[26px] justify-center px-0' : 'px-2.5',
            triggerClassName,
          )}
        >
          <NotebookPenIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
          {iconOnly ? null : (
            <>
              templates
              <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        data-slot="prompt-template-menu"
        className="w-[336px] max-w-[calc(100vw-2rem)] p-0"
        // Radix returns focus to the trigger on close, which lands AFTER the composer's own
        // focus()+setSelectionRange — so without this the caret restore is invisible and the user
        // has to click back into the box to keep typing (the QA finding on #413).
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Command filter={multiWordFilter}>
          <CommandInput
            placeholder="search templates…"
            onInput={() => listRef.current?.scrollTo(0, 0)}
          />
          <CommandList
            ref={listRef}
            data-slot="prompt-template-list-menu"
            className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]"
          >
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup heading="Insert a template">
              {templates.map((template) => (
                <CommandItem
                  key={template.id}
                  value={`template ${template.label} ${template.id}`}
                  // The text and the assigned skill names are searchable too: you look for a
                  // template by what it SAYS ("tests") or by what it is wired to, as often as by
                  // the label someone gave it.
                  keywords={[template.text, ...(template.skills ?? [])]}
                  data-slot="prompt-template-option"
                  data-template={template.id}
                  title={template.text}
                  className="flex-col items-start gap-0.5"
                  onSelect={() => {
                    onInsert(template.text)
                    setOpen(false)
                  }}
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                      {template.label}
                    </span>
                    {template.skills && template.skills.length > 0 ? (
                      <span
                        data-slot="prompt-template-assigned"
                        title={`Applied automatically with: ${template.skills.join(', ')}`}
                        className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-violet"
                      >
                        <SparklesIcon aria-hidden="true" className="size-2.5" />
                        {template.skills.length}
                      </span>
                    ) : null}
                  </span>
                  <span className="line-clamp-1 text-[11px] text-soft-foreground">
                    {template.text}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="edit prompt templates settings"
                data-slot="prompt-template-settings"
                className="text-[12px] text-muted-foreground"
                onSelect={() => {
                  setOpen(false)
                  void navigate('/settings/prompt-templates')
                }}
              >
                Edit templates…
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
