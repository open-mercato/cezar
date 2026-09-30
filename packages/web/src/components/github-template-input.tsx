import { CircleCheckIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { filterTemplateSuggestions } from '@/lib/github-templates'
import { cn } from '@/lib/utils'

/**
 * The template field of the new-project dialog: a free-form `owner/repo` / URL input above an
 * ALWAYS-VISIBLE list of suggested GitHub templates, filtered as you type, the chosen one marked.
 * A combobox — the arrow keys move through the list and Enter picks.
 *
 * Always visible, not a dropdown: a list that appeared on focus and vanished on blur resized the
 * dialog under the cursor. And inline, not a portalled popover: the dialog's scroll lock swallows
 * wheel and touch scrolling on anything outside the dialog's own DOM.
 */
export function GithubTemplateInput({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
  id: string
}) {
  const [active, setActive] = useState(-1)
  const listId = useId()
  const suggestions = filterTemplateSuggestions(value)
  const listRef = useRef<HTMLUListElement>(null)
  const chosenSlug = value.trim()

  // Keep the keyboard-highlighted row in view as the arrow keys move past the visible rows.
  useEffect(() => {
    if (active < 0) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  // …and the chosen template, so a pick (or a pasted slug) is never marked out of sight.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [chosenSlug])

  const pick = (slug: string) => {
    if (disabled) return
    onChange(slug)
    setActive(-1)
  }

  return (
    // On desktop the list takes whatever height the dialog's form column has left (and scrolls
    // itself), never less than a few rows; on mobile it is a plain capped list.
    <div className="grid gap-2 md:flex md:min-h-0 md:flex-1 md:flex-col">
      <Input
        id={id}
        data-slot="create-template"
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Search, or paste owner/repo or a URL"
        value={value}
        disabled={disabled}
        onBlur={() => setActive(-1)}
        onChange={(event) => {
          onChange(event.target.value)
          setActive(-1)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const delta = event.key === 'ArrowDown' ? 1 : -1
            setActive((i) => (suggestions.length === 0 ? -1 : (i + delta + suggestions.length) % suggestions.length))
          } else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault()
            const chosen = suggestions[active]
            if (chosen) pick(chosen.slug)
          }
        }}
      />
      {suggestions.length > 0 ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Suggested templates"
          aria-disabled={disabled || undefined}
          data-slot="create-template-suggestions"
          className={cn(
            'max-h-56 overflow-y-auto overscroll-contain rounded-md border border-border p-1',
            'md:max-h-none md:min-h-36 md:flex-1',
            disabled ? 'pointer-events-none opacity-50' : undefined,
          )}
        >
          {suggestions.map((s, index) => {
            const chosen = s.slug === chosenSlug
            return (
              <li
                key={s.slug}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={chosen}
                data-index={index}
                data-slot="create-template-suggestion"
                data-template={s.slug}
                // The pick is a click (so any activation works); mousedown only keeps focus in the input.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(s.slug)}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(-1)}
                className={cn(
                  'grid cursor-pointer gap-0.5 rounded-sm border px-2 py-1.5',
                  chosen ? 'border-primary bg-primary/5' : 'border-transparent',
                  index === active && !chosen ? 'bg-accent text-accent-foreground' : undefined,
                )}
              >
                <span className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium">
                    {s.label}
                    {chosen ? <CircleCheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
                  </span>
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">{s.description}</span>
                </span>
                <span className="truncate font-mono text-[11px] text-soft-foreground">{s.slug}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p data-slot="create-template-no-match" className="px-1 text-[12px] text-muted-foreground">
          No suggested template matches — any <span className="font-mono">owner/repo</span> or GitHub URL works.
        </p>
      )}
    </div>
  )
}
