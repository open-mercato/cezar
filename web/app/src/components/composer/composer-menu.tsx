import { ImageUpIcon, PlusIcon } from 'lucide-react'
import { useRef } from 'react'
import { useNavigate } from '@/lib/project-router'

import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PopoverContent } from '@/components/ui/popover'
import type { PromptTemplate } from '@/lib/prompt-templates'
import { cn } from '@/lib/utils'
import { MAX_IMAGES } from './composer-images'
import type { TriggerState } from './composer-text'

export interface MenuCandidate {
  value: string
  insert: string
  label: string
  description?: string
  emphasized: boolean
}

export function ComposerPlusMenu({
  disabled,
  atCap,
  onFiles,
  templates,
  onInsertTemplate,
}: {
  disabled: boolean
  atCap: boolean
  onFiles: (files: readonly File[]) => void
  templates: readonly PromptTemplate[]
  onInsertTemplate: (text: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-round"
            aria-label="Add to your task"
            title="Attach images or insert a template"
            disabled={disabled}
            className="text-muted-foreground"
          >
            <PlusIcon aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          data-slot="composer-plus-menu"
          className="w-72 max-w-[calc(100vw-2rem)]"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenuItem
            data-slot="composer-attach"
            disabled={atCap}
            title={atCap ? `Image limit reached (${MAX_IMAGES})` : 'Attach an image (or paste a screenshot)'}
            onSelect={() => inputRef.current?.click()}
          >
            <ImageUpIcon aria-hidden="true" className="size-4" />
            Attach images
          </DropdownMenuItem>
          {templates.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Insert a template
              </DropdownMenuLabel>
              {templates.map((template) => (
                <DropdownMenuItem
                  key={template.id}
                  data-slot="prompt-template-option"
                  data-template={template.id}
                  title={template.text}
                  className="flex-col items-start gap-0.5"
                  onSelect={() => onInsertTemplate(template.text)}
                >
                  <span className="w-full truncate text-xs font-medium text-foreground">
                    {template.label}
                  </span>
                  <span className="line-clamp-1 w-full text-2xs text-soft-foreground">
                    {template.text}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-slot="prompt-template-settings"
                className="text-xs text-muted-foreground"
                onSelect={() => void navigate('/settings/prompt-templates')}
              >
                Edit templates…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
    </>
  )
}

/**
 * The `/` skills + `@` files autocomplete surface, anchored over the composer. A suggestion
 * surface, not a focus trap: focus never leaves the textarea (`onOpenAutoFocus` no-op), and the
 * host's keydown handler drives the ArrowUp/Down/Enter/Tab selection through `activeValue`.
 */
export function ComposerMenu({
  trigger,
  candidates,
  activeValue,
  skillsPending,
  onHighlight,
  onPick,
}: {
  trigger: TriggerState | null
  candidates: MenuCandidate[]
  activeValue: string | undefined
  skillsPending: boolean
  onHighlight: (value: string) => void
  onPick: (candidate: MenuCandidate) => void
}) {
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      className="w-80 max-w-[calc(100vw-2rem)] p-0"
      // Focus stays in the textarea — the menu is a suggestion surface, not a focus trap.
      onOpenAutoFocus={(event) => event.preventDefault()}
    >
      <Command shouldFilter={false} value={activeValue ?? ''} onValueChange={onHighlight}>
        <CommandList
          data-slot="composer-menu"
          data-trigger={trigger?.trigger}
          // Clamped to the popper's reported space so the open keyboard (collisionPadding
          // via the shared PopoverContent) shrinks the menu instead of hiding its tail.
          className="max-h-[min(16rem,var(--available-height))] p-1"
        >
          {candidates.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {trigger?.trigger === '@'
                ? 'No files seen in this session yet — full file search arrives with the Files tab.'
                : skillsPending
                  ? 'Loading skills…'
                  : 'No matching skills.'}
            </p>
          ) : (
            candidates.map((candidate) => (
              <CommandItem
                key={candidate.value}
                value={candidate.value}
                data-slot="composer-menu-item"
                data-emphasized={candidate.emphasized || undefined}
                onSelect={() => onPick(candidate)}
              >
                <span
                  className={cn(
                    'shrink-0 truncate',
                    candidate.emphasized && 'font-semibold',
                    trigger?.trigger === '@' && 'font-mono text-xs',
                  )}
                >
                  {candidate.label}
                </span>
                {candidate.description ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                    {candidate.description}
                  </span>
                ) : null}
              </CommandItem>
            ))
          )}
        </CommandList>
      </Command>
    </PopoverContent>
  )
}
