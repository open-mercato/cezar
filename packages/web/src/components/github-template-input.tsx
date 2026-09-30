import { useEffect, useId, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { filterTemplateSuggestions } from '@/lib/github-templates'
import { cn } from '@/lib/utils'

/**
 * The template field of the new-project dialog: a free-form `owner/repo` / URL input that opens a
 * list of suggested GitHub templates on focus, filtered as you type. A combobox — the list is a
 * listbox the arrow keys move through and Enter picks from, and Escape closes it without
 * clearing what was typed. The input keeps focus throughout.
 *
 * The list renders INLINE, under the input, not in a portalled popover: the dialog's scroll lock
 * swallows wheel and touch scrolling on anything outside the dialog's own DOM, which left a
 * portalled list unscrollable past its first rows.
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
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()
  const suggestions = filterTemplateSuggestions(value)
  const showList = open && !disabled && suggestions.length > 0
  const listRef = useRef<HTMLUListElement>(null)

  // Keep the keyboard-highlighted row in view as the arrow keys move past the visible rows.
  useEffect(() => {
    if (active < 0) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const pick = (slug: string) => {
    onChange(slug)
    setOpen(false)
    setActive(-1)
  }

  return (
    <div className="grid gap-1">
      <Input
        id={id}
        data-slot="create-template"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Search, or paste owner/repo or a URL"
        value={value}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          setActive(-1)
        }}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            const delta = event.key === 'ArrowDown' ? 1 : -1
            setActive((i) => (suggestions.length === 0 ? -1 : (i + delta + suggestions.length) % suggestions.length))
          } else if (event.key === 'Enter' && showList && active >= 0) {
            event.preventDefault()
            const chosen = suggestions[active]
            if (chosen) pick(chosen.slug)
          } else if (event.key === 'Escape' && showList) {
            // Close the list only — the dialog's own Escape must not fire on the same press.
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        }}
      />
      {showList ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Suggested templates"
          data-slot="create-template-suggestions"
          className="max-h-64 overflow-y-auto overscroll-contain rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-sm"
        >
          {suggestions.map((s, index) => (
            <li
              key={s.slug}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-index={index}
              data-slot="create-template-suggestion"
              data-template={s.slug}
              // mousedown + preventDefault: the input keeps focus, so its blur does not close the
              // list before the pick lands.
              onMouseDown={(event) => {
                event.preventDefault()
                pick(s.slug)
              }}
              onMouseEnter={() => setActive(index)}
              className={cn(
                'grid cursor-pointer gap-0.5 rounded-sm px-2 py-1.5',
                index === active ? 'bg-accent text-accent-foreground' : undefined,
              )}
            >
              <span className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{s.label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{s.description}</span>
              </span>
              <span className="truncate font-mono text-[11px] text-soft-foreground">{s.slug}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
