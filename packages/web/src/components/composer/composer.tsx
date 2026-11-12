import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpIcon, CheckIcon, MicIcon, PaperclipIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
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
import type { AttachmentEntry } from '@open-mercato/cezar-api-client'
import { Kbd } from '@/components/kbd'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Spinner } from '@/components/ui/spinner'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { insertTemplate } from '@/lib/prompt-templates'
import { isEditableTarget } from '@/lib/use-command-shortcut'
import { bumpSkillUsage, filterSkills, fuzzyMatch, isProjectSkill } from '@/lib/skills'
import { useNow } from '@/lib/use-now'
import { composerEnterSends, useEnterInsertsNewline } from '@/lib/enter-key'
import { submitShortcutHint } from '@/lib/use-submit-shortcut'
import { reportDictationFailed, trackAttachmentsSent } from '@/lib/telemetry'
import { cn } from '@/lib/utils'

import {
  appendAttachment,
  attachedImageBytes,
  fileToPendingAttachment,
  screenFiles,
  toAttachmentInput,
  type AttachmentsChangeReason,
  type PendingAttachment,
} from './composer-attachments'
import { releaseStaged, sendWithStaged, stageAttachment } from './attachment-staging'
import { ComposerOptions, type ComposerOptionRow } from './composer-options'
import { applyCompletion, detectTrigger, type TriggerState } from './composer-text'
import { formatElapsed, useDictation } from './dictation'
import { dictationLanguageOptions, useDictationLanguage } from './dictation-language'

/**
 * The SHARED composer (spec §"Task thread" composer + §"New task" composer intelligence —
 * one component, two hosts): auto-growing textarea, Enter-sends / Shift+Enter-newline /
 * ⌘↵+Ctrl+↵ — on a touch-first phone Enter is the newline and only Send or the chord sends
 * (`composerEnterSends`) — attachment attach/paste/drag-drop with the legacy 4×5MB caps
 * and thumbnail row (images) or named chips (PDF/TXT/MD, #950), `/` skills autocomplete (#380),
 * `@` file mentions behind a provider seam,
 * the Dictation mic (paseo pattern), and the Alt+A / Alt+C quick replies.
 *
 * Visual contract (design Proposal 5, "the composer asks one question"): card, borderless
 * textarea, then ONE control row — paperclip · mic · the host's value pills · "Options ⌄" ·
 * spacer · the send chord · send. Everything that is not a value lives behind Options.
 */
export interface ComposerProps {
  /** Deliver the message. Rejection = the message did NOT land: the composer toasts the error
   *  and restores the draft (nothing the user typed is ever lost). */
  onSubmit: (text: string, attachments: AttachmentEntry[], meta?: ComposerSubmitMeta) => Promise<unknown>
  /**
   * Controlled text (pass BOTH or neither): the /new host owns the draft so it survives
   * navigation (spec: "Queued form state survives navigation"). Every internal edit — typing,
   * completions, the optimistic clear, the on-error restore — flows through `onValueChange`.
   */
  value?: string
  onValueChange?: (text: string) => void
  /**
   * Controlled attachments (pass BOTH or neither) — the exact mirror of the text seam above, and
   * it must stay that way: both hosts need the images to survive navigation with the text — the
   * thread host since #939, `/new` since #1018, where swapping the project pill remounts the route
   * and used to drop the pasted screenshot with the prompt. What `/new` still does NOT do is
   * persist them: its store is per-project and in-memory, because multi-MB base64 has no business
   * in localStorage. Every internal change — paste, drop, the paperclip, a thumbnail click, the
   * optimistic clear, the on-error restore — flows through `onImagesChange`.
   */
  images?: PendingAttachment[]
  onImagesChange?: (images: PendingAttachment[], reason: AttachmentsChangeReason) => void
  /** Focus the textarea on mount — the /new hero, where typing is the whole point of arriving. */
  autoFocus?: boolean
  /**
   * Draft items the host holds beside the message, rendered in the attachment row ahead of the
   * thumbnails — the thread's diff-comment chips. The composer knows nothing about them: the host
   * owns their content, folds them into what it sends, and decides via `allowEmptySubmit` whether
   * they alone make the message sendable.
   */
  draftItems?: ReactNode
  /** Rendered in the control row after the mic — the host's value pills. */
  footerStart?: ReactNode
  /** Rendered before the send button — the /new schedule summary and status. */
  footerEnd?: ReactNode
  /**
   * The rows of the "Options ⌄" popover: every setting that is not one of the value pills. The
   * composer adds its own row (the dictation language) and owns the button; the host owns the
   * values. Absent, the popover still opens for the composer's own row when there is one.
   */
  options?: ComposerOptionsConfig
  /** The send button's accessible name. */
  sendAriaLabel?: string
  sendLabel?: string
  /** The key that sends on desktop (plain Enter), shown in the send button's tooltip; a phone
   *  shows the hardware-keyboard chord instead. */
  sendShortcut?: string
  /**
   * While the host's work is running, a Stop button sits where send does. With an empty box it is
   * the only button (an empty box over a working agent offers to stop it); once there is something
   * to send, Send appears beside it — a message to a busy agent still queues.
   */
  stop?: { label: string; onStop: () => void; pending?: boolean }
  disabled?: boolean
  /** Disable submission only, keeping the draft and footer controls interactive. */
  submitDisabled?: boolean
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
  /** `/` lists these instead of skills: a host whose agent has fixed commands, not skills. */
  slashCommands?: ReadonlyArray<{ name: string; description: string }>
  /** Off: no attach button, and paste/drop leave files alone. For a host that cannot deliver them. */
  attachments?: boolean
  /**
   * One row on desktop: `footerStart`, the text, then the mic and send inside at the right, send
   * only once there is something to send (the manager frame, spec 2026-10-31-managers). On a phone
   * the text takes its own row above round controls, with `footerEnd` beside `footerStart` and a
   * Send pill that is always there (`composer-reference.png`).
   */
  compact?: boolean
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

/** How a message was sent. `quickReply` marks the Alt+A / Alt+C canned replies: they are fired
 *  from anywhere on the page, so a host must not fold its own draft items (the thread's diff
 *  comments) into them — the user never saw those leave. */
export interface ComposerSubmitMeta {
  quickReply?: boolean
}

/** What a host hands the Options popover — see `ComposerOptions` for the pieces. */
export interface ComposerOptionsConfig {
  eyebrow?: ReactNode
  rows: readonly ComposerOptionRow[]
  note?: ReactNode
  onReset?: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onOpenAutoFocus?: (event: Event) => void
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

/** Every scrolled ancestor with its scrollTop, so the autosize pass can put them back. */
function scrollAncestors(el: HTMLElement): Array<[Element, number]> {
  const out: Array<[Element, number]> = []
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.scrollTop > 0) out.push([node, node.scrollTop])
  }
  return out
}

export function Composer({
  onSubmit,
  value,
  onValueChange,
  images: controlledImages,
  onImagesChange,
  autoFocus = false,
  draftItems,
  footerStart,
  footerEnd,
  options,
  sendAriaLabel = 'Send',
  sendLabel,
  sendShortcut,
  stop,
  disabled = false,
  submitDisabled = false,
  disabledReason = 'Session closed — Continue to reopen.',
  allowEmptySubmit = false,
  placeholder = 'Reply — / for skills, @ for files…',
  ariaLabel = 'Reply to the agent',
  autocompleteSkills = true,
  slashCommands,
  attachments = true,
  compact = false,
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
  // Optionally controlled, on the same terms as the text above: `controlledImages` (when given)
  // shadows the internal state and every write is mirrored to both.
  const [internalImages, setInternalImages] = useState<PendingAttachment[]>([])
  const images = controlledImages ?? internalImages
  // Mirrors `images` for reads inside event handlers that must not run through a setState updater
  // (StrictMode double-invokes those in dev — see addFiles / #double-paste). Updated INSIDE
  // `setImages` as well as on render, so two async appends in one tick compose instead of the
  // second clobbering the first — that is what the functional-setState form used to buy.
  const imagesRef = useRef(images)
  imagesRef.current = images
  const onImagesChangeRef = useRef(onImagesChange)
  onImagesChangeRef.current = onImagesChange
  const setImages = useCallback(
    (
      next: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[]),
      reason: AttachmentsChangeReason = 'edit',
    ) => {
      const resolved = typeof next === 'function' ? next(imagesRef.current) : next
      imagesRef.current = resolved
      setInternalImages(resolved)
      onImagesChangeRef.current?.(resolved, reason)
    },
    [],
  )
  const [busy, setBusy] = useState(false)
  // Send pressed while the previous message is still on its way: the draft stays in the box and
  // goes once that one lands, the way a follow-up to a busy agent queues instead of being dropped.
  const [queued, setQueued] = useState(false)
  const [trigger, setTrigger] = useState<TriggerState | null>(null)
  const [menuValue, setMenuValue] = useState('')
  // Skills load on the FIRST `/` trigger and stay cached — not on every thread visit.
  const [skillsWanted, setSkillsWanted] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const newlineOnEnter = useEnterInsertsNewline()
  const hintId = useId()
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  // The thumbnail to focus once a removal has re-rendered the row (-1: the field).
  const pendingThumbFocus = useRef<number | null>(null)
  const pendingCaretRef = useRef<number | null>(null)
  const menuItemRefs = useRef<Map<string, HTMLElement>>(new Map())

  const skills = useSkills(autocompleteSkills && slashCommands === undefined && skillsWanted)
  // The `/` list orders most-used first (#519) and a pick bumps `skillUsage`, so this — the
  // highest-traffic skill surface — both reads and feeds the same stats as the pickers.
  const uiState = useUiState()
  const queryClient = useQueryClient()
  const [dictationLanguage, setDictationLanguage] = useDictationLanguage()
  const dictation = useDictation(({ message, failure }) => {
    if (failure) reportDictationFailed(failure)
    toast(message, failure ? { tone: 'danger', reported: true } : {})
  }, dictationLanguage)

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
    if (next?.trigger === '/' && !autocompleteSkills && slashCommands === undefined) return setTrigger(null)
    if (next?.trigger === '@' && getMentionCandidates === undefined) return setTrigger(null)
    if (next?.trigger === '/') setSkillsWanted(true)
    setTrigger(next)
  }, [autocompleteSkills, disabled, getMentionCandidates, slashCommands])

  interface MenuCandidate {
    value: string
    insert: string
    label: string
    description?: string
    emphasized: boolean
  }

  const candidates = useMemo((): MenuCandidate[] => {
    if (trigger === null) return []
    if (trigger.trigger === '/' && slashCommands) {
      return slashCommands
        .filter((command) => fuzzyMatch(command.name, trigger.query))
        .map((command) => ({
          value: command.name,
          insert: command.name,
          label: `/${command.name}`,
          description: command.description,
          emphasized: false,
        }))
    }
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
  }, [getMentionCandidates, skills.data, slashCommands, trigger, uiState.data?.skillUsage])

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
    if (trigger.trigger === '/' && slashCommands === undefined && uiState.data !== undefined) {
      putUiState({ skillUsage: bumpSkillUsage(uiState.data.skillUsage, candidate.insert) })
        .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
        .catch(() => {})
    }
    setText(next.text)
    pendingCaretRef.current = next.caret
    setTrigger(null)
    el.focus()
  }

  // cmdk's built-in scrollIntoView never fires here: the controlled value path
  // writes to the store but doesn't schedule a scroll. useEffect (not
  // useLayoutEffect) so the browser has painted and layout is settled.
  useEffect(() => {
    if (!menuOpen || activeValue == null) return
    menuItemRefs.current.get(activeValue)?.scrollIntoView({ block: 'nearest' })
  }, [activeValue, menuOpen])

  // Restore the caret after a completion replaced the token mid-draft.
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    const el = textareaRef.current
    if (caret !== null && el) {
      el.setSelectionRange(caret, caret)
      pendingCaretRef.current = null
    }
  }, [text])

  // ---- sizing (44px phone baseline / 54px desktop, grows with content, max ~1/3 screen) ------

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // The `auto` pass collapses the box for a moment; inside the task's sticky dock that shrinks
    // the shared scroller, which clamps its scrollTop and jumps the thread on every keystroke.
    const scrolled = scrollAncestors(el)
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
    for (const [node, top] of scrolled) if (node.scrollTop !== top) node.scrollTop = top
  }, [text])

  // ---- attachments ---------------------------------------------------------------------------

  const addFiles = useCallback(
    (files: readonly File[], source: 'file' | 'clipboard' = 'file') => {
      if (disabled || !attachments) return
      // Side effects (screening toasts + async encode) run OUTSIDE any setState updater: React
      // StrictMode double-invokes updater functions in dev, so screening here would encode and
      // append each pasted file twice (#double-paste). `imagesRef` gives the current count
      // without reading through state; each async append re-checks the cap functionally.
      const intake = screenFiles(files, imagesRef.current.length, attachedImageBytes(imagesRef.current))
      // A size or count limit the user can act on, not a failure (telemetry eab86832, 08cc6528).
      for (const reason of intake.rejected) toast(reason, { tone: 'danger', expected: true })
      for (const file of intake.accepted) {
        void fileToPendingAttachment(file, source).then((attachment) => {
          const next = appendAttachment(imagesRef.current, attachment)
          if (!next) return
          // Upload now, while the user is still typing, so the send only names it (7054e5f2).
          void stageAttachment(attachment)
          setImages(next)
        }, (error: unknown) => {
          // A dropped folder, or a file gone before it was read, rejects `arrayBuffer()` with
          // NotFoundError (WebKit: "The object can not be found here.", telemetry 159014d3).
          const gone = error instanceof DOMException && error.name === 'NotFoundError'
          toast(`“${file.name}” could not be read${gone ? ' — a folder, or a file that no longer exists' : ''}`, {
            tone: 'danger',
            expected: gone,
          })
        })
      }
    },
    [attachments, disabled],
  )

  const onPaste = (event: ClipboardEvent) => {
    if (!attachments) return
    // `kind: 'file'` rather than an `image/` type test (#950): the clipboard carries a pasted
    // `.md` as a file item too, and `screenFiles` is what decides whether cezar takes it. The
    // text half of the clipboard is left alone so an ordinary ⌘V still types.
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files, 'clipboard')
  }

  const acceptsDrop = attachments && !disabled
  const carriesFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files')

  const onDrop = (event: DragEvent) => {
    dragDepth.current = 0
    setDragging(false)
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const removeAttachment = (index: number, thumb: HTMLElement) => {
    const attachment = images[index]
    if (!attachment) return
    releaseStaged([attachment])
    // Keyboard focus moves on to the next thumbnail (or the field) instead of falling to <body>.
    // Only off the removed thumb: a tap keeps focus in the field (#2030), and it must stay there.
    if (document.activeElement === thumb) {
      pendingThumbFocus.current = images.length > 1 ? Math.min(index, images.length - 2) : -1
    }
    setImages((current) => current.filter((_, i) => i !== index))
  }

  useLayoutEffect(() => {
    const at = pendingThumbFocus.current
    if (at === null) return
    pendingThumbFocus.current = null
    const thumbs = rootRef.current?.querySelectorAll<HTMLElement>('[data-slot="composer-thumb"]')
    const target = (at >= 0 ? thumbs?.[at] : undefined) ?? textareaRef.current
    target?.focus({ preventScroll: true })
  }, [images])

  // A pressed Send, Stop or dictation button vanishes or disables under the focus; hand it back
  // to the field. Not on a phone, where focusing the field would raise the keyboard.
  const refocusField = () => {
    const el = textareaRef.current
    const active = document.activeElement
    if (!el || newlineOnEnter || active === el || !rootRef.current?.contains(active)) return
    el.focus({ preventScroll: true })
  }

  // ---- submit --------------------------------------------------------------------------------

  const send = useCallback(
    async (
      messageText: string,
      messageImages: PendingAttachment[],
      restoreOnError: boolean,
      meta?: ComposerSubmitMeta,
    ) => {
      const body = messageText.trim()
      if (disabled || submitDisabled || busy) return
      if (body === '' && messageImages.length === 0 && !allowEmptySubmit) return
      setBusy(true)
      try {
        // `meta` only when there is something to say, so an ordinary send keeps its two-argument call.
        await sendWithStaged(messageImages, (attachments) =>
          meta ? onSubmit(body, attachments, meta) : onSubmit(body, attachments),
        )
        releaseStaged(messageImages)
        trackAttachmentsSent(messageImages.length)
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        // The queued follow-up would overtake the message that failed; let the user re-send both.
        setQueued(false)
        if (restoreOnError) {
          // The optimistic clear already happened — put the message back, in front of anything
          // typed since, so nothing the user wrote is lost.
          setText((current) => (current === '' ? messageText : `${messageText}\n${current}`))
          // Outside the updater (StrictMode double-invokes it): what was attached since the send
          // goes back behind the message's own, within both caps — and a drop is said, not silent.
          const dropped: PendingAttachment[] = []
          const restored = imagesRef.current.reduce((list, a) => {
            const next = appendAttachment(list, a)
            if (!next) dropped.push(a)
            return next ?? list
          }, messageImages)
          for (const a of dropped) toast(`“${a.name}” removed — the restored message fills the attachment limit`, { tone: 'danger' })
          setImages(restored)
        }
      } finally {
        setBusy(false)
      }
    },
    [allowEmptySubmit, busy, disabled, submitDisabled, onSubmit],
  )

  const submitDraft = useCallback(() => {
    if (disabled || submitDisabled) return
    if (text.trim() === '' && images.length === 0 && !allowEmptySubmit) return
    if (busy) {
      setQueued(true)
      setTrigger(null)
      return
    }
    const draftText = text
    const draftImages = images
    // Optimistic clear — the reply feels instant; a rejection restores it above. Tagged `submit`
    // so a controlled host does not mistake it for the user emptying the composer by hand.
    setText('')
    setImages([], 'submit')
    setTrigger(null)
    void send(draftText, draftImages, true)
  }, [allowEmptySubmit, busy, disabled, submitDisabled, images, send, text])

  useEffect(() => {
    if (busy || !queued) return
    setQueued(false)
    submitDraft()
  }, [busy, queued, submitDraft])

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
        // A fixed command typed out in full is finished: Enter runs it, not a completion of itself.
        if (active && slashCommands && event.key === 'Enter' && trigger?.query === active.insert) {
          closeMenu()
        } else if (active) {
          event.preventDefault()
          pick(active)
          return
        }
        // No match to accept: the menu is inert — close it and let Enter mean "send".
        closeMenu()
      }
    }
    // `/` focuses the composer from anywhere in the task; Escape gives the keyboard back to the
    // page, draft kept (spec 2026-10-17-task-palette). Not mid-IME: there Escape cancels the
    // composition. No preventDefault, so a dialog around the composer still closes on it.
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.currentTarget.blur()
      return
    }
    const shouldSend = composerEnterSends({
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    }, newlineOnEnter)
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
      void send(reply, [], false, { quickReply: true })
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [disabled, quickReplies, send])

  // ---- dictation actions -----------------------------------------------------------------------

  const insertTranscript = (alsoSend: boolean) => {
    const transcript = dictation.finish()
    if (transcript === '') return
    const merged = text.trim() === '' ? transcript : `${text.replace(/\s*$/, '')} ${transcript}`
    if (alsoSend && busy) {
      setText(merged)
      setQueued(true)
      return
    }
    if (alsoSend) {
      setText('')
      setImages([], 'submit')
      void send(merged, images, true)
      return
    }
    setText(merged)
    pendingCaretRef.current = merged.length
    textareaRef.current?.focus()
  }

  const recording = dictation.recording
  const hasDraft = text.trim() !== '' || images.length > 0 || allowEmptySubmit
  // Busy alone never disables Send: pressing it then queues the draft (see `queued`).
  const sendDisabled =
    disabled || submitDisabled || !hasDraft
  const sendButtonElement = (
    <Button
      type="button"
      size={sendLabel ? "sm" : "icon-sm"}
      variant={compact ? 'contrast' : undefined}
      aria-label={sendAriaLabel}
      aria-busy={busy || undefined}
      data-queued={queued || undefined}
      disabled={sendDisabled}
      className={cn(
        compact ? 'h-10 w-auto gap-1.5 rounded-full px-4 pointer-coarse:max-md:h-11 md:size-8 md:rounded-md md:px-0' : sendLabel ? 'h-8 pointer-coarse:max-md:h-11' : 'size-8 pointer-coarse:max-md:size-11',
        // The default half-opacity lime (or inverse) wash nearly vanished on a light card; a
        // neutral fill with full-strength muted ink keeps the disabled control legible.
        'disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-[inset_0_0_0_1px_var(--border)]',
      )}
      onClick={() => {
        submitDraft()
        refocusField()
      }}
    >
      {busy ? <Spinner className="text-current" /> : <ArrowUpIcon aria-hidden="true" />}{sendLabel}
      {compact ? <span className="md:hidden">Send</span> : null}
    </Button>
  )
  // The chord goes in the tooltip, not on the button — the way GitHub and Linear show it. A
  // phone's Enter is a newline, so a hardware keyboard there sends with the chord.
  const shortcutShown = sendShortcut && newlineOnEnter ? submitShortcutHint() : sendShortcut
  const sendButton = shortcutShown ? (
    <IconTooltip
      side="top"
      label={
        <span data-slot="composer-send-shortcut" className="flex items-center gap-2">
          {sendLabel ?? sendAriaLabel}
          <kbd className="font-sans opacity-70">{shortcutShown}</kbd>
        </span>
      }
    >
      {sendButtonElement}
    </IconTooltip>
  ) : sendButtonElement

  // Icon-only in both layouts: the mic acts on the text, like the paperclip beside it.
  const micClass = compact
    ? 'size-10 rounded-full bg-muted text-muted-foreground pointer-coarse:max-md:size-11 md:size-8 md:rounded-md md:bg-transparent'
    : 'size-8 text-muted-foreground pointer-coarse:max-md:size-11'
  const micIcon = <MicIcon aria-hidden="true" className={compact ? 'size-4' : 'size-[15px]'} />
  const micControl = dictation.supported && dictation.unavailable ? (
    // aria-disabled, not disabled: a disabled button never gets the hover/focus
    // that opens the tooltip saying why.
    <IconTooltip label={dictation.unavailable} side="top">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-disabled="true"
        aria-label="Start dictation"
        className={cn(micClass, 'cursor-not-allowed opacity-50 hover:bg-transparent')}
      >
        {micIcon}
      </Button>
    </IconTooltip>
  ) : dictation.supported ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      aria-label="Start dictation"
      title="Dictation"
      className={micClass}
      onClick={() => {
        // The recording bar replaces the control row, Options button included.
        options?.onOpenChange?.(false)
        dictation.start()
      }}
    >
      {micIcon}
    </Button>
  ) : null
  // The composer's own Options row: which language the mic listens in. Per browser, like the
  // mic itself — it is about the speaker, not the project.
  const languageRow: ComposerOptionRow | null = dictation.supported
    ? {
        id: 'language',
        label: 'Language',
        control: (
          <Select value={dictationLanguage} onValueChange={setDictationLanguage} disabled={disabled}>
            <SelectTrigger
              size="sm"
              aria-label="Dictation language"
              title="Dictation language"
              className="max-w-44 gap-1 px-2 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dictationLanguageOptions().map((o) => (
                <SelectItem key={o.tag} value={o.tag}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ),
      }
    : null
  const optionsControl = compact ? null : (
    <ComposerOptions
      eyebrow={options?.eyebrow}
      rows={[...(options?.rows ?? []), ...(languageRow ? [languageRow] : [])]}
      note={options?.note}
      onReset={options?.onReset}
      open={options?.open}
      onOpenChange={options?.onOpenChange}
      onOpenAutoFocus={options?.onOpenAutoFocus}
    />
  )
  // The chord beside Send (`⌘↵` in the mockup): a hint for a keyboard, so a phone keeps it out.
  const sendHint = shortcutShown ? (
    <Kbd data-slot="composer-send-hint" className="max-md:hidden">{shortcutShown}</Kbd>
  ) : null
  // Stop stays on screen for as long as the agent works — typing a message adds Send
  // beside it rather than replacing it, so stopping never means clearing the draft.
  const stopControl = stop ? (
    <IconTooltip label={stop.label} side="top">
      <Button
        type="button"
        size="icon-sm"
        variant="contrast"
        data-slot="composer-stop"
        aria-label={stop.label}
        disabled={stop.pending}
        className={compact ? 'size-10 rounded-full pointer-coarse:max-md:size-11 md:size-8 md:rounded-md' : 'size-8 pointer-coarse:max-md:size-11'}
        onClick={() => {
          stop.onStop()
          refocusField()
        }}
      >
        <SquareIcon aria-hidden="true" className="size-3 fill-current" />
      </Button>
    </IconTooltip>
  ) : null
  const sendControl = sendButton
  const field = (
    <textarea
      ref={textareaRef}
      // `rows` is the phone case's floor, not the height: it is deliberately not
      // responsive, so the height comes from the `min-h`/`md:min-h` pair below (44px
      // phone, 54px desktop) and from the `useLayoutEffect` autosize pass. On desktop
      // that means one intrinsic row for the single paint before autosize runs, which
      // `md:min-h-[54px]` already bounds. This textarea is shared with `/new`.
      rows={1}
      value={text}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={disabled ? undefined : hintId}
      aria-keyshortcuts={newlineOnEnter ? 'Meta+Enter Control+Enter' : 'Enter Meta+Enter Control+Enter'}
      // The soft keyboard's key says what Enter does here: a return key on a phone.
      enterKeyHint={newlineOnEnter ? 'enter' : 'send'}
      placeholder={disabled ? disabledReason : placeholder}
      // 16px on touch widths — iOS zooms any focused input below 16px (spec mobile rule).
      className={cn(
        'block max-h-[220px] w-full resize-none bg-transparent text-base leading-normal outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm',
        compact
          // A third of what the keyboard leaves visible; autosize still stops at 220px.
          ? 'order-first min-h-11 min-w-0 basis-full px-2 py-1.5 max-md:max-h-[calc((100dvh-var(--kb,0px))*0.35)] md:order-none md:min-h-9 md:flex-1 md:basis-auto md:px-1.5'
          : 'min-h-11 px-3 pt-2.5 pb-1 md:min-h-[54px] md:px-4 md:pt-3',
      )}
      onChange={(event) => {
        setText(event.target.value)
        syncTrigger()
      }}
      onKeyDown={onKeyDown}
      onSelect={syncTrigger}
      onPaste={onPaste}
    />
  )

  return (
    <Popover open={menuOpen} onOpenChange={(open) => (open ? undefined : closeMenu())}>
      <PopoverAnchor asChild>
        <div
          ref={rootRef}
          data-slot="composer"
          data-disabled={disabled || undefined}
          onDrop={onDrop}
          onDragOver={(event) => event.preventDefault()}
          onDragEnter={(event) => {
            if (!acceptsDrop || !carriesFiles(event)) return
            dragDepth.current += 1
            setDragging(true)
          }}
          onDragLeave={() => {
            if (dragDepth.current === 0) return
            dragDepth.current -= 1
            if (dragDepth.current === 0) setDragging(false)
          }}
          data-dragging={dragging || undefined}
          // Pressing one of the composer's buttons never takes focus from the field: on a phone the
          // blur closed the keyboard and shifted the layout before the click, so the first tap on
          // Send only hid the keyboard. The keyboard now stays up after sending, as in chat apps.
          onMouseDown={(event) => {
            const button = (event.target as Element).closest('button')
            if (button && rootRef.current?.contains(button) && document.activeElement === textareaRef.current) {
              event.preventDefault()
            }
          }}
          className={cn(
            compact ? 'rounded-[1.75rem] md:rounded-xl' : 'rounded-xl',
            'border border-border bg-card shadow-xs transition-[border-color,box-shadow]',
            'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15',
            disabled && 'opacity-80',
            dragging && 'border-primary ring-[3px] ring-primary/20',
          )}
        >
          <span role="status" className="sr-only">
            {queued ? 'Queued — sends when the previous message lands.' : busy ? 'Sending…' : ''}
          </span>
          <span id={hintId} className="sr-only">
            {newlineOnEnter ? 'Return adds a new line. Use the Send button to send.' : 'Enter sends. Shift+Enter adds a new line.'}
          </span>
          {images.length > 0 || draftItems ? (
            <div data-slot="composer-thumbs" className="flex flex-wrap items-center gap-2 px-4 pt-3">
              {draftItems}
              {images.map((attachment, index) => (
                <button
                  key={`${attachment.name}-${index}`}
                  type="button"
                  data-slot="composer-thumb"
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove"
                  className={cn(
                    'group relative overflow-hidden rounded-md border border-border',
                    attachment.isImage
                      ? 'size-12'
                      : 'flex h-12 max-w-[200px] items-center gap-1.5 bg-muted/40 px-2.5 text-xs text-muted-foreground no-hover:pr-6',
                  )}
                  onClick={(event) => removeAttachment(index, event.currentTarget)}
                >
                  {/* An image previews; a file (#950) has nothing to look at, so it gets its own
                      name instead — the one place the user's filename is used at all. */}
                  {attachment.isImage ? (
                    <img src={attachment.preview} alt="" className="size-full object-cover" />
                  ) : (
                    <>
                      <PaperclipIcon aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="truncate">{attachment.name}</span>
                    </>
                  )}
                  <span className="absolute inset-0 hidden items-center justify-center bg-background/70 group-hover:flex group-focus-visible:flex no-hover:group-hover:hidden">
                    <XIcon aria-hidden="true" className="size-4" />
                  </span>
                  {/* No hover to reveal the ✕ on a touch screen: a corner badge says a tap removes it. */}
                  <span
                    aria-hidden="true"
                    className="absolute top-0.5 right-0.5 hidden size-4 items-center justify-center rounded-full bg-foreground/75 text-background no-hover:flex"
                  >
                    <XIcon className="size-3" />
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {compact ? (
            <div data-slot="composer-compact-row" className="flex flex-wrap items-end gap-1.5 p-2 md:flex-nowrap md:gap-1 md:px-1.5 md:py-1">
              {attachments ? <AttachButton disabled={disabled} onFiles={addFiles} compact /> : null}
              {footerStart}
              {footerEnd ? <div className="min-w-0 md:hidden">{footerEnd}</div> : null}
              {field}
              {recording ? null : (
                <div className="ml-auto flex shrink-0 items-center gap-1.5 md:ml-0 md:gap-1 md:pb-0.5">
                  {micControl}
                  {stopControl}
                  <div data-slot="composer-compact-send" className={hasDraft ? 'contents' : stop ? 'hidden' : 'contents md:hidden'}>
                    {sendControl}
                  </div>
                </div>
              )}
            </div>
          ) : field}

          {recording ? (
            <DictationBar
              transcript={recording.transcript}
              startedAt={recording.startedAt}
              onCancel={dictation.cancel}
              onInsert={() => insertTranscript(false)}
              onInsertAndSend={() => insertTranscript(true)}
            />
          ) : compact ? null : (
            // The row may WRAP (a phone), but the trailing controls stay one unbreakable group
            // so the send button never strands alone.
            <div data-slot="composer-controls" className="flex flex-wrap items-center gap-1 gap-y-1 px-1.5 pt-1 pb-1.5 md:gap-y-1.5 md:px-2 md:pt-1.5 md:pb-2">
              {/* The paperclip and mic share ONE wrapping row with the pills — otherwise the
                  pill group is a single flex item that wraps as a block, stranding the
                  icons alone on the line above it (#composer-attach-line). */}
              <div data-slot="composer-footer-start" className="flex min-w-0 flex-wrap items-center gap-1">
                {attachments ? <AttachButton disabled={disabled} onFiles={addFiles} /> : null}
                {micControl}
                {footerStart}
                {optionsControl}
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                {footerEnd ? (
                  <div data-slot="composer-footer-end" className="flex items-center gap-1.5">
                    {footerEnd}
                  </div>
                ) : null}
                {stopControl}
                {sendHint}
                {/* With Stop showing, Send appears only once there is something to send: an empty box
                    over a working agent offers exactly one action. */}
                {!stop || hasDraft ? sendControl : null}
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
                  : slashCommands
                    ? 'No matching commands.'
                    : skills.isPending
                      ? 'Loading skills…'
                      : 'No matching skills.'}
              </p>
            ) : (
              candidates.map((candidate) => (
                <CommandItem
                  key={candidate.value}
                  ref={(el) => {
                    if (el) menuItemRefs.current.set(candidate.value, el)
                    else menuItemRefs.current.delete(candidate.value)
                  }}
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
  compact = false,
}: {
  disabled: boolean
  onFiles: (files: readonly File[]) => void
  compact?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Attach files"
        title="Attach images or files (or paste a screenshot)"
        disabled={disabled}
        className={compact
          ? 'size-10 shrink-0 rounded-full bg-muted text-muted-foreground pointer-coarse:max-md:size-11 md:mb-0.5 md:size-8 md:rounded-md md:bg-transparent'
          : 'size-8 text-muted-foreground pointer-coarse:max-md:size-11'}
        onClick={() => inputRef.current?.click()}
      >
        {compact ? <PlusIcon aria-hidden="true" className="size-4" /> : <PaperclipIcon aria-hidden="true" className="size-[15px]" />}
      </Button>
      {/* No `accept`: every file is taken (telemetry 48850f4a), and a filter greyed out ones the
          composer would have accepted anyway (#950). */}
      <input
        ref={inputRef}
        type="file"
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
