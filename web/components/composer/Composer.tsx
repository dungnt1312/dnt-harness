import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { useToast } from '../common/Toast.tsx'
import { AttachmentTray } from './AttachmentTray.tsx'
import { CompletionPopover } from './CompletionPopover.tsx'
import { AttachMenu, ControlsStatus, ModeMenu } from './ComposerControls.tsx'
import { ComposerNotices, type ComposerNotice } from './ComposerNotices.tsx'
import { RichInput, type CaretBookmark, type RichInputHandle } from './RichInput.tsx'
import { ThinkingMenu } from './ThinkingMenu.tsx'
import { SAFE_MODEL_VISIBLE_BYTES, utf8Bytes } from './paste-classification.ts'
import { useUploadQueue } from './useUploadQueue.ts'
import { cn } from '../../lib/cn.ts'
import { decodeModelChoice } from '../../lib/providers.ts'
import {
  builtinCompletionItem,
  completionAt,
  moveActive,
  rankSkills,
  skillCompletionItem,
  type CompletionItem,
  type CompletionRequest,
} from '../../lib/composer-completion.ts'
import { BUILTIN_COMMANDS, isBuiltinCommand } from '../../lib/inline-chips.ts'
import {
  appendAttachments,
  draftIsEmpty,
  draftText,
  messageDraft,
  removeAttachment,
  type AttachmentRef,
  type DraftSegment,
  type RichDraft,
} from '../../lib/composer-draft.ts'
import type { ModelSettings } from '../../lib/types.ts'

/** Keystrokes settle before a file search leaves for the server. */
const SEARCH_DEBOUNCE_MS = 120
/** Suggestions listed at once, for both menus. */
const MAX_SUGGESTIONS = 12
/** How long "Attachment removed · Undo" stays offered. */
const UNDO_TIMEOUT_MS = 6000
const UPLOAD_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,text/*,application/json,application/xml'
const OVERSIZED_MESSAGE = 'Pasted text exceeds the 60,000-byte limit. Shorten or remove it before sending.'
/** Fallback when the caret could not be bookmarked: the start of the draft. */
const DRAFT_START: CaretBookmark = { offset: 0, revision: -1 }

/** One workspace skill offered by the `/` menu. */
export interface SkillOption {
  readonly name: string
  readonly description?: string
}

/** Pasted text that became an attachment and can still be put back inline. */
interface Recovery {
  readonly text: string
  readonly bookmark: CaretBookmark | null
}

/** A mid-size paste kept inline, with an offer to move it into an attachment. */
interface Conversion {
  readonly text: string
  readonly bookmark: CaretBookmark | null
}

interface RemovedAttachment {
  readonly attachment: AttachmentRef
  readonly index: number
}

const signature = (request: CompletionRequest): string => `${request.kind}:${request.start}:${request.query}`

const pastedTextFile = (text: string, date = new Date()): File => {
  const pad = (value: number): string => value.toString().padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  return new File([text], `pasted-text-${stamp}.txt`, { type: 'text/plain' })
}

/**
 * Message composer: notices, the attachment tray and a rich input over a
 * control row — attach, mode and thinking on the left; the model picker, Stop
 * and Send/Queue on the right. The conversation's folder lives in the chat
 * header, not here.
 *
 * Enter sends and Shift+Enter breaks a line; Ctrl/Cmd+Enter always sends.
 * While a turn runs, sending queues a follow-up. The input is disabled only by
 * a missing model — never by a lost connection.
 *
 * Typing `@` suggests project files and `/` (at the start of a draft) suggests
 * workspace skills; both become inline chips. Pasted, dropped or chosen files
 * upload into the tray. Long pasted text uploads as a text attachment that can
 * be put back inline; ArrowUp on an empty draft recalls the last message.
 */
export function Composer({
  workspaceId = null, modelControl, contextControl, connected, sending = false, running,
  draft, onDraft, onSend, onStop, onCommand,
  modelValue, thinkingValue = null, modelSettings, onThinking, thinkingMenuLabel, thinkingDisabled = false,
  controlsUnavailable = false, controlsUnavailableMessage, onRetryControls,
  modes, modeValue, onMode,
  onSearchFiles, onUploadFiles, skills, onRecallLast, autoFocus = false,
}: {
  readonly workspaceId?: string | null
  /** Model picker, owned by the app; shown beside Send. */
  readonly modelControl?: ReactNode
  /** Context-window meter, owned by the app; shown before the model picker. */
  readonly contextControl?: ReactNode
  readonly sending?: boolean
  readonly connected: boolean
  readonly running: boolean
  readonly draft: RichDraft
  readonly onDraft: (draft: RichDraft) => void
  /** `steer` stops the running turn and runs the queue now (Ctrl/Cmd+Enter while running). */
  readonly onSend: (delivery?: 'queue' | 'steer') => void
  readonly onStop: () => void
  /** A built-in command was picked: the host executes it at once; nothing lands in the draft. */
  readonly onCommand?: (name: string) => void
  readonly modelValue: string | null
  /** Workspace thinking override; null = the model's configured default. */
  readonly thinkingValue?: string | null
  /** Per-model settings of the ACTIVE provider, for the thinking default. */
  readonly modelSettings?: Readonly<Record<string, ModelSettings>>
  readonly onThinking?: (level: string | null) => void
  readonly thinkingMenuLabel?: string
  readonly thinkingDisabled?: boolean
  /** Session controls are loading or failed; sending waits for them. */
  readonly controlsUnavailable?: boolean
  readonly controlsUnavailableMessage?: string
  readonly onRetryControls?: () => void
  readonly modes: readonly { readonly value: string; readonly label: string }[]
  readonly modeValue: string | null
  readonly onMode: (value: string) => void
  /** Absent without a project: `@` then has no files to offer. */
  readonly onSearchFiles?: (query: string) => Promise<readonly CompletionItem[]>
  /**
   * Store files and return their references. Absent means this conversation
   * cannot take uploads, and the attach control is not offered.
   */
  readonly onUploadFiles?: (files: readonly File[]) => Promise<readonly AttachmentRef[]>
  /** Workspace skill catalog for the `/` menu. */
  readonly skills?: readonly SkillOption[]
  /** Newest own message, for ArrowUp on an empty draft. */
  readonly onRecallLast?: () => string | null
  readonly autoFocus?: boolean
}) {
  const editor = useRef<RichInputHandle | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  // Upload and undo callbacks settle after later edits, so they build on the
  // latest draft rather than the one captured when they started.
  const draftRef = useRef(draft)
  const emittedDraft = useRef<RichDraft | null>(null)
  const uploads = useUploadQueue()
  const { notify } = useToast()
  const hintId = useId()
  const modelHintId = useId()
  const listId = useId()

  const [recoveries, setRecoveries] = useState<ReadonlyMap<string, Recovery>>(new Map())
  const [conversion, setConversion] = useState<Conversion | null>(null)
  const [removed, setRemoved] = useState<RemovedAttachment | null>(null)
  // Set when Enter was pressed but sending was blocked; cleared by the next edit.
  const [blockedAttempt, setBlockedAttempt] = useState(false)

  const [request, setRequest] = useState<CompletionRequest | null>(null)
  const [items, setItems] = useState<readonly CompletionItem[]>([])
  const [active, setActive] = useState(0)
  const [searching, setSearching] = useState(false)
  // Escape closes the list until the query itself changes.
  const [dismissed, setDismissed] = useState<string | null>(null)

  const missingModel = modelValue === null
  const empty = draftIsEmpty(draft)
  const oversized = useMemo(() => utf8Bytes(draftText(draft)) > SAFE_MODEL_VISIBLE_BYTES, [draft])
  const uploading = uploads.pending > 0
  const eligible = !empty && connected && !missingModel && !controlsUnavailable && !uploading && !oversized

  // A draft we did not emit replaced ours (sent, recalled, switched
  // conversation): in-flight uploads and paste offers belong to the old one.
  const { reset: resetUploads } = uploads
  useEffect(() => {
    if (emittedDraft.current !== draft) {
      resetUploads()
      setRecoveries(new Map())
      setConversion(null)
      setRemoved(null)
    }
    draftRef.current = draft
    emittedDraft.current = draft
  }, [draft, resetUploads])

  useEffect(() => {
    if (removed === null) return
    const timer = setTimeout(() => setRemoved(null), UNDO_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [removed])

  const emit = (next: RichDraft): void => {
    draftRef.current = next
    emittedDraft.current = next
    setBlockedAttempt(false)
    onDraft(next)
  }

  const dropRecovery = (id: string): void => {
    setRecoveries((current) => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }

  // ── Completion (`@` files, `/` skills) ─────────────────────────────────

  // A menu with no source stays shut: `@` needs a project. `/` opens for the
  // workspace skill catalog AND for the built-in commands, which are always
  // there — `/compact` must not depend on the workspace having skills.
  const available = request === null ? false : request.kind === 'file' ? onSearchFiles !== undefined : true
  const open = request !== null && available && dismissed !== signature(request)
  const fileSearch = open && request?.kind === 'file' ? onSearchFiles : undefined
  const fileQuery = request?.kind === 'file' ? request.query : null

  // Only file suggestions go to the server; a stale response never overwrites
  // a newer query.
  useEffect(() => {
    if (fileSearch === undefined || fileQuery === null) return
    let live = true
    setSearching(true)
    const timer = setTimeout(() => {
      void fileSearch(fileQuery)
        .then((found) => { if (live) { setItems(found.slice(0, MAX_SUGGESTIONS)); setActive(0) } })
        .catch(() => { if (live) setItems([]) })
        .finally(() => { if (live) setSearching(false) })
    }, SEARCH_DEBOUNCE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [fileSearch, fileQuery])

  useEffect(() => {
    if (!open || request?.kind !== 'skill') return
    // Built-in commands first, then the catalog. A skill whose name is a
    // reserved command is shadowed: the namespace belongs to the host, so
    // `/compact` can never silently degrade into a skill mention.
    const skillItems = rankSkills(
      (skills ?? []).filter((skill) => !isBuiltinCommand(skill.name)),
      request.query,
      MAX_SUGGESTIONS,
    ).map(skillCompletionItem)
    const commands = rankSkills(BUILTIN_COMMANDS, request.query, MAX_SUGGESTIONS).map(builtinCompletionItem)
    setItems([...commands, ...skillItems].slice(0, MAX_SUGGESTIONS))
    setActive(0)
    setSearching(false)
  }, [open, request?.kind, request?.query, skills])

  /**
   * Re-read the caret and decide which menu, if any, belongs open. Triggers
   * are matched inside the caret's own text node, so a chip beside the caret
   * cannot be read as part of the query.
   */
  const syncCompletion = (): void => {
    const caret = editor.current?.caretContext() ?? null
    const next = caret === null ? null : completionAt(caret.text, caret.offset)
    setRequest(next)
    if (next === null) { setItems([]); setSearching(false) }
  }

  const pick = (item: CompletionItem): void => {
    if (request === null) return
    setRequest(null)
    setItems([])
    setSearching(false)
    // Built-in commands execute the moment they are picked: a host action has
    // no business sitting in the draft waiting for a second send. The typed
    // trigger text is deleted, then only the editor focus stays ours to
    // return.
    if (item.id.startsWith('command:')) {
      editor.current?.replaceAtCaret(request.start, request.end, { kind: 'text', text: '' })
      editor.current?.focus()
      onCommand?.(item.segment?.kind === 'command' ? item.segment.name : item.label.replace(/^\//, ''))
      return
    }
    const segment: DraftSegment = item.segment ?? { kind: 'text', text: `${item.insert} ` }
    editor.current?.replaceAtCaret(request.start, request.end, segment)
  }

  const mentionFile = (): void => {
    editor.current?.focus()
    editor.current?.insertAtCaret({ kind: 'text', text: '@' })
    syncCompletion()
  }

  // ── Attachments ────────────────────────────────────────────────────────

  const uploadFiles = (files: readonly File[]): void => {
    if (onUploadFiles === undefined || files.length === 0) return
    uploads.enqueue(onUploadFiles(files), (outcome) => {
      if (!outcome.ok) notify('Upload failed')
      else if (outcome.refs.length === 0) notify('Upload returned no attachments')
      else emit(appendAttachments(draftRef.current, outcome.refs))
    })
  }

  /**
   * Upload pasted text as a file. On success it can be put back inline once;
   * on failure the text returns to where it was pasted so nothing is lost.
   */
  const uploadPastedText = (text: string, bookmark: CaretBookmark | null): void => {
    if (onUploadFiles === undefined) return
    uploads.enqueue(onUploadFiles([pastedTextFile(text)]), (outcome) => {
      const ref = outcome.ok ? outcome.refs[0] : undefined
      if (ref === undefined) {
        const restored = editor.current?.insertAtBookmark(bookmark ?? DRAFT_START, { kind: 'text', text }) ?? false
        notify(restored ? 'Upload failed — pasted text was kept inline' : 'Upload failed and pasted text could not be restored')
        return
      }
      setRecoveries((current) => new Map(current).set(ref.id, { text, bookmark }))
      emit(appendAttachments(draftRef.current, outcome.ok ? outcome.refs : []))
    })
  }

  const convertPaste = (): void => {
    if (conversion === null || editor.current === null) return
    const { text, bookmark } = conversion
    setConversion(null)
    if (!editor.current.replaceTextAtBookmark(bookmark ?? DRAFT_START, text, '')) {
      notify('Cannot convert pasted text after the editor changed')
      return
    }
    // The post-removal caret is where the text goes back on failure or on
    // Insert back.
    uploadPastedText(text, editor.current.bookmark())
  }

  const insertBack = (attachment: AttachmentRef): void => {
    const saved = recoveries.get(attachment.id)
    if (saved === undefined || editor.current === null) return
    const segments = editor.current.segmentsWithInsertAtBookmark(saved.bookmark ?? DRAFT_START, { kind: 'text', text: saved.text })
    dropRecovery(attachment.id)
    if (segments === null) {
      notify('Cannot insert pasted text after the editor changed')
      return
    }
    // One draft transition: the text comes back and the attachment leaves.
    const next = { segments, attachments: draftRef.current.attachments.filter((item) => item.id !== attachment.id) }
    editor.current.setDraft(next)
    emit(next)
  }

  const removeFromTray = (attachment: AttachmentRef): void => {
    const index = draftRef.current.attachments.findIndex((item) => item.id === attachment.id)
    if (index < 0) return
    emit(removeAttachment(draftRef.current, attachment.id))
    dropRecovery(attachment.id)
    setRemoved({ attachment, index })
  }

  const undoRemove = (): void => {
    if (removed === null) return
    const attachments = [...draftRef.current.attachments]
    attachments.splice(removed.index, 0, removed.attachment)
    emit({ segments: draftRef.current.segments, attachments })
    setRemoved(null)
  }

  // ── Sending ────────────────────────────────────────────────────────────

  // Why Send is blocked, when nothing else on screen already says so.
  const blockedReason = controlsUnavailable
    ? `Cannot send yet: ${controlsUnavailableMessage ?? 'conversation controls are unavailable.'}`
    : !connected
      ? 'Cannot send while reconnecting. Your draft is kept.'
      : uploading
        ? 'Cannot send until files finish uploading.'
        : null

  const submit = (delivery: 'queue' | 'steer' = 'queue'): void => {
    if (sending) return
    if (!eligible) { setBlockedAttempt(true); return }
    setBlockedAttempt(false)
    // Steer only means something while a turn runs; idle, it is a plain send.
    onSend(running ? delivery : 'queue')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    // Keys on controls inside the editor (a chip's remove button) are theirs.
    const target = event.target as HTMLElement
    if (target.closest('button,input,select,textarea,a,[contenteditable="false"]') !== null) return

    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => moveActive(index, event.key === 'ArrowDown' ? 1 : -1, items.length))
        return
      }
      const item = items[active]
      if ((event.key === 'Enter' || event.key === 'Tab') && item !== undefined) {
        event.preventDefault()
        pick(item)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (request !== null) setDismissed(signature(request))
        return
      }
    }

    if (event.key === 'ArrowUp' && empty && onRecallLast !== undefined) {
      const recalled = onRecallLast()
      if (recalled !== null && recalled !== '') {
        event.preventDefault()
        const next = messageDraft(recalled)
        editor.current?.setDraft(next)
        emit(next)
        return
      }
    }

    if (event.key === 'Enter' && (!event.shiftKey || event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      // Enter queues; Ctrl/Cmd+Enter steers (stop + run now) while running.
      submit(event.ctrlKey || event.metaKey ? 'steer' : 'queue')
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const showBlocked = blockedAttempt && blockedReason !== null
  const notices: ComposerNotice[] = []
  if (missingModel) notices.push({ key: 'model', id: modelHintId, tone: 'warn', text: 'Configure a provider in Settings to send messages.' })
  if (oversized) notices.push({ key: 'oversized', tone: 'bad', text: OVERSIZED_MESSAGE })
  if (blockedAttempt && blockedReason !== null) notices.push({ key: 'blocked', id: hintId, tone: 'warn', text: blockedReason, onDismiss: () => setBlockedAttempt(false) })
  if (conversion !== null) {
    notices.push({
      key: 'conversion',
      tone: 'info',
      text: 'Large paste kept inline.',
      action: { label: 'Convert to attachment', onClick: convertPaste },
      onDismiss: () => setConversion(null),
    })
  }
  if (removed !== null) {
    notices.push({
      key: 'removed',
      tone: 'info',
      text: `Removed ${removed.attachment.name}.`,
      action: { label: 'Undo', onClick: undoRemove },
      onDismiss: () => setRemoved(null),
    })
  }
  const describedBy = [missingModel ? modelHintId : null, showBlocked ? hintId : null].filter((id) => id !== null).join(' ')

  const placeholder = missingModel
    ? 'Draft now — configure a provider in Settings to send…'
    : running
      ? 'Queue a follow-up…'
      : !connected
        ? 'Reconnecting — your draft is kept…'
        : 'Ask anything'
  const modelId = modelValue !== null ? decodeModelChoice(modelValue)?.model ?? null : null

  return (
    <form
      // A container, so the footer answers to the composer's own width: the
      // column is far narrower than the viewport whenever the sidebar is open.
      className="@container relative flex flex-col rounded-[28px] border border-line bg-composer shadow-composer transition-colors focus-within:border-line-strong dark:border-transparent dark:focus-within:border-line-strong"
      aria-busy={uploading || undefined}
      onSubmit={(event) => { event.preventDefault(); submit() }}
    >
      {uploading ? (
        <p className="sr-only" role="status" aria-live="polite">
          Waiting for {uploads.pending} attachment{uploads.pending === 1 ? '' : 's'} to finish
        </p>
      ) : null}
      <ComposerNotices notices={notices} />
      {open && request !== null ? (
        <CompletionPopover
          id={listId}
          kind={request.kind}
          items={items}
          activeIndex={active}
          loading={searching}
          note={items.length > 0 ? null : searching ? 'Searching…' : request.kind === 'file' ? 'No matching file' : 'No matching skill'}
          onPick={pick}
          onActivate={setActive}
        />
      ) : null}
      <AttachmentTray
        attachments={draft.attachments}
        workspaceId={workspaceId}
        onRemove={removeFromTray}
        onInsertText={insertBack}
        canInsertText={(attachment) => recoveries.has(attachment.id)}
      />
      <RichInput
        ref={editor}
        draft={draft}
        autoFocus={autoFocus}
        placeholder={placeholder}
        // Never locked by product state: a draft can be written (and kept)
        // while a provider is still being configured. Send is the only gate.
        disabled={false}
        ariaLabel="Message"
        expanded={open}
        {...(open ? { listId } : {})}
        {...(open && items.length > 0 ? { activeOptionId: `${listId}-option-${active}` } : {})}
        {...(describedBy !== '' ? { ariaDescribedBy: describedBy } : {})}
        onChange={(next) => { emit(next); syncCompletion() }}
        onKeyDown={handleKeyDown}
        onFiles={uploadFiles}
        onTextAttachment={uploadPastedText}
        onConvertibleText={(text, bookmark) => setConversion({ text, bookmark })}
        // An oversized paste stays inline; the draft itself raises the notice.
        onPasteError={() => {}}
      />
      {/* One row once the composer itself is wide enough for six controls,
          two deliberate rows below that. The left cluster keeps its natural
          width and the right one absorbs the squeeze, so a long model name
          truncates instead of dropping every chip onto a line of its own. */}
      <div className="flex flex-col gap-1.5 px-2.5 pb-2.5 @min-[30rem]:flex-row @min-[30rem]:items-center @min-[30rem]:gap-1">
        <div className="flex min-w-0 flex-none items-center gap-0.5">
          {onUploadFiles !== undefined || onSearchFiles !== undefined ? (
            <AttachMenu
              uploading={uploading}
              onUpload={onUploadFiles !== undefined ? () => fileInput.current?.click() : undefined}
              onMention={onSearchFiles !== undefined ? mentionFile : undefined}
            />
          ) : null}
          {modeValue !== null && modes.length > 0 ? <ModeMenu modes={modes} value={modeValue} onChange={onMode} /> : null}
          {controlsUnavailable && controlsUnavailableMessage !== undefined ? (
            <ControlsStatus message={controlsUnavailableMessage} onRetry={onRetryControls} />
          ) : null}
        </div>
        {/* The run cluster sits next to Send: the model answers, and the
            thinking level is the model's own control — its levels come from
            that model's capability, so the two belong side by side. */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          {contextControl}
          {modelControl}
          {modelId !== null && onThinking !== undefined ? (
            <ThinkingMenu
              model={modelId}
              value={thinkingValue}
              disabled={thinkingDisabled}
              {...(thinkingMenuLabel !== undefined ? { menuLabel: thinkingMenuLabel } : {})}
              {...(modelSettings?.[modelId] !== undefined ? { settings: modelSettings[modelId] } : {})}
              onSelect={onThinking}
            />
          ) : null}
          {onUploadFiles !== undefined ? (
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={UPLOAD_ACCEPT}
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                uploadFiles(Array.from(event.target.files ?? []))
                // Clear, so choosing the same file twice still fires a change.
                event.target.value = ''
              }}
            />
          ) : null}
          {running ? (
            <button
              type="button"
              aria-label="Stop work"
              title="Stop"
              onClick={onStop}
              className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line-strong text-fg hover:bg-hover"
            >
              <Icon name="square" size={16} />
            </button>
          ) : null}
          {running && !empty ? (
            // Steer: stop the running turn, then run the queue with this
            // message last. Outlined so Queue stays the default action.
            <button
              type="button"
              aria-label="Steer — stop the current turn and send now"
              title="Steer — stop the current turn and send now (Ctrl/⌘+Enter)"
              disabled={!eligible || sending}
              onClick={() => submit('steer')}
              className="flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-line-strong px-3 text-fg hover:bg-hover disabled:opacity-30"
            >
              <Icon name="zap" size={15} strokeWidth={2.2} />
              <span className="text-[13px] font-medium">Steer</span>
            </button>
          ) : null}
          {!running || !empty ? (
            // While a turn runs the same button queues instead of sending, so
            // it says so: an identical arrow would read as "sent now".
            <button
              type="submit"
              aria-label={running ? 'Queue message' : 'Send'}
              title={running ? 'Queue — runs after the current turn (Enter)' : 'Send (Enter) · Shift+Enter for a new line'}
              disabled={!eligible || sending}
              className={cn(
                'flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary text-primary-fg transition-opacity hover:opacity-85 disabled:opacity-30',
                running ? 'px-3' : 'size-9',
              )}
            >
              {sending ? <Spinner size={14} className="border-primary-fg/40 border-t-primary-fg" /> : <Icon name={running ? 'clock' : 'arrowUp'} size={running ? 15 : 18} strokeWidth={2.2} />}
              {running ? <span className="text-[13px] font-medium">Queue</span> : null}
            </button>
          ) : null}
        </div>
      </div>
    </form>
  )
}
