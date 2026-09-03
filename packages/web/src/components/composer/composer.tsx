import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpIcon, CheckIcon, MicIcon, PaperclipIcon, XIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'

import { putUiState } from '@/api/client'
import { queryKeys, useSkills, useUiState } from '@/api/queries'
import type { ImageInput } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { insertTemplate } from '@/lib/prompt-templates'
import { isEditableTarget } from '@/lib/use-command-shortcut'
import { bumpSkillUsage, filterSkills, fuzzyMatch, isProjectSkill } from '@/lib/skills'
import { useNow } from '@/lib/use-now'
import { isSubmitShortcut } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'

import {
  fileToPendingImage,
  MAX_IMAGES,
  screenFiles,
  type PendingImage,
} from './composer-images'
import { applyCompletion, detectTrigger, type TriggerState } from './composer-text'
import { formatElapsed, useDictation } from './dictation'

/**
 * The SHARED composer (spec §"Task thread" composer + §"New task" composer intelligence —
 * one component, two hosts): auto-growing textarea, Enter-sends / Shift+Enter-newline /
 * ⌘↵+Ctrl+↵ (`isSubmitShortcut`), image attach/paste/drag-drop with the legacy 4×5MB caps and
 * thumbnail row, `/` skills autocomplete (#380), `@` file mentions behind a provider seam,
 * the Dictation mic (paseo pattern), and the Alt+A / Alt+C quick replies.
 *
 * Visual contract: docs/mockups/thread.html `.composer` — card, borderless textarea, footer
 * bar with paperclip · spacer · labeled Dictation · lime send.
 */
export interface ComposerProps {
  /** Deliver the message. Rejection = the message did NOT land: the composer toasts the error
   *  and restores the draft (nothing the user typed is ever lost). */
  onSubmit: (text: string, images: ImageInput[]) => Promise<unknown>
  /**
   * Controlled text (pass BOTH or neither): the /new host owns the draft so it survives
   * navigation (spec: "Queued form state survives navigation"). Every internal edit — typing,
   * completions, the optimistic clear, the on-error restore — flows through `onValueChange`.
   */
  value?: string
  onValueChange?: (text: string) => void
  /** Focus the textarea on mount — the /new hero, where typing is the whole point of arriving. */
  autoFocus?: boolean
  /** Rendered in the footer bar after the paperclip — the /new picker pill row. */
  footerStart?: ReactNode
  /** Rendered between Dictation and the send button — the /new mode segment + kbd hint. */
  footerEnd?: ReactNode
  /** The send button's accessible name. */
  sendAriaLabel?: string
  disabled?: boolean
  /** Shown as the placeholder while disabled — e.g. the legacy "Session closed — Continue to
   *  reopen." */
  disabledReason?: string
  /**
   * Let the send button fire on an empty draft. Off by default (an empty message is not a
   * message); ON for the thread's closed-but-resumable state, where submitting IS "Continue"
   * and continuing with no prompt is the legacy one-click behavior.
   */
  allowEmptySubmit?: boolean
  placeholder?: string
  ariaLabel?: string
  /** `/` opens the project-first skills autocomplete (#380). */
  autocompleteSkills?: boolean
  /** Alt+A → "Yes, approved." / Alt+C → "Continue." — the legacy quick replies, window-global
   *  while the composer is enabled. */
  quickReplies?: boolean
  /**
   * The `@` mention source seam. TODAY the thread feeds it the file paths its tool items
   * touched (real data — edit/read locations and diffs); R5's `/files` API upgrades this same
   * prop to a worktree-wide fuzzy search without touching the composer. Absent ⇒ `@` stays
   * plain text.
   */
  getMentionCandidates?: () => string[]
  /** Exposes `ComposerHandle` — see there for why this exists. */
  ref?: Ref<ComposerHandle>
}

/** The imperative seam a host needs when it wants to write INTO the draft the composer owns —
 *  today only the /new prompt-template menu (#413 follow-up), which must land a snippet at the
 *  caret the same way the GitHub/Inbox composers do with their own textarea refs. */
export interface ComposerHandle {
  /** Insert `snippet` at the caret, blank-line separated (`insertTemplate`), then refocus with
   *  the caret parked right after it. */
  insertAtCaret: (snippet: string) => void
}

const QUICK_REPLIES: Record<string, string> = { KeyA: 'Yes, approved.', KeyC: 'Continue.' }

export function Composer({
  onSubmit,
  value,
  onValueChange,
  autoFocus = false,
  footerStart,
  footerEnd,
  sendAriaLabel = 'Send',
  disabled = false,
  disabledReason = 'Session closed — Continue to reopen.',
  allowEmptySubmit = false,
  placeholder = 'Reply — / for skills, @ for files…',
  ariaLabel = 'Reply to the agent',
  autocompleteSkills = true,
  quickReplies = false,
  getMentionCandidates,
  ref,
}: ComposerProps) {
  // Optionally controlled: `value` (when given) shadows the internal state, and every write is
  // mirrored to both — updater functions resolve against whichever is authoritative right now.
  const [internalText, setInternalText] = useState('')
  const text = value ?? internalText
  const textRef = useRef(text)
  textRef.current = text
  const onValueChangeRef = useRef(onValueChange)
  onValueChangeRef.current = onValueChange
  const setText = useCallback((next: string | ((current: string) => string)) => {
    const resolved = typeof next === 'function' ? next(textRef.current) : next
    setInternalText(resolved)
    onValueChangeRef.current?.(resolved)
  }, [])
  const [images, setImages] = useState<PendingImage[]>([])
  // Mirrors `images` for reads inside event handlers that must not run through a setState updater
  // (StrictMode double-invokes those in dev — see addFiles / #double-paste).
  const imagesRef = useRef(images)
  imagesRef.current = images
  const [busy, setBusy] = useState(false)
  const [trigger, setTrigger] = useState<TriggerState | null>(null)
  const [menuValue, setMenuValue] = useState('')
  // Skills load on the FIRST `/` trigger and stay cached — not on every thread visit.
  const [skillsWanted, setSkillsWanted] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const pendingCaretRef = useRef<number | null>(null)

  const skills = useSkills(autocompleteSkills && skillsWanted)
  // The `/` list orders most-used first (#519) and a pick bumps `skillUsage`, so this — the
  // highest-traffic skill surface — both reads and feeds the same stats as the pickers.
  const uiState = useUiState()
  const queryClient = useQueryClient()
  const dictation = useDictation((message) => toast(message, { tone: 'danger' }))

  // On-mount only, by design: re-focusing on a later `autoFocus` flip would steal focus mid-visit.
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, []) // deliberately not [autoFocus]

  // Rides the same `pendingCaretRef` + layout-effect restore the `/` autocomplete uses, rather
  // than a rAF: the caret is set in the same paint as the text, so there is no window in which a
  // closing dropdown can take the focus back (the QA finding on #413's first cut).
  useImperativeHandle(
    ref,
    () => ({
      insertAtCaret: (snippet: string) => {
        const el = textareaRef.current
        const result = insertTemplate(textRef.current, el?.selectionStart ?? textRef.current.length, snippet)
        setText(result.text)
        pendingCaretRef.current = result.caret
        el?.focus()
      },
    }),
    [setText],
  )

  // ---- autocomplete ------------------------------------------------------------------------

  /** Re-read the trigger from the real textarea (value + caret) — the one source of truth. */
  const syncTrigger = useCallback(() => {
    const el = textareaRef.current
    if (!el || disabled) {
      setTrigger(null)
      return
    }
    const next = detectTrigger(el.value, el.selectionStart ?? el.value.length)
    if (next?.trigger === '/' && !autocompleteSkills) return setTrigger(null)
    if (next?.trigger === '@' && getMentionCandidates === undefined) return setTrigger(null)
    if (next?.trigger === '/') setSkillsWanted(true)
    setTrigger(next)
  }, [autocompleteSkills, disabled, getMentionCandidates])

  interface MenuCandidate {
    value: string
    insert: string
    label: string
    description?: string
    emphasized: boolean
  }

  const candidates = useMemo((): MenuCandidate[] => {
    if (trigger === null) return []
    if (trigger.trigger === '/') {
      return filterSkills(skills.data ?? [], trigger.query, uiState.data?.skillUsage).map((skill) => ({
        // The path suffix keeps values unique when a project skill shadows a global one.
        value: `${skill.name} ${skill.path}`,
        insert: skill.name,
        label: skill.name,
        description: skill.description,
        emphasized: isProjectSkill(skill),
      }))
    }
    const paths = getMentionCandidates?.() ?? []
    return paths
      .filter((path) => fuzzyMatch(path, trigger.query))
      .map((path) => ({ value: path, insert: path, label: path, emphasized: false }))
  }, [getMentionCandidates, skills.data, trigger, uiState.data?.skillUsage])

  const activeValue = candidates.some((c) => c.value === menuValue)
    ? menuValue
    : candidates[0]?.value
  const menuOpen = trigger !== null

  const closeMenu = useCallback(() => setTrigger(null), [])

  const pick = (candidate: MenuCandidate) => {
    const el = textareaRef.current
    if (!el || trigger === null) return
    const caret = el.selectionStart ?? el.value.length
    const next = applyCompletion(el.value, trigger, caret, candidate.insert)
    // Frequency sort (#519): a `/` completion is a skill pick, so it counts — same guard as
    // /new's submit (#408): only bump once the CURRENT map is known. The PUT merge is shallow,
    // so bumping off an unresolved/errored ui-state query would send a one-entry map and wipe
    // every accumulated count. Fire-and-forget; a lost bump costs one count, nothing more.
    if (trigger.trigger === '/' && uiState.data !== undefined) {
      putUiState({ skillUsage: bumpSkillUsage(uiState.data.skillUsage, candidate.insert) })
        .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
        .catch(() => {})
    }
    setText(next.text)
    pendingCaretRef.current = next.caret
    setTrigger(null)
    el.focus()
  }

  // Restore the caret after a completion replaced the token mid-draft.
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    const el = textareaRef.current
    if (caret !== null && el) {
      el.setSelectionRange(caret, caret)
      pendingCaretRef.current = null
    }
  }, [text])

  // ---- sizing (mockup: min 54px, grows with content, never past ~1/3 screen) ----------------

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  // ---- images --------------------------------------------------------------------------------

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (disabled) return
      // Side effects (screening toasts + async encode) run OUTSIDE any setState updater: React
      // StrictMode double-invokes updater functions in dev, so screening here would encode and
      // append each pasted image twice (#double-paste). `imagesRef` gives the current count
      // without reading through state; each async append re-checks the cap functionally.
      const intake = screenFiles(files, imagesRef.current.length)
      for (const reason of intake.rejected) toast(reason, { tone: 'danger' })
      for (const file of intake.accepted) {
        void fileToPendingImage(file).then((image) =>
          setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, image])),
        )
      }
    },
    [disabled],
  )

  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const onDrop = (event: DragEvent) => {
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  // ---- submit --------------------------------------------------------------------------------

  const send = useCallback(
    async (messageText: string, messageImages: PendingImage[], restoreOnError: boolean) => {
      const body = messageText.trim()
      if (disabled || busy) return
      if (body === '' && messageImages.length === 0 && !allowEmptySubmit) return
      setBusy(true)
      try {
        await onSubmit(
          body,
          messageImages.map(({ mediaType, data }) => ({ mediaType, data })),
        )
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        if (restoreOnError) {
          // The optimistic clear already happened — put the message back, in front of anything
          // typed since, so nothing the user wrote is lost.
          setText((current) => (current === '' ? messageText : `${messageText}\n${current}`))
          setImages((current) => [...messageImages, ...current].slice(0, MAX_IMAGES))
        }
      } finally {
        setBusy(false)
      }
    },
    [allowEmptySubmit, busy, disabled, onSubmit],
  )

  const submitDraft = useCallback(() => {
    if (text.trim() === '' && images.length === 0 && !allowEmptySubmit) return
    const draftText = text
    const draftImages = images
    // Optimistic clear — the reply feels instant; a rejection restores it above.
    setText('')
    setImages([])
    setTrigger(null)
    void send(draftText, draftImages, true)
  }, [allowEmptySubmit, images, send, text])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (candidates.length === 0) return
        const at = candidates.findIndex((c) => c.value === activeValue)
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const next = candidates[(at + delta + candidates.length) % candidates.length]!
        setMenuValue(next.value)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        const active = candidates.find((c) => c.value === activeValue)
        if (active) {
          event.preventDefault()
          pick(active)
          return
        }
        // No match to accept: the menu is inert — close it and let Enter mean "send".
        closeMenu()
      }
    }
    const shouldSend = isSubmitShortcut({
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
    })
    if (shouldSend) {
      event.preventDefault()
      submitDraft()
    }
  }

  // ---- quick replies (legacy parity: window-global, only while the composer can send) --------

  useEffect(() => {
    if (!quickReplies || disabled) return
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.repeat) return
      // Alt is a TEXT modifier on macOS: ⌥ composes characters, so ⌥C types `ć` on a Polish
      // layout (`ç` on a US one) and ⌥A types `ą`/`å` — same `event.code`, and this handler
      // matches the code, not the character. Typed into the composer that fired "Continue." at
      // the agent and swallowed the letter with `preventDefault`. Same rule the ⌘K family
      // already follows (`shouldTriggerKeyShortcut`): a focused editable means someone is
      // typing, and typing always wins. The accelerator still works everywhere else — the
      // thread composer is not autofocused, which is when these replies are reached for.
      if (isEditableTarget(event.target)) return
      const reply = QUICK_REPLIES[event.code]
      if (reply === undefined) return
      event.preventDefault()
      // Canned replies bypass the draft entirely — nothing to restore on failure.
      void send(reply, [], false)
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [disabled, quickReplies, send])

  // ---- dictation actions -----------------------------------------------------------------------

  const insertTranscript = (alsoSend: boolean) => {
    const transcript = dictation.finish()
    if (transcript === '') return
    const merged = text.trim() === '' ? transcript : `${text.replace(/\s*$/, '')} ${transcript}`
    if (alsoSend) {
      setText('')
      setImages([])
      void send(merged, images, true)
      return
    }
    setText(merged)
    pendingCaretRef.current = merged.length
    textareaRef.current?.focus()
  }

  const recording = dictation.recording

  return (
    <Popover open={menuOpen} onOpenChange={(open) => (open ? undefined : closeMenu())}>
      <PopoverAnchor asChild>
        <div
          ref={rootRef}
          data-slot="composer"
          data-disabled={disabled || undefined}
          onDrop={onDrop}
          onDragOver={(event) => event.preventDefault()}
          className={cn(
            'rounded-xl border border-border bg-card shadow-xs transition-[border-color,box-shadow]',
            'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15',
            disabled && 'opacity-80',
          )}
        >
          {images.length > 0 ? (
            <div data-slot="composer-thumbs" className="flex flex-wrap gap-2 px-4 pt-3">
              {images.map((image, index) => (
                <button
                  key={`${image.name}-${index}`}
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  title="Click to remove"
                  className="group relative size-12 overflow-hidden rounded-md border border-border"
                  onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                >
                  <img src={image.preview} alt="" className="size-full object-cover" />
                  <span className="absolute inset-0 hidden items-center justify-center bg-background/70 group-hover:flex group-focus-visible:flex">
                    <XIcon aria-hidden="true" className="size-4" />
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            rows={2}
            value={text}
            disabled={disabled}
            aria-label={ariaLabel}
            placeholder={disabled ? disabledReason : placeholder}
            // 16px on touch widths — iOS zooms any focused input below 16px (spec mobile rule).
            className="block max-h-[220px] min-h-[54px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base leading-normal outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
            onChange={(event) => {
              setText(event.target.value)
              syncTrigger()
            }}
            onKeyDown={onKeyDown}
            onSelect={syncTrigger}
            onPaste={onPaste}
          />

          {recording ? (
            <DictationBar
              transcript={recording.transcript}
              startedAt={recording.startedAt}
              onCancel={dictation.cancel}
              onInsert={() => insertTranscript(false)}
              onInsertAndSend={() => insertTranscript(true)}
            />
          ) : (
            // The footer may WRAP (the /new pill row on narrow widths), but the trailing
            // controls stay one unbreakable group so the send button never strands alone.
            <div className="flex flex-wrap items-center gap-1 gap-y-1.5 px-2 pt-1.5 pb-2">
              {/* The paperclip shares ONE wrapping row with the footer pills — otherwise the
                  pill group is a single flex item that wraps as a block, stranding the
                  paperclip alone on the line above it (#composer-attach-line). */}
              <div data-slot="composer-footer-start" className="flex min-w-0 flex-wrap items-center gap-1">
                <AttachButton disabled={disabled} onFiles={addFiles} />
                {footerStart}
              </div>
              <div className="ml-auto flex items-center gap-1">
                {dictation.supported ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label="Start dictation"
                    title="Dictation"
                    className="h-8 gap-1.5 px-2.5 text-xs font-medium text-muted-foreground"
                    onClick={dictation.start}
                  >
                    <MicIcon aria-hidden="true" className="size-3.5" />
                    Dictation
                  </Button>
                ) : null}
                {footerEnd ? (
                  <div data-slot="composer-footer-end" className="flex items-center gap-1.5">
                    {footerEnd}
                  </div>
                ) : null}
                <Button
                  type="button"
                  size="icon-sm"
                  aria-label={sendAriaLabel}
                  disabled={
                    disabled || busy || (text.trim() === '' && images.length === 0 && !allowEmptySubmit)
                  }
                  className="size-8"
                  onClick={submitDraft}
                >
                  <ArrowUpIcon aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </PopoverAnchor>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        // Focus stays in the textarea — the menu is a suggestion surface, not a focus trap.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Interacting with the composer itself (typing, clicking the textarea) is not
        // "outside" — only a genuine elsewhere-click dismisses.
        onInteractOutside={(event) => {
          if (rootRef.current?.contains(event.target as Node)) event.preventDefault()
        }}
      >
        <Command shouldFilter={false} value={activeValue ?? ''} onValueChange={setMenuValue}>
          <CommandList
            data-slot="composer-menu"
            data-trigger={trigger?.trigger}
            // Clamped to the popper's reported space so the open keyboard (collisionPadding
            // via the shared PopoverContent) shrinks the menu instead of hiding its tail.
            className="max-h-[min(16rem,var(--radix-popover-content-available-height))] p-1"
          >
            {candidates.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                {trigger?.trigger === '@'
                  ? 'No files seen in this session yet — full file search arrives with the Files tab.'
                  : skills.isPending
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
                  onSelect={() => pick(candidate)}
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
    </Popover>
  )
}

/** The paperclip + its hidden multi-file input (legacy `#msg-attach`). */
function AttachButton({
  disabled,
  onFiles,
}: {
  disabled: boolean
  onFiles: (files: readonly File[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Attach images"
        title="Attach an image (or paste a screenshot)"
        disabled={disabled}
        className="size-8 text-muted-foreground"
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon aria-hidden="true" className="size-[15px]" />
      </Button>
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
 * The recording overlay (paseo `DictationOverlay`): swaps in for the footer bar — pulsing
 * indicator, mm:ss, the growing partial transcript, then ✕ cancel / ✓ insert / ↑ insert-and-send.
 */
function DictationBar({
  transcript,
  startedAt,
  onCancel,
  onInsert,
  onInsertAndSend,
}: {
  transcript: string
  startedAt: number
  onCancel: () => void
  onInsert: () => void
  onInsertAndSend: () => void
}) {
  const now = useNow(1000)
  return (
    <div
      data-slot="dictation-overlay"
      role="status"
      aria-label="Dictation in progress"
      className="flex items-center gap-2.5 rounded-b-xl border-t border-border bg-muted/60 px-3 py-2"
    >
      <span
        aria-hidden="true"
        className="size-2 flex-none animate-pulse rounded-full bg-danger motion-reduce:animate-none"
      />
      <span data-slot="dictation-timer" className="text-xs font-medium text-muted-foreground tabular-nums">
        {formatElapsed(startedAt, now)}
      </span>
      <span
        data-slot="dictation-transcript"
        aria-live="polite"
        className="min-w-0 flex-1 truncate text-sm text-foreground"
      >
        {transcript === '' ? (
          <span className="text-muted-foreground">Listening…</span>
        ) : (
          transcript
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Cancel dictation"
        className="size-8 text-muted-foreground"
        onClick={onCancel}
      >
        <XIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Insert transcription"
        className="size-8"
        onClick={onInsert}
      >
        <CheckIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        aria-label="Insert transcription and send"
        className="size-8"
        onClick={onInsertAndSend}
      >
        <ArrowUpIcon aria-hidden="true" />
      </Button>
    </div>
  )
}
