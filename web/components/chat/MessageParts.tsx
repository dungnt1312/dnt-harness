import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import Icon, { type IconName } from '../common/Icon.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { DiffLines, LineCount, diffRowsFromEdit, diffRowsFromWrite, type DiffRow } from '../common/DiffLines.tsx'
import CopyButton from '../common/CopyButton.tsx'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Markdown } from '../../Markdown.tsx'
import { ThinkingPanel } from './ThinkingPanel.tsx'
import { useHoldScroll } from '../../hooks/useStickToBottom.ts'
import { budgetTone, contextFill, formatBytes, formatElapsed, formatTime, formatTokenCount } from '../../lib/format.ts'
import { isDenied, mcpServerOf, toolFacts, type ToolFacts } from '../../lib/tool-facts.ts'
import { ansiToHtml } from '../../lib/ansi.ts'
import { Section, ToolArguments, preClass } from './ToolArguments.tsx'
import { attachmentUrl, fetchContextBody, waitChild } from '../../lib/api.ts'
import { agentRoleIcon } from '../../lib/agent-icons.ts'
import { cn } from '../../lib/cn.ts'
import type { AttachmentRef } from '../../lib/composer-draft.ts'
import { parseMessageText } from '../../lib/inline-chips.ts'
import { InlineChip } from '../common/InlineChip.tsx'
import { ImageLightbox } from './ImageLightbox.tsx'
import type { ChildRow, ContextManifestView, ToolCall } from '../../lib/types.ts'
import type { ViewItem } from '../../lib/project.ts'
import type { OpenPathResolver } from '../../lib/project-paths.ts'
import type { TurnChanges } from '../../lib/turn-changes.ts'
import type { WorkbenchProject } from '../workbench/Workbench.tsx'
import type { ProcessRow } from '../../lib/processes-view.ts'
import { TurnChangesCard } from './TurnChangesCard.tsx'

/**
 * Live background-process state plus the way to its workbench detail view,
 * provided by the Transcript from the session's durable process events. A
 * background Bash call reads it to show what its process is doing now.
 */
export interface ProcessLink {
  readonly statuses: ReadonlyMap<string, ProcessRow>
  readonly open: (processId: string) => void
}

export const ProcessLinkContext = createContext<ProcessLink | null>(null)

/** The `proc_…` id a background Bash result reports, if this is one. */
export function backgroundProcessId(call: ToolCall, result: { readonly output: string } | undefined): string | undefined {
  if (call.args['run_in_background'] !== true) return undefined
  return result === undefined ? undefined : /id=(proc_[0-9a-f-]+)/.exec(result.output)?.[1]
}

/** Images render inline; anything else is named rather than previewed. */
const isImageAttachment = (ref: AttachmentRef): boolean => ref.mediaType.startsWith('image/')

/** Hover-revealed on fine pointers, always visible on touch and keyboard focus. */
const revealActions = 'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100'

/**
 * A delivered user message. Queued input never renders here: it waits on the
 * strip above the composer (QueuedBar) until a turn consumes it, at which
 * point the projection flips the twin in place and this shows the message.
 */
export const UserBubble = memo(function UserBubble({ item, workspaceId, onReuse }: {
  readonly item: Extract<ViewItem, { kind: 'user' }>
  /** Needed to fetch attachment bytes; without it they show as file chips. */
  readonly workspaceId?: string | null
  readonly onReuse?: (text: string) => void
}) {
  const notSent = item.notSent
  const attachments = item.attachments ?? []
  const [preview, setPreview] = useState<AttachmentRef | null>(null)
  // Queued input waits on the composer strip; here it would only duplicate it.
  if (item.queued === true) return null
  // Images sit above the bubble as bare thumbnails — nested inside the grey
  // bubble they read as a box within a box. Other files stay in the bubble.
  const images = workspaceId != null ? attachments.filter(isImageAttachment) : []
  const files = attachments.filter((ref) => !images.includes(ref))
  const hasBubble = item.content !== '' || files.length > 0
  return (
    <div className="group flex flex-col items-end gap-1.5" title={item.ts !== undefined ? formatTime(item.ts) : undefined}>
      {images.length > 0 && workspaceId != null ? (
        <ul className="m-0 flex max-w-[85%] list-none flex-wrap justify-end gap-1.5 p-0 sm:max-w-[70%]">
          {images.map((ref) => (
            <li key={ref.id}>
              <button
                type="button"
                onClick={() => setPreview(ref)}
                aria-label={`Preview ${ref.name}`}
                title={ref.name}
                className="block cursor-zoom-in overflow-hidden rounded-2xl bg-muted outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-line-strong"
              >
                <img
                  src={attachmentUrl(workspaceId, ref.id)}
                  alt={ref.name}
                  loading="lazy"
                  // One image keeps its shape; several become even tiles. The
                  // full image is one click away in the lightbox.
                  className={cn('block object-cover', images.length === 1 ? 'max-h-60 max-w-full' : 'size-28')}
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {hasBubble ? (
        // Actions sit beside the bubble, not under it: the bubble never spans the
        // column, so the room they need is already there.
        <div className="flex w-full items-end justify-end gap-1">
          {onReuse !== undefined ? (
            <div className={cn('flex shrink-0 items-center gap-0.5 pb-0.5', revealActions)}>
              <CopyButton text={item.content} label="Copy message" className="size-7" />
              <IconButton label="Reuse in composer" className="size-7" onClick={() => onReuse(item.content)}>
                <Icon name="pencil" size={15} />
              </IconButton>
            </div>
          ) : null}
          <div
            className={cn(
              'max-w-[85%] rounded-3xl px-4 py-2.5 text-[15px] leading-relaxed sm:max-w-[70%]',
              notSent !== undefined ? 'border border-dashed border-line-strong text-fg-muted' : 'bg-muted',
            )}
          >
            {notSent !== undefined ? (
              <span className="mb-0.5 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-bad">
                <Icon name="alertTriangle" size={11} />
                {notSent === 'rejected' ? 'Not sent · rejected' : 'Not sent'}
              </span>
            ) : null}
            {files.length > 0 ? (
              <ul className="m-0 mb-1.5 flex list-none flex-wrap gap-1.5 p-0">
                {files.map((ref) => (
                  <li key={ref.id} className="flex min-w-0 items-center gap-1.5 rounded-lg bg-bg/60 px-2 py-1 text-[13px]">
                    <Icon name="fileText" size={14} className="shrink-0 text-fg-muted" />
                    <span className="truncate">{ref.name}</span>
                    <span className="shrink-0 text-fg-faint">{formatBytes(ref.bytes)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {item.content !== '' ? (
              <p className="m-0 whitespace-pre-wrap break-words">
                {parseMessageText(item.content).map((segment, index) => (
                  segment.kind === 'text' ? segment.text : <InlineChip key={index} segment={segment} />
                ))}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      <ImageLightbox
        src={preview !== null && workspaceId != null ? attachmentUrl(workspaceId, preview.id) : null}
        alt={preview?.name ?? ''}
        onDismiss={() => setPreview(null)}
      />
    </div>
  )
})

/**
 * One assistant answer: thinking disclosure, markdown. The action row (copy,
 * serving model, time) belongs to the whole turn, so `Transcript` passes
 * `turn` only on the last answer of a closed turn — copying every answer
 * that turn produced.
 */
function useLiveContent(content: string, live: boolean): string {
  const [displayed, setDisplayed] = useState(content)
  const latest = useRef(content)
  latest.current = content
  const timer = useRef<number | null>(null)
  useEffect(() => {
    if (!live || displayed === content || timer.current !== null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      setDisplayed(latest.current)
    }, 100)
  }, [content, displayed, live])
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  return live ? displayed : content
}

export const AssistantMessage = memo(function AssistantMessage({ item, modelLabel, turn, changes, changesProject, changesWorkspaceId, changesOpenPath, changesReviewFile, changesReviewAll }: {
  readonly item: Extract<ViewItem, { kind: 'assistant' }>
  readonly modelLabel?: string
  /** Present on the last answer of a closed turn; text is the turn's full answer. */
  readonly turn?: { readonly parts?: readonly string[]; readonly text: string }
  /** Files this turn's Write/Edit calls landed; present on the same anchor answer. */
  readonly changes?: TurnChanges
  readonly changesProject?: WorkbenchProject | null
  readonly changesWorkspaceId?: string | null
  readonly changesOpenPath?: OpenPathResolver
  /** Reviews one file: the Git view focused on its diff. */
  readonly changesReviewFile?: (path: string) => void
  readonly changesReviewAll?: () => void
}) {
  const visibleContent = useLiveContent(item.content, item.live)
  // The label reports what actually served THIS step (recorded controls);
  // the workspace's current model is only the fallback for legacy events.
  const controlsLabel = item.controls !== undefined
    ? [item.controls.model, item.controls.provider].filter((part) => part !== undefined && part !== '').join(' · ')
    : ''
  const label = controlsLabel !== '' ? controlsLabel : modelLabel
  const [disclosed, setDisclosed] = useState(false)
  return (
    <div className="group flex flex-col gap-1">
      {item.discarded === true ? (
        // The model's answer was cut off mid-stream and the request re-asked
        // under a new step: what streamed here never became the answer, so it
        // stays behind a quiet disclosure instead of duplicating the retry.
        <div className="flex min-h-6 items-center gap-1.5 text-xs text-fg-faint" role="note">
          <Icon name="alertTriangle" size={12} className="shrink-0 text-warn" />
          <button
            type="button"
            onClick={() => setDisclosed(!disclosed)}
            aria-expanded={disclosed}
            className="rounded px-0.5 hover:text-fg-muted"
          >
            {disclosed ? 'Hide interrupted answer' : 'Interrupted answer — discarded and retried'}
          </button>
        </div>
      ) : null}
      {item.discarded === true && disclosed ? (
        <div className="whitespace-pre-wrap break-words border-l-2 border-line pl-4 text-[13px] leading-relaxed text-fg-muted">
          {item.thinking.length > 0 ? `${item.thinking.join('')}\n\n` : ''}{item.content}
        </div>
      ) : (
        <>
          {item.thinking.length > 0 || item.thinkingLive ? <ThinkingPanel thinking={item.thinking} live={item.live && item.thinkingLive} /> : null}
          {item.content !== '' ? (
            <div className="text-fg">
              {item.live
                ? <p className="m-0 whitespace-pre-wrap break-words">{visibleContent}</p>
                : <Markdown content={visibleContent} />}
              {item.live ? <span className="ml-0.5 inline-block size-2.5 translate-y-[-1px] rounded-full bg-fg align-middle animate-dot" aria-hidden="true" /> : null}
            </div>
          ) : null}
        </>
      )}
      {!item.live && !item.discarded && turn !== undefined ? (
        <>
          {/* Reserved, not hover-inserted (a hover must not shift the transcript),
              so the row stays short: it is height every answer pays for. */}
          <div className={cn('-ml-2 -mb-0.5 flex h-6 items-center gap-1 text-[11px] text-fg-faint', revealActions)}>
            <CopyButton getText={() => turn.parts?.join('\n\n') ?? turn.text ?? ''} label="Copy response" className="size-6" />
            {label !== undefined ? <span className="truncate">{label}</span> : null}
            {item.ts !== undefined ? <span>· {formatTime(item.ts)}</span> : null}
          </div>
          {changes !== undefined ? (
            <TurnChangesCard
              turnId={item.turnId ?? ''}
              changes={changes}
              project={changesProject ?? null}
              workspaceId={changesWorkspaceId ?? null}
              {...(changesOpenPath !== undefined ? { onOpenPath: changesOpenPath } : {})}
              {...(changesReviewFile !== undefined ? { onReviewFile: changesReviewFile } : {})}
              {...(changesReviewAll !== undefined ? { onReviewAll: changesReviewAll } : {})}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}, (previous, next) => {
  if (previous.item !== next.item || previous.modelLabel !== next.modelLabel) return false
  const previousParts = previous.turn?.parts
  const nextParts = next.turn?.parts
  if (previousParts !== undefined || nextParts !== undefined) {
    return previousParts?.length === nextParts?.length
      && previousParts?.every((part, index) => part === nextParts?.[index]) === true
  }
  if (previous.turn?.text !== next.turn?.text) return false
  if (previous.changes !== next.changes) return false
  if (previous.changesReviewAll !== next.changesReviewAll) return false
  if (previous.changesReviewFile !== next.changesReviewFile) return false
  if (previous.changesOpenPath !== next.changesOpenPath) return false
  if (previous.changesWorkspaceId !== next.changesWorkspaceId) return false
  if (previous.changesProject?.id !== next.changesProject?.id
    || previous.changesProject?.path !== next.changesProject?.path) return false
  return true
})

type RowState = 'running' | 'ok' | 'failed' | 'unknown' | 'cancelled' | 'denied'

/**
 * An opened row tells its run to stay open: a run that collapses when the
 * last step settles would unmount the very row someone is reading.
 */
const PinRunContext = createContext<() => void>(() => {})
/** Inside a group the rail already says what the rows are, so their icons give way. */
const InGroupContext = createContext(false)

/**
 * Activity rows are a line of text, not a card: no box, no fill, no hover
 * background. Only the chevron reveals on hover. A settled success adds
 * nothing to the line; only an outcome worth a look gets a status word.
 */
const rowClass = 'inline-flex min-h-6 max-w-full items-center gap-2 self-start text-left text-sm leading-5 text-fg-faint'

/** Built-in tools only. An MCP tool called `read` is not the built-in and does not borrow its icon. */
const TOOL_ICON: Readonly<Record<string, IconName>> = {
  read: 'eye',
  write: 'squarePen',
  edit: 'pencil',
  glob: 'search',
  grep: 'search',
  bash: 'terminal',
  skill: 'zap',
  agent: 'gitBranch',
  memorysearch: 'lightbulb',
  memoryread: 'lightbulb',
  memorycreate: 'lightbulb',
  memoryupdate: 'lightbulb',
  memoryforget: 'lightbulb',
}

/**
 * One hue per family of work, on the icon only — the words stay neutral, so
 * colour helps a scan without competing with the text. Reading is blue,
 * changing green, searching violet, running amber, delegating pink, external
 * tools teal. Groups take their family's hue; a mixed run stays neutral.
 */
const ICON_TONE: Readonly<Partial<Record<IconName, string>>> = {
  eye: 'text-tool-read',
  squarePen: 'text-tool-edit',
  pencil: 'text-tool-edit',
  search: 'text-tool-search',
  terminal: 'text-tool-run',
  gitBranch: 'text-tool-agent',
  zap: 'text-tool-agent',
  lightbulb: 'text-tool-search',
  globe: 'text-tool-ext',
  wrench: 'text-tool-ext',
  // Roles take the hue their family of work has; an unnamed role stays pink.
  telescope: 'text-tool-search',
  hammer: 'text-tool-edit',
  searchCheck: 'text-tool-read',
  shieldCheck: 'text-tool-run',
  bot: 'text-tool-agent',
}

/** The word a row leads with: running, landed, and anything else. */
const KIND: Readonly<Record<string, { readonly running: string; readonly done: string; readonly otherwise: string }>> = {
  read: { running: 'Reading', done: 'Read', otherwise: 'Read' },
  write: { running: 'Writing', done: 'Wrote', otherwise: 'Write' },
  edit: { running: 'Editing', done: 'Edited', otherwise: 'Edit' },
  glob: { running: 'Finding', done: 'Find', otherwise: 'Find' },
  grep: { running: 'Searching', done: 'Search', otherwise: 'Search' },
  bash: { running: 'Running', done: 'Terminal', otherwise: 'Terminal' },
  skill: { running: 'Loading skill', done: 'Skill', otherwise: 'Skill' },
  agent: { running: 'Agent', done: 'Agent', otherwise: 'Agent' },
}

const MEMORY_VERB: Readonly<Record<string, string>> = {
  memorysearch: 'Search',
  memoryread: 'Read',
  memorycreate: 'Create',
  memoryupdate: 'Update',
  memoryforget: 'Forget',
}

type StatusTone = 'bad' | 'warn' | 'quiet'
interface RowStatus {
  readonly text: string
  readonly tone: StatusTone
  /** The reason, on hover; the opened row shows it in full. */
  readonly detail?: string
}

/** Everything one row line draws, decided once per call. */
interface RowSpec {
  readonly icon: IconName
  readonly kind: string
  /** A qualifier beside the kind: an MCP server, an agent role. */
  readonly kindDetail?: string
  /** Draw the icon in a rounded chip (agent roles keep one face everywhere). */
  readonly chip?: boolean
  /** A `·` between the kind and what follows, when the kind is a noun. */
  readonly separator?: boolean
  readonly primary?: ReactNode
  /** Commands and patterns are code; names and sentences are not. */
  readonly primaryMono?: boolean
  /** Quiet context — a directory, a search scope. First to go when space runs out. */
  readonly secondary?: string
  /** The untruncated target, on hover. */
  readonly title?: string
  readonly diff?: { readonly added: number; readonly removed: number }
  readonly status?: RowStatus
}

const STATUS_TONE: Readonly<Record<StatusTone, string>> = {
  bad: 'text-bad',
  warn: 'text-warn',
  quiet: 'text-fg-faint',
}

/**
 * A file, named the way the Git panel names a changed one: its type icon, then
 * its name at full strength. The folder beside it is the row's quiet context.
 */
function FileChip({ path, name, onOpen }: { readonly path: string; readonly name: string; readonly onOpen?: () => void }) {
  const body = (
    <>
      <FileTypeIcon path={path} size={16} />
      <span className="min-w-0 truncate">{name}</span>
    </>
  )
  if (onOpen === undefined) return <span className="inline-flex min-w-0 items-center gap-1.5 text-fg">{body}</span>
  return (
    <button type="button" onClick={onOpen} title={`Open ${path} in workbench`} className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-fg hover:underline">
      {body}
    </button>
  )
}

/**
 * The line itself: icon, kind, then what it acted on and how it ended. The
 * colours follow the Git panel's row — the thing acted on at full strength,
 * its context faint — with the kind one step quieter than the target.
 */
function RowLine({ spec, state, showIcon }: { readonly spec: RowSpec; readonly state: RowState; readonly showIcon: boolean }) {
  const running = state === 'running'
  const hasSummary = spec.primary !== undefined || spec.secondary !== undefined || spec.diff !== undefined || spec.status !== undefined
  return (
    <>
      {showIcon ? (
        spec.chip === true ? (
          <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-md bg-muted', ICON_TONE[spec.icon] ?? 'text-fg-faint')}>
            {running ? <Spinner size={13} /> : <Icon name={spec.icon} size={13} />}
          </span>
        ) : (
          <Icon name={spec.icon} size={16} className={cn('shrink-0', ICON_TONE[spec.icon] ?? 'text-fg-faint')} />
        )
      ) : null}
      <span className={cn('min-w-0 max-w-[40%] shrink-0 truncate whitespace-nowrap font-medium', running ? 'text-shimmer' : 'text-fg-muted')}>{spec.kind}</span>
      {/* A kind that stays a noun while it runs still has to say so aloud. */}
      {running && !spec.kind.endsWith('ing') ? <span className="sr-only">, running</span> : null}
      {spec.kindDetail !== undefined && spec.kindDetail !== '' ? <span className="min-w-0 max-w-[45%] shrink-0 truncate whitespace-nowrap text-fg">{spec.kindDetail}</span> : null}
      {hasSummary ? (
        <span className="flex min-w-0 items-center gap-1.5">
          {spec.separator === true && spec.primary !== undefined ? <span aria-hidden="true" className="shrink-0 text-fg-faint">·</span> : null}
          {spec.primary !== undefined ? (
            <span className={cn('flex min-w-0 items-center truncate text-fg', spec.primaryMono === true && 'font-mono text-[12px]')}>{spec.primary}</span>
          ) : null}
          {spec.secondary !== undefined && spec.secondary !== '' ? (
            // Context gives way before the target does, and leaves a narrow screen entirely.
            <span className="hidden min-w-0 truncate text-fg-faint [flex-shrink:4] sm:block">{spec.secondary}</span>
          ) : null}
          {spec.diff !== undefined ? <LineCount added={spec.diff.added} removed={spec.diff.removed} /> : null}
          {spec.status !== undefined ? (
            <span
              className={cn('shrink-0 whitespace-nowrap underline decoration-dotted underline-offset-2', STATUS_TONE[spec.status.tone])}
              {...(spec.status.detail !== undefined ? { title: spec.status.detail } : {})}
            >
              {spec.status.text}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  )
}

/** One activity line, opening to what the call recorded when there is something to show. */
function ActivityRow({ spec, state, expandable = true, children }: {
  readonly spec: RowSpec
  readonly state: RowState
  readonly expandable?: boolean
  readonly children?: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const holdScroll = useHoldScroll()
  const pinRun = useContext(PinRunContext)
  const inGroup = useContext(InGroupContext)
  const bodyId = useId()
  const buttonId = useId()
  const line = <RowLine spec={spec} state={state} showIcon={!inGroup} />
  if (!expandable) {
    return <div className={rowClass} {...(spec.title !== undefined ? { title: spec.title } : {})}>{line}</div>
  }
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        id={buttonId}
        // Opening a row must not scroll it away: growth the reader asked for
        // releases the tail instead of following it.
        onClick={() => {
          if (!expanded) { holdScroll(); pinRun() }
          setExpanded((prev) => !prev)
        }}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className={cn(rowClass, 'group/row cursor-pointer rounded-sm')}
        {...(spec.title !== undefined ? { title: spec.title } : {})}
      >
        {line}
        <Icon
          name="chevronRight"
          size={14}
          className={cn(
            'shrink-0 text-fg-faint opacity-0 transition duration-200 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 [@media(pointer:coarse)]:opacity-100',
            expanded && 'rotate-90 opacity-100',
          )}
        />
      </button>
      {expanded ? (
        <div id={bodyId} role="group" aria-labelledby={buttonId} className="flex min-w-0 flex-col gap-2 pt-2 animate-fade-up">
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** Runs shorter than this stay open: a summary would hide more than it saves. */
const COLLAPSE_MIN_ROWS = 4
/** Running outranks a settled failure: while work continues, that is the state. */
const STATE_RANK: Readonly<Record<RowState, number>> = { running: 5, failed: 4, unknown: 3, cancelled: 1, denied: 1, ok: 0 }

type Bucket = 'search' | 'file' | 'command' | 'change' | 'agent' | 'tool'
const BUCKET_WORDS: Readonly<Record<Bucket, readonly [string, string]>> = {
  file: ['file', 'files'],
  search: ['search', 'searches'],
  command: ['command', 'commands'],
  change: ['edit', 'edits'],
  agent: ['agent', 'agents'],
  tool: ['tool', 'tools'],
}
const BUCKET_ORDER: readonly Bucket[] = ['file', 'search', 'command', 'change', 'agent', 'tool']

function bucketOf(item: ViewItem): Bucket | null {
  if (item.kind === 'delegation') return 'agent'
  if (item.kind !== 'tool') return null
  if (mcpServerOf(item.call.name) !== undefined) return 'tool'
  switch (item.call.name.toLowerCase()) {
    case 'read': return 'file'
    case 'glob':
    case 'grep': return 'search'
    case 'bash': return 'command'
    case 'edit':
    case 'write': return 'change'
    case 'agent': return 'agent'
    default: return 'tool'
  }
}

const GROUP_KIND: Readonly<Record<'explore' | 'terminal' | 'changes' | 'mixed', { readonly icon: IconName; readonly done: string; readonly running: string }>> = {
  explore: { icon: 'search', done: 'Explore', running: 'Exploring' },
  terminal: { icon: 'terminal', done: 'Terminal', running: 'Running' },
  changes: { icon: 'pencil', done: 'Changes', running: 'Editing' },
  mixed: { icon: 'layers', done: 'Activity', running: 'Working' },
}

interface ActivitySummary {
  readonly state: RowState
  readonly live: boolean
  /** Calls and delegations only: reasoning and audit notes are not steps. */
  readonly steps: number
  /** Rows that failed or ended unknown — a collapsed run must still admit them. */
  readonly problems: number
  /** Rows refused or cancelled: not faults, but a collapsed run must not hide that a step never ran. */
  readonly skipped: number
  readonly icon: IconName
  /** `Explore`, `Terminal`, `Changes`, or `Activity` for a mixed run. */
  readonly kind: string
  /** `2 searches, 3 files`: what the run did, counted. */
  readonly text: string
  /** Lines the run's landed edits added and removed. */
  readonly diff: { readonly added: number; readonly removed: number }
}

/** One line for a whole run: what kind of work it was, counted, and how it ended. */
export function summarizeActivity(items: readonly ViewItem[]): ActivitySummary {
  const counts = new Map<Bucket, number>()
  const changedPaths = new Set<string>()
  let state: RowState = 'ok'
  let steps = 0
  let problems = 0
  let skipped = 0
  let added = 0
  let removed = 0
  for (const item of items) {
    const bucket = bucketOf(item)
    if (bucket === null) continue
    steps += 1
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    const rowState = item.kind === 'tool' ? toolState(item) : item.kind === 'delegation' ? DELEGATION_STATE[item.status] : 'ok'
    if (STATE_RANK[rowState] > STATE_RANK[state]) state = rowState
    if (rowState === 'failed' || rowState === 'unknown') problems += 1
    if (rowState === 'denied' || rowState === 'cancelled') skipped += 1
    if (item.kind !== 'tool') continue
    const facts = toolFacts(item.call, item.result)
    // `Bash` settles as a recorded success even when the command exited
    // non-zero or was killed: the row says so, so a collapsed run has to
    // count it too instead of reading as all clear.
    if (rowState === 'ok' && item.result !== undefined && facts.digestFailed === true) {
      problems += 1
      if (STATE_RANK.failed > STATE_RANK[state]) state = 'failed'
    }
    if (bucket === 'change' && facts.path !== undefined) changedPaths.add(facts.path)
    if (bucket === 'change' && rowState === 'ok') {
      const lines = changeLines(item)
      added += lines.added
      removed += lines.removed
    }
  }
  const only = (bucket: Bucket): boolean => counts.size === 1 && counts.has(bucket)
  const group = counts.size > 0 && [...counts.keys()].every((bucket) => bucket === 'file' || bucket === 'search')
    ? GROUP_KIND.explore
    : only('command') ? GROUP_KIND.terminal : only('change') ? GROUP_KIND.changes : GROUP_KIND.mixed
  const parts = BUCKET_ORDER
    .filter((bucket) => (counts.get(bucket) ?? 0) > 0)
    .map((bucket) => {
      // A Changes run counts files, not calls: three edits to one file is one file changed.
      const count = bucket === 'change' && group === GROUP_KIND.changes ? changedPaths.size || (counts.get(bucket) ?? 0) : counts.get(bucket) ?? 0
      const [one, many] = bucket === 'change' && group === GROUP_KIND.changes ? ['file', 'files'] : BUCKET_WORDS[bucket]
      return `${count} ${count === 1 ? one : many}`
    })
  const live = state === 'running'
  return {
    state,
    live,
    steps,
    problems,
    skipped,
    icon: group.icon,
    kind: live ? group.running : group.done,
    text: parts.length > 0 ? parts.join(', ') : `${items.length} ${items.length === 1 ? 'step' : 'steps'}`,
    diff: { added, removed },
  }
}

/**
 * A run of tool calls, delegations and audit lines. Four rows or more collapse
 * into one summary line once the work settles — `Explore · 2 searches, 3 files`
 * — so a turn that read twenty files reads as one step instead of twenty. It
 * stays open while anything is still running or ended badly, and a reader's
 * own toggle wins either way.
 */
export function ActivityBlock({ items, children }: { readonly items: readonly ViewItem[]; readonly children: ReactNode }) {
  const [userPreference, setUserPreference] = useState<boolean | null>(null)
  const holdScroll = useHoldScroll()
  const bodyId = useId()
  const summary = useMemo(() => summarizeActivity(items), [items])
  const open = userPreference ?? (summary.live || summary.problems > 0)
  // Opening a row inside the run is a decision to keep reading it. Without
  // this the run would fold shut when its last step settled and take the open
  // row (and anything it fetched) with it. A deliberate fold still wins.
  const pin = useCallback(() => { setUserPreference((current) => current ?? true) }, [])

  // The same beat the transcript puts between blocks, so a row inside a run
  // sits exactly as far from its neighbour as a row that stands on its own.
  const rowGap = 'gap-2.5 sm:gap-4'
  // Thinking rides along inside the run so it cannot split the column, but it
  // is not a work row: counting it would fold three tool cards behind a summary.
  const workRows = items.reduce((count, item) => count + (item.kind === 'assistant' ? 0 : 1), 0)
  if (workRows < COLLAPSE_MIN_ROWS) return <div className={cn('flex flex-col', rowGap)}>{children}</div>
  const unknown = summary.problems > 0 && summary.state === 'unknown'
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => { if (!open) holdScroll(); setUserPreference(!open) }}
        aria-expanded={open}
        aria-controls={bodyId}
        className={cn(rowClass, 'group/row cursor-pointer rounded-sm')}
      >
        <RowLine
          state={summary.live ? 'running' : 'ok'}
          showIcon
          spec={{
            icon: summary.icon,
            kind: summary.kind,
            separator: true,
            primary: summary.text,
            diff: summary.diff,
            ...(summary.problems > 0
              ? { status: { text: unknown ? `${summary.problems} unknown` : `${summary.problems} failed`, tone: unknown ? 'warn' : 'bad' } }
              : summary.skipped > 0 ? { status: { text: `${summary.skipped} not run`, tone: 'quiet' } } : {}),
          }}
        />
        <Icon
          name="chevronRight"
          size={14}
          className={cn(
            'shrink-0 text-fg-faint opacity-0 transition duration-200 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 [@media(pointer:coarse)]:opacity-100',
            open && 'rotate-90 opacity-100',
          )}
        />
      </button>
      {/* Behind a rail: an opened run reads as the header's contents, not as
          loose rows that happen to follow it. The rail already names them, so
          the rows drop their icons. The gap matches a row standing alone. */}
      {open ? (
        <PinRunContext.Provider value={pin}>
          <InGroupContext.Provider value>
            <div id={bodyId} className={cn('ml-2 mt-2.5 flex flex-col border-l border-line pl-3.5 sm:mt-4', rowGap)}>{children}</div>
          </InGroupContext.Provider>
        </PinRunContext.Provider>
      ) : null}
    </div>
  )
}

/** A recorded call's outcome: unfinished, recovered/ambiguous, or what the result says. */
function toolState(item: Extract<ViewItem, { kind: 'tool' }>): RowState {
  if (item.result === undefined) return 'running'
  if (item.recovered === true || item.outcome === 'indeterminate' || item.outcome === 'audit_fault') return 'unknown'
  // A refusal is the policy or the reader speaking, not a tool that broke.
  if (isDenied(item.result)) return 'denied'
  return item.result.ok ? 'ok' : 'failed'
}

function countLines(text: string): number {
  if (text === '') return 0
  return text.replace(/\n$/, '').split('\n').length
}

/** Lines an Edit replaced or a Write wrote, read from the call's own arguments. */
function changeLines(item: Extract<ViewItem, { kind: 'tool' }>): { added: number; removed: number } {
  const args = item.call.args
  const text = (key: string): string => (typeof args[key] === 'string' ? args[key] as string : '')
  if (item.call.name.toLowerCase() === 'write') return { added: countLines(text('content')), removed: 0 }
  return { added: countLines(text('new')), removed: countLines(text('old')) }
}

/** `[exit code: 1]` → `Exit 1`; `terminated` → `Terminated`. */
function capitalize(text: string): string {
  return text === '' ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`
}

/** The status word a row ends with — absent for a clean success and while running. */
function rowStatus(item: Extract<ViewItem, { kind: 'tool' }>, state: RowState, facts: ToolFacts): RowStatus | undefined {
  const output = item.result?.output ?? ''
  switch (state) {
    case 'running': return undefined
    case 'failed': return { text: 'Failed', tone: 'bad', detail: facts.digest ?? output }
    case 'denied': return { text: 'Denied', tone: 'quiet', detail: output.replace(/^denied:\s*/, '') }
    case 'cancelled': return { text: 'Stopped', tone: 'quiet' }
    case 'unknown':
      if (item.outcome === 'indeterminate') return { text: 'Indeterminate', tone: 'warn', detail: 'This call may have run remotely. It is not retried automatically.' }
      if (item.outcome === 'audit_fault') return { text: 'Audit fault', tone: 'warn', detail: 'The outcome is known but its evidence was not durably recorded.' }
      return { text: 'Unknown', tone: 'warn', detail: 'The host restarted before this result was recorded.' }
    case 'ok':
      // A command that ran and exited badly: the call succeeded, the work did not.
      return facts.digestFailed === true && facts.digest !== undefined ? { text: capitalize(facts.digest), tone: 'bad', detail: excerptTail(output) } : undefined
  }
}

/** The end of an output, where a command's error usually is. */
function excerptTail(output: string, max = 400): string {
  const trimmed = output.trimEnd()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`
}

/** What one tool row draws. */
function toolRowSpec(item: Extract<ViewItem, { kind: 'tool' }>, state: RowState, facts: ToolFacts, onOpenFile?: () => void): RowSpec {
  const { call, server } = item
  const builtin = mcpServerOf(call.name) === undefined ? call.name.toLowerCase() : ''
  const kindWords = KIND[builtin]
  const kind = kindWords === undefined ? undefined : state === 'running' ? kindWords.running : state === 'ok' ? kindWords.done : kindWords.otherwise
  const status = rowStatus(item, state, facts)
  const base = { ...(status !== undefined ? { status } : {}), ...(facts.fullTarget !== '' ? { title: facts.fullTarget } : {}) }

  if ((builtin === 'read' || builtin === 'write' || builtin === 'edit') && facts.file !== undefined && facts.path !== undefined) {
    // Only a change known to have landed has a size worth stating.
    const lines = builtin !== 'read' && state === 'ok' ? changeLines(item) : undefined
    return {
      ...base,
      icon: TOOL_ICON[builtin]!,
      kind: kind!,
      primary: <FileChip path={facts.path} name={facts.file.name} {...(onOpenFile !== undefined ? { onOpen: onOpenFile } : {})} />,
      ...(facts.file.directory !== '' ? { secondary: facts.file.directory } : {}),
      ...(lines !== undefined ? { diff: lines } : {}),
    }
  }
  if (builtin === 'glob' || builtin === 'grep') {
    const pattern = typeof call.args['pattern'] === 'string' ? call.args['pattern'] : ''
    const scope = typeof call.args['path'] === 'string' && call.args['path'] !== '' ? `in ${call.args['path']}` : undefined
    // The kind is the family (Search); what it searched for keeps its own verb,
    // the way ZCode's `Find {query}` reads: `Search · Find foo in src`.
    const query = pattern === '' ? 'Find' : `Find ${pattern}`
    return { ...base, icon: 'search', kind: kind!, separator: true, primary: query, primaryMono: true, ...(scope !== undefined ? { secondary: scope } : {}) }
  }
  if (builtin === 'bash') {
    return { ...base, icon: 'terminal', kind: kind!, primary: facts.target, primaryMono: true }
  }
  if (builtin === 'agent') {
    const action = typeof call.args['action'] === 'string' ? call.args['action'] : 'spawn'
    const role = typeof call.args['definition'] === 'string' ? call.args['definition'] : undefined
    const waitish = action !== 'spawn' && action !== 'catalog'
    return {
      ...base,
      icon: role !== undefined && !waitish ? agentRoleIcon(role) : 'gitBranch',
      kind: kind!,
      ...(role !== undefined ? { kindDetail: role } : {}),
      chip: !waitish,
      separator: true,
      primary: action,
    }
  }
  if (MEMORY_VERB[builtin] !== undefined) {
    return { ...base, icon: 'lightbulb', kind: 'Memory', separator: true, primary: `${MEMORY_VERB[builtin]} ${facts.target}`.trim() }
  }
  if (builtin === 'skill') {
    return { ...base, icon: 'zap', kind: kind!, primary: facts.target }
  }
  if (server !== undefined || mcpServerOf(call.name) !== undefined) {
    return {
      ...base,
      icon: 'globe',
      kind: 'MCP',
      kindDetail: server ?? mcpServerOf(call.name) ?? '',
      separator: true,
      primary: facts.name,
      ...(facts.target !== '' ? { secondary: facts.target } : {}),
    }
  }
  return { ...base, icon: 'wrench', kind: facts.name, ...(facts.target !== '' ? { primary: facts.target, primaryMono: true } : {}) }
}

/** Warnings a reader must see before trusting anything below them. */
function OutcomeNotes({ item }: { readonly item: Extract<ViewItem, { kind: 'tool' }> }) {
  const note = (text: string) => (
    <p className="m-0 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn" role="note">
      <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  )
  return (
    <>
      {item.recovered === true && item.result !== undefined ? note('Outcome unknown — the host restarted before this result was recorded. Check the actual state before retrying.') : null}
      {item.outcome === 'indeterminate' ? note(`Indeterminate — this call may have run remotely. It is not retried automatically${item.invocationId !== undefined ? ` (${item.invocationId})` : ''}.`) : null}
      {item.outcome === 'audit_fault' ? note('Audit fault — the outcome is known but its evidence was not durably recorded. Further MCP calls stay blocked until that evidence is repaired.') : null}
    </>
  )
}

/**
 * Every opened tool body sits in one frame: a rule above and below and a faint
 * fill — except the terminal, a dark well by design, and notes, which keep
 * their chip. The frame is the contract: same padding, same cap, so a
 * command, a change and a result read as the same kind of thing.
 */
const panelClass = 'min-w-0 border-y border-line bg-muted/40'
const panelText = 'm-0 px-3 py-2 font-mono text-[12px] leading-5'

/** The trailer `Bash` appends to every result: the exit, or how it was stopped. */
const BASH_TRAILER = /\n?\[(exit code: -?\d+|terminated[^\]]*)\]\s*$/

/** A command's output without its trailer, and the trailer as a short footer. */
function splitTerminalOutput(output: string): { body: string; footer?: { text: string; bad: boolean } } {
  const match = BASH_TRAILER.exec(output)
  if (match === null) return { body: output.replace(/\s+$/, '') }
  const trailer = match[1]!
  const exit = /^exit code: (-?\d+)$/.exec(trailer)
  const body = output.slice(0, match.index).replace(/\s+$/, '')
  if (exit !== null) {
    // A clean exit is the expected case; the row already said nothing went wrong.
    return Number(exit[1]) === 0 ? { body } : { body, footer: { text: `exit ${exit[1]}`, bad: true } }
  }
  return { body, footer: { text: trailer.replace(/;.*$/, ''), bad: true } }
}

/**
 * A command the way a terminal shows it: a dark well in both themes under the
 * shared frame's rules, the prompt and command on top — clamped to three
 * lines, since the row already names it — then what came back. Output keeps
 * the ANSI colours the command emitted (`ansiToHtml` escapes every non-escape
 * byte, so tool text can never become markup); copy hands over the plain text.
 * A clean `exit 0` is not repeated; any other ending gets one short footer.
 */
function TerminalPanel({ command, output, running }: { readonly command: string; readonly output?: string; readonly running: boolean }) {
  const [commandOpen, setCommandOpen] = useState(false)
  const long = command.length > 240 || command.split('\n').length > 3
  const split = output !== undefined ? splitTerminalOutput(output) : undefined
  const html = useMemo(() => (split === undefined ? undefined : ansiToHtml(split.body)), [split])
  return (
    <div className={cn(panelClass, 'relative bg-term-bg font-mono text-[12px] leading-5 text-term-fg')}>
      <div className="border-b border-white/10 px-3 py-2 pr-10">
        <pre aria-label="Command" className={cn('m-0 whitespace-pre-wrap break-words', long && !commandOpen && 'line-clamp-3')}>
          <span aria-hidden="true" className="select-none text-term-dim">$ </span><span>{command}</span>
        </pre>
        {long ? (
          <button
            type="button"
            onClick={() => setCommandOpen((value) => !value)}
            className="-mx-1 -mt-0.5 inline-flex min-h-6 items-center rounded-sm px-1 font-sans text-[11px] text-term-dim hover:text-term-fg"
          >
            {commandOpen ? 'Show less' : 'Show full command'}
          </button>
        ) : null}
      </div>
      <CopyButton text={command} label="Copy command" className="absolute right-1 top-1 size-7 text-term-dim hover:bg-white/10 hover:text-term-fg" />
      {split !== undefined ? (
        <div className="relative">
          {split.body === ''
            ? <p className="m-0 px-3 py-2 font-sans text-term-dim">No output.</p>
            : <pre
                tabIndex={0}
                aria-label="Tool output"
                className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 pr-10 text-term-fg"
                {...(html !== undefined ? { dangerouslySetInnerHTML: { __html: html } } : {})}
              >
                {html === undefined ? split.body : undefined}
              </pre>}
          {split.footer !== undefined ? (
            <p className={cn('m-0 border-t border-white/10 px-3 py-1', split.footer.bad ? 'text-[#ff8a8a]' : 'text-term-dim')}>{split.footer.text}</p>
          ) : null}
          {split.body !== '' ? <CopyButton text={split.body} label="Copy output" className="absolute right-1 top-1 size-7 text-term-dim hover:bg-white/10 hover:text-term-fg" /> : null}
        </div>
      ) : running ? <p className="m-0 px-3 py-2 font-sans text-term-dim">Running…</p> : null}
    </div>
  )
}

/**
 * An edit or a write as the Git panel shows a change: the same frame, the
 * same numbered gutters, the same tints. The row above already names the file
 * and opens it, so the frame carries nothing but the lines. The row also
 * names this body, so it stays a group — not a landmark of its own.
 */
function ChangePanel({ rows, path }: { readonly rows: readonly DiffRow[]; readonly path: string }) {
  if (rows.length === 0) return <p className="m-0 text-xs text-fg-muted">No textual change.</p>
  return (
    <div className={cn(panelClass, 'max-h-72 overflow-auto')} role="group" aria-label={`Diff of ${path}`} tabIndex={0}>
      <DiffLines rows={rows} />
    </div>
  )
}

/** What came back, in the same frame — or the error, in the diff's red. With no
 *  output yet the frame is already there with its word, so settling changes a
 *  word inside the frame instead of moving the text that follows it. */
function ResultPanel({ output, tone }: { readonly output?: string; readonly tone: 'plain' | 'bad' | 'quiet' }) {
  return (
    <div className={cn(panelClass, 'relative', tone === 'bad' && 'bg-bad-soft')}>
      {output === undefined ? (
        <p className="m-0 px-3 py-2 text-[12px] text-shimmer">Running…</p>
      ) : (
        <pre
          tabIndex={0}
          aria-label="Tool output"
          className={cn(panelText, 'max-h-72 overflow-auto whitespace-pre-wrap break-words pr-10', tone === 'bad' ? 'text-bad' : tone === 'quiet' ? 'text-fg-muted' : 'text-fg')}
        >
          {output === '' ? 'No output.' : output}
        </pre>
      )}
      {output !== undefined && output !== '' ? <CopyButton text={output} label="Copy output" className="absolute right-1 top-0.5 size-7" /> : null}
    </div>
  )
}

/**
 * A Bash call. A background one (`run_in_background`) settles immediately
 * while its process keeps running, so the row carries a live Background chip
 * from the session's process events and a jump to the workbench's Process
 * view — without these the row reads exactly like a command that finished.
 */
function BashCard({ item, spec, state, command }: {
  readonly item: Extract<ViewItem, { kind: 'tool' }>
  readonly spec: RowSpec
  readonly state: RowState
  readonly command: string
}) {
  const link = useContext(ProcessLinkContext)
  const processId = backgroundProcessId(item.call, item.result)
  const row = processId !== undefined ? link?.statuses.get(processId) : undefined
  let backgroundStatus: RowStatus | undefined
  if (processId !== undefined) {
    backgroundStatus = row === undefined
      ? { text: 'Background', tone: 'quiet', detail: 'The command returned a process id; the work keeps running past this turn.' }
      : row.status === 'running'
        ? { text: 'Background · running', tone: 'warn', detail: 'Still running. Open it in the workbench to watch its output.' }
        : { text: `Background · ${row.status}`, tone: TERMINAL_TONE[row.status] ?? 'quiet' }
  }
  const specWithBackground = backgroundStatus === undefined ? spec : { ...spec, status: backgroundStatus }
  return (
    <ActivityRow spec={specWithBackground} state={state}>
      <OutcomeNotes item={item} />
      <TerminalPanel command={command} {...(item.result !== undefined ? { output: item.result.output } : {})} running={state === 'running'} />
      {processId !== undefined && link !== null ? (
        <button
          type="button"
          onClick={() => link.open(processId)}
          className="-mx-1 inline-flex min-h-6 items-center gap-1 self-start rounded-sm px-1 text-[12px] text-fg-muted transition-colors hover:text-fg"
        >
          <Icon name="terminal" size={12} />
          View process in workbench
        </button>
      ) : null}
    </ActivityRow>
  )
}

const TERMINAL_TONE: Readonly<Record<string, RowStatus['tone']>> = { killed: 'bad', failed: 'bad', interrupted: 'bad', exited: 'quiet' }

/** The exact arguments, one click away instead of in the way. */
function CallDetails({ call }: { readonly call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)} className="-mx-1 inline-flex min-h-6 items-center gap-1 self-start rounded-sm px-1 text-[12px] text-fg-faint hover:text-fg-muted">
        <Icon name="chevronRight" size={12} className={cn('transition-transform', open && 'rotate-90')} />
        View call details
      </button>
      {open ? <div id={id} className="flex min-w-0 flex-col gap-2"><ToolArguments call={call} /></div> : null}
    </div>
  )
}

/**
 * A tool invocation: one line of text that names what it did and, only when
 * it is worth a look, how it ended. Opening it shows what the tool produced in
 * the shape that tool's output has — a terminal, a diff, a result.
 */
export const ToolCard = memo(function ToolCard({ item, openPath, hidden }: { readonly item: Extract<ViewItem, { kind: 'tool' }>; readonly openPath?: OpenPathResolver; readonly hidden?: boolean }) {
  const { call, result } = item
  const facts = toolFacts(call, result)
  const open = facts.path !== undefined ? openPath?.(facts.path, facts.focus) ?? null : null
  const state = toolState(item)
  const builtin = mcpServerOf(call.name) === undefined ? call.name.toLowerCase() : ''
  const arg = (key: string): string => (typeof call.args[key] === 'string' ? call.args[key] as string : '')

  // A delegation row renders the spawn itself — same child, one line — so the
  // tool call that only reports the same child id stays out of the transcript.
  if (hidden === true) return null

  // A read that landed is opened in the workbench, not in the transcript: its
  // file is the link. Anything that did not land opens to say why.
  if (builtin === 'read' && facts.file !== undefined) {
    const settledClean = state === 'ok'
    const spec = toolRowSpec(item, state, facts, settledClean && open !== null ? open : undefined)
    if (settledClean || state === 'running') return <ActivityRow spec={spec} state={state} expandable={false} />
    return (
      <ActivityRow spec={spec} state={state}>
        <OutcomeNotes item={item} />
        {result === undefined
          ? <ResultPanel tone="plain" />
          : <ResultPanel output={result.output} tone={state === 'failed' ? 'bad' : state === 'denied' ? 'quiet' : 'plain'} />}
      </ActivityRow>
    )
  }

  const spec = toolRowSpec(item, state, facts)
  if (builtin === 'bash') {
    return <BashCard item={item} spec={spec} state={state} command={arg('command')} />
  }
  if ((builtin === 'edit' || builtin === 'write') && facts.path !== undefined) {
    // A refused or failed change never landed: what to show is why, not lines
    // that are not in the file.
    const landed = state === 'ok' || state === 'running' || state === 'unknown'
    const rows = builtin === 'edit' ? diffRowsFromEdit(arg('old'), arg('new'), result?.output) : diffRowsFromWrite(arg('content'))
    return (
      <ActivityRow spec={spec} state={state}>
        <OutcomeNotes item={item} />
        {landed ? <ChangePanel rows={rows} path={facts.fullTarget} /> : null}
        {!landed
          ? result === undefined
            ? <ResultPanel tone="quiet" />
            : <ResultPanel output={result.output} tone={state === 'failed' ? 'bad' : 'quiet'} />
          : null}
      </ActivityRow>
    )
  }
  return (
    <ActivityRow spec={spec} state={state}>
      <OutcomeNotes item={item} />
      <ResultPanel
        {...(result === undefined ? { running: true as const } : { output: result.output })}
        tone={state === 'failed' ? 'bad' : state === 'denied' ? 'quiet' : 'plain'}
      />
      <CallDetails call={call} />
    </ActivityRow>
  )
})

const DELEGATION_STATE: Readonly<Record<Extract<ViewItem, { kind: 'delegation' }>['status'], RowState>> = {
  running: 'running',
  completed: 'ok',
  failed: 'failed',
  interrupted: 'unknown',
  cancelled: 'cancelled',
}

const DELEGATION_STATUS: Readonly<Partial<Record<Extract<ViewItem, { kind: 'delegation' }>['status'], RowStatus>>> = {
  failed: { text: 'Failed', tone: 'bad' },
  interrupted: { text: 'Interrupted', tone: 'warn', detail: 'The host stopped before this child finished.' },
  cancelled: { text: 'Stopped', tone: 'quiet' },
}

/**
 * One delegation from the durable spawn → result pair. The settled result
 * payload (the child's final report, files touched, error) is fetched when
 * expanded.
 */
export const DelegationCard = memo(function DelegationCard({ item, workspaceId, rootSessionId, onOpen }: {
  readonly item: Extract<ViewItem, { kind: 'delegation' }>
  readonly workspaceId?: string | null
  readonly rootSessionId?: string | null
  readonly onOpen?: (childSessionId: string) => void
}) {
  const status = DELEGATION_STATUS[item.status]
  const icon = agentRoleIcon(item.definition)
  const spec: RowSpec = {
    icon,
    kind: item.status === 'running' ? 'Delegating' : 'Delegated',
    kindDetail: item.definition !== '' ? item.definition : 'agent',
    chip: true,
    separator: true,
    ...(item.brief !== '' ? { primary: item.brief, title: item.brief } : {}),
    ...(status !== undefined ? { status } : {}),
  }
  return (
    <ActivityRow spec={spec} state={DELEGATION_STATE[item.status]}>
      <DelegationDetail item={item} {...(workspaceId !== undefined ? { workspaceId } : {})} {...(rootSessionId !== undefined ? { rootSessionId } : {})} {...(onOpen !== undefined ? { onOpen } : {})} />
    </ActivityRow>
  )
})

/** Shown whenever a child's report hit the host cap; the full text is in its log. */
export function TruncatedNote() {
  return <p className="m-0 text-xs text-warn">Report truncated — open the child conversation for the full text.</p>
}

function DelegationDetail({ item, workspaceId, rootSessionId, onOpen }: {
  readonly item: Extract<ViewItem, { kind: 'delegation' }>
  readonly workspaceId?: string | null
  readonly rootSessionId?: string | null
  readonly onOpen?: (childSessionId: string) => void
}) {
  const [detail, setDetail] = useState<ChildRow | null>(null)
  const [failed, setFailed] = useState(false)
  // Bumped by Try again; the fetch effect keys off it.
  const [attempt, setAttempt] = useState(0)
  const settled = item.status !== 'running'

  // Mounted only while expanded, so the result is fetched on demand.
  useEffect(() => {
    if (!settled || workspaceId === null || workspaceId === undefined || rootSessionId === null || rootSessionId === undefined) return
    let cancelled = false
    setFailed(false)
    void waitChild(workspaceId, rootSessionId, item.childSessionId, 1_000).then(
      (row) => { if (!cancelled) setDetail(row) },
      () => { if (!cancelled) setFailed(true) },
    )
    return () => { cancelled = true }
  }, [settled, workspaceId, rootSessionId, item.childSessionId, attempt])

  return (
    <>
      <Section label="Brief"><p className="m-0 whitespace-pre-wrap break-words">{item.brief !== '' ? item.brief : '—'}</p></Section>
      {settled ? (
        <Section label={`Result (${item.status})`} {...(detail?.result !== undefined ? { copy: detail.result.report } : {})}>
          {detail?.result?.truncated === true ? <TruncatedNote /> : null}
          {detail?.result !== undefined
            ? <p className="m-0 whitespace-pre-wrap break-words">{detail.result.report}</p>
            : detail?.error !== undefined
              ? <p className="m-0 text-bad">{detail.error}</p>
              : failed
                ? (
                  <p className="m-0 flex flex-wrap items-center gap-2 text-fg-muted">
                    Could not load the result of this child session.
                    <button type="button" className="text-[13px] text-link hover:underline" onClick={() => setAttempt((count) => count + 1)}>Try again</button>
                  </p>
                )
                : <p className="m-0 text-fg-muted">Result payload unavailable for this child session.</p>}
          {detail?.result !== undefined && detail.result.filesTouched.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-fg-faint">Files touched:</span>
              {detail.result.filesTouched.map((file) => <code key={file} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{file}</code>)}
            </div>
          ) : null}
        </Section>
      ) : null}
      {onOpen !== undefined ? (
        <button type="button" className="self-start text-[13px] text-link hover:underline" onClick={() => onOpen(item.childSessionId)}>
          Open conversation →
        </button>
      ) : null}
    </>
  )
}

const AUDIT_ICONS = {
  block: { icon: 'alertTriangle', className: 'text-warn' },
  fail: { icon: 'alertTriangle', className: 'text-bad' },
  allow: { icon: 'check', className: 'text-ok' },
  deny: { icon: 'close', className: 'text-bad' },
  expired: { icon: 'circle', className: 'text-fg-faint' },
} as const

/** A quiet audit line — hooks that blocked or failed, and correlated approval decisions. */
export const AuditLine = memo(function AuditLine({ item }: { readonly item: Extract<ViewItem, { kind: 'audit' }> }) {
  const glyph = AUDIT_ICONS[item.icon]
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-2 text-xs text-fg-muted" role="note">
      <Icon name={glyph.icon} size={13} className={glyph.className} />
      <span className="min-w-0 break-words">{item.text}</span>
      {item.durationMs !== undefined ? <span className="font-mono text-fg-faint">{formatElapsed(item.durationMs)}</span> : null}
    </div>
  )
})

/** `name@<full sha>` → `name@<12 chars>`, for skill/memory source labels. */
function shortSource(source: string): string {
  const at = source.lastIndexOf('@')
  return at === -1 ? source : `${source.slice(0, at)}@${source.slice(at + 1, at + 13)}`
}

function ContextDetailRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-3 text-xs">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-fg-faint sm:w-20 sm:pt-0.5">{label}</span>
      <span className="min-w-0 flex-1 break-words leading-5 text-fg-muted">{children}</span>
    </div>
  )
}

function BreakdownList({ breakdown }: { readonly breakdown: NonNullable<ContextManifestView['breakdown']> }) {
  const total = breakdown.systemPrompt + breakdown.systemTools + breakdown.mcpTools + breakdown.metaContext + breakdown.skills + breakdown.messages
  const rows = [
    { key: 'history', label: 'History', value: breakdown.messages },
    { key: 'tools', label: 'Tools', value: breakdown.systemTools },
    { key: 'system', label: 'System', value: breakdown.systemPrompt },
    { key: 'skills', label: 'Skills', value: breakdown.skills },
    { key: 'meta', label: 'Meta', value: breakdown.metaContext },
    { key: 'mcp', label: 'MCP', value: breakdown.mcpTools },
  ].filter((row) => row.value > 0)
  const shown = rows.length > 0 ? rows : [{ key: 'empty', label: 'Empty', value: 0 }]
  return (
    <span className="flex min-w-0 flex-col gap-1.5" title="Estimated tokens per source; they sum to the request total.">
      <span className="flex h-1.5 w-full max-w-64 overflow-hidden rounded-full bg-muted" role="presentation" aria-hidden="true">
        {shown.map((row) => (
          <span key={row.key} className="block h-full bg-fg-faint first:bg-fg last:opacity-70" style={{ width: `${total > 0 ? Math.max((row.value / total) * 100, row.value > 0 ? 4 : 0) : 0}%` }} />
        ))}
      </span>
      <span className="flex flex-wrap gap-x-2 gap-y-1">
        {shown.map((row) => (
          <span key={row.key} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            <span className="text-fg-faint">{row.label}</span>
            <span className="font-semibold text-fg-muted">{formatTokenCount(row.value)}</span>
          </span>
        ))}
      </span>
    </span>
  )
}

function ToolChips({ names, schemas, label }: { readonly names: readonly string[]; readonly schemas: number; readonly label: string }) {
  if (names.length === 0) return <span className="text-fg-faint">none ({schemas} schemas)</span>
  const visible = names.slice(0, 6)
  const extra = names.length - visible.length
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" title={names.join(', ')}>
      {visible.map((name) => (
        <code key={name} className="rounded-md border border-line bg-muted/60 px-1.5 py-px font-mono text-[11px] text-fg-muted">{name}</code>
      ))}
      {extra > 0 ? <span className="font-mono text-[11px] text-fg-faint">+{extra} more</span> : null}
      <span className="sr-only">{label}</span>
      <span className="font-mono text-[11px] text-fg-faint">· {schemas} schemas</span>
    </span>
  )
}

function CopyAction({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
        setTimeout(() => setCopied(false), 1_200)
      }}
      title="Copy block text"
      aria-label="Copy block text"
      className="absolute right-1.5 top-1.5 rounded-md border border-line bg-surface px-1.5 py-1 font-mono text-[10px] text-fg-faint transition-colors hover:text-fg"
    >
      {copied ? 'copied' : 'copy'}
    </button>
  )
}

/**
 * One compaction attempt, from its durable log-only events: a live
 * "Compacting…" row while the summarizer runs, then the outcome — collapsed
 * facts with the summary text one click away. A failed or interrupted
 * attempt stays visible: it says what happened instead of vanishing.
 */
export const CompactionMarker = memo(function CompactionMarker({ item }: {
  readonly item: Extract<ViewItem, { kind: 'compaction' }>
}) {
  const [open, setOpen] = useState(false)
  const facts = [
    item.coversSeq !== undefined ? `through seq ${item.coversSeq}` : undefined,
    item.summaryChars !== undefined ? `${formatBytes(item.summaryChars)} summarized` : undefined,
    item.model !== undefined ? item.model : undefined,
    item.trigger !== undefined ? item.trigger : undefined,
    item.durationMs !== undefined && item.status !== 'running' ? `${(item.durationMs / 1000).toFixed(1)}s` : undefined,
  ].filter((fact) => fact !== undefined)

  if (item.status === 'running') {
    return (
      <div className="flex min-w-0 items-center gap-2 py-0.5 text-xs text-fg-muted" role="status" aria-live="polite">
        <Spinner size={12} className="shrink-0" />
        <span className="shrink-0">Compacting conversation…</span>
        {item.trigger !== undefined ? <span className="shrink-0 font-mono text-fg-faint">{item.trigger}</span> : null}
      </div>
    )
  }

  const label = item.status === 'failed'
    ? 'Compaction failed'
    : item.status === 'interrupted'
      ? 'Compaction interrupted'
      : 'Compacted'

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={item.ts !== undefined ? formatTime(item.ts) : undefined}
        className="flex min-w-0 items-center gap-2 py-0.5 text-left text-xs text-fg-muted transition-colors hover:text-fg"
      >
        <Icon name="archive" size={13} className={cn('shrink-0', item.status === 'completed' ? 'text-fg-faint' : 'text-warn')} />
        <span className="shrink-0">{label}</span>
        {facts.map((fact) => <span key={fact} className="min-w-0 font-mono text-fg-faint">{fact}</span>)}
        {item.summary !== undefined || item.error !== undefined
          ? <Icon name="chevron" size={12} className={cn('ml-auto shrink-0 text-fg-faint transition-transform', open ? 'rotate-180' : '')} />
          : null}
      </button>
      {open && item.summary !== undefined ? (
        <div className="mt-1.5 rounded-xl border border-line bg-surface px-3 py-2.5">
          <p className="m-0 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-fg-muted">{item.summary}</p>
        </div>
      ) : null}
      {open && item.error !== undefined ? (
        <div className="mt-1.5 rounded-xl border border-line bg-surface px-3 py-2.5">
          <p className="m-0 break-words font-mono text-xs leading-5 text-bad">{item.error}</p>
        </div>
      ) : null}
    </div>
  )
})

/**
 * The joined delegated-agent reports a turn continues with — one collapsed
 * line saying what came back (a child card already carries each child's own
 * status), the full report text one click away. System data the model reads,
 * so it never renders as a bubble of something the user typed.
 */
export const ContinuationMarker = memo(function ContinuationMarker({ item }: {
  readonly item: Extract<ViewItem, { kind: 'continuation' }>
}) {
  const [open, setOpen] = useState(false)
  const children = [...item.content.matchAll(/^### .+$/gm)].length
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={item.ts !== undefined ? formatTime(item.ts) : undefined}
        className="flex min-w-0 items-center gap-2 py-0.5 text-left text-xs text-fg-muted transition-colors hover:text-fg"
      >
        <Icon name="gitBranch" size={13} className="shrink-0 text-fg-faint" />
        <span className="shrink-0">Agent reports joined</span>
        {children > 0 ? <span className="min-w-0 font-mono text-fg-faint">{children} report{children === 1 ? '' : 's'}</span> : null}
        <Icon name="chevron" size={12} className={cn('ml-auto shrink-0 text-fg-faint transition-transform', open ? 'rotate-180' : '')} />
      </button>
      {open ? (
        <div className="mt-1.5 rounded-xl border border-line bg-surface px-3 py-2.5">
          <p className="m-0 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-fg-muted">{item.content}</p>
        </div>
      ) : null}
    </div>
  )
})

/**
 * One request's context record, sitting between the input and the answer it
 * produced: the collapsed line says when context was injected and how big it
 * ran; expanding reveals the full manifest — budget fill, per-source
 * breakdown, history window, pinned sources, what was omitted — plus the raw
 * text of every non-history block the request carried.
 */
export const ContextMarker = memo(function ContextMarker({ item, workspaceId, sessionId }: {
  readonly item: Extract<ViewItem, { kind: 'context' }>
  readonly workspaceId?: string | null
  readonly sessionId?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [openHash, setOpenHash] = useState<string | undefined>(undefined)
  const [bodies, setBodies] = useState<Record<string, { state: 'loading' } | { state: 'ok'; body: string } | { state: 'missing' }>>({})
  const { manifest } = item
  const fill = contextFill(manifest)
  const tone = budgetTone(fill.used, fill.limit)
  const percent = Math.round(fill.ratio * 100)
  const { sources, history, omissions, breakdown, sections } = manifest
  const role = sources.child?.definition
  const parent = sources.parentContext
  const toolNames = sources.toolNames
  const toolLabel = toolNames.length === 0
    ? 'none'
    : toolNames.length <= 8 ? toolNames.join(', ') : `${toolNames.slice(0, 8).join(', ')} +${toolNames.length - 8} more`
  const collapsedFacts = [
    `${formatTokenCount(fill.used)} tok${fill.estimated ? ' est' : ''}`,
    history.includedTurns > 0 ? `${history.includedTurns} turn${history.includedTurns === 1 ? '' : 's'}` : undefined,
    (item.requests ?? 1) > 1 ? `${item.requests} requests` : undefined,
    sources.skills.length > 0 ? `${sources.skills.length} skill${sources.skills.length === 1 ? '' : 's'}` : undefined,
    sources.memory.length > 0 ? `${sources.memory.length} mem` : undefined,
    ...(parent !== undefined ? [`${formatTokenCount(parent.chars)} chars inherited`] : []),
  ].filter((fact) => fact !== undefined)

  const toggleBody = (hash: string): void => {
    setOpenHash((current) => (current === hash ? undefined : hash))
    if (bodies[hash] !== undefined) return
    setBodies((current) => ({ ...current, [hash]: { state: 'loading' } }))
    if (workspaceId === null || workspaceId === undefined || sessionId === null || sessionId === undefined) {
      setBodies((current) => ({ ...current, [hash]: { state: 'missing' } }))
      return
    }
    void fetchContextBody(workspaceId, sessionId, hash)
      .then((result) => {
        setBodies((current) => ({ ...current, [hash]: result === null ? { state: 'missing' } : { state: 'ok', body: result.body } }))
      })
      .catch(() => {
        setBodies((current) => ({ ...current, [hash]: { state: 'missing' } }))
      })
  }

  const sectionLabel = (section: { kind: string; name?: string }): string => {
    if (section.kind === 'skill') return `skill · ${section.name ?? ''}`
    if (section.kind === 'memory') return `memory · ${section.name ?? ''}`
    if (section.kind === 'system') return 'system block'
    if (section.kind === 'compaction') return 'compaction summary'
    if (section.kind === 'parent-context') return 'parent context'
    if (section.kind === 'skill-catalog') return 'skill catalog'
    return section.kind
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={`${formatTokenCount(fill.used)}${fill.estimated ? ' estimated' : ' reported'} of ${formatTokenCount(fill.limit)} context used${item.ts !== undefined ? ` · ${formatTime(item.ts)}` : ''}`}
        className="group flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <Icon name="layers" size={13} className="shrink-0 text-fg-faint" />
        <span className="shrink-0 font-medium text-fg-muted group-hover:text-fg">Context</span>
        <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted max-sm:hidden" role="presentation" aria-hidden="true">
          <span
            className={cn('block h-full rounded-full', tone === 'ok' ? 'bg-fg-faint' : tone === 'warn' ? 'bg-warn' : 'bg-bad')}
            style={{ width: `${Math.max(percent, 3)}%` }}
          />
        </span>
        {collapsedFacts.map((fact, index) => (
          <span
            key={fact}
            className={cn(
              'shrink-0 truncate font-mono',
              index === 0 ? 'font-semibold text-fg-muted' : 'text-fg-faint',
              index > 2 && 'max-sm:hidden',
            )}
          >
            {fact}
          </span>
        ))}
        {omissions.length > 0 ? <span className="shrink-0 rounded-full bg-warn/15 px-1.5 py-px font-mono text-[10px] font-semibold text-warn">{omissions.length} omitted</span> : null}
        <Icon name="chevron" size={12} className={cn('ml-auto shrink-0 text-fg-faint transition-transform', open ? 'rotate-180' : '')} />
      </button>
      {open ? (
        <div className="mt-1.5 flex flex-col gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 shadow-sm">
          {(item.requests ?? 1) > 1 ? (
            <p className="m-0 rounded-lg bg-muted px-2.5 py-1.5 text-xs text-fg-muted">
              {item.requests} this turn — this is the latest
            </p>
          ) : null}
          <ContextDetailRow label="Window">
            <span className="flex min-w-0 flex-col gap-1.5">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[13px] font-semibold text-fg">{formatTokenCount(fill.used)}/{formatTokenCount(fill.limit)} tok</span>
                <span className={cn(
                  'rounded-full px-1.5 py-px font-mono text-[10px] font-semibold',
                  fill.estimated ? 'bg-muted text-fg-faint' : 'bg-ok-soft text-ok',
                )} title={fill.estimated ? 'Estimated (chars/4); the provider did not report usage' : 'Prompt tokens reported by the provider'}>
                  {fill.estimated ? 'est' : 'reported'}
                </span>
                <span className={cn(
                  'font-mono text-[11px] font-semibold',
                  tone === 'ok' ? 'text-fg-faint' : tone === 'warn' ? 'text-warn' : 'text-bad',
                )}>{percent}%</span>
              </span>
              <span className="h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
                <span
                  className={cn('block h-full rounded-full transition-[width]', tone === 'ok' ? 'bg-fg' : tone === 'warn' ? 'bg-warn' : 'bg-bad')}
                  style={{ width: `${percent}%` }}
                />
              </span>
            </span>
          </ContextDetailRow>
          <ContextDetailRow label="Mode">
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
              <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-fg">{manifest.modeId}</code>
              <span className="text-fg-faint">·</span>
              <span className="font-mono text-[11px]">rev {manifest.modeRevision}</span>
              {role !== undefined ? (<><span className="text-fg-faint">·</span><span className="rounded-md border border-line px-1.5 py-px text-[11px]">role {role}</span></>) : ''}
              {manifest.model !== undefined ? (<><span className="text-fg-faint">·</span><span className="truncate font-mono text-[11px]" title={manifest.model}>{manifest.model}</span></>) : ''}
            </span>
          </ContextDetailRow>
          {breakdown !== undefined ? (
            <ContextDetailRow label="Sources">
              <BreakdownList breakdown={breakdown} />
            </ContextDetailRow>
          ) : null}
          <ContextDetailRow label="History">
            <span>
              <span className="font-medium text-fg-muted">{history.setting}</span>
              <span>: {history.includedTurns} included, {history.omittedTurns} omitted</span>
              {history.includedSeqRange !== undefined ? <span className="font-mono text-[11px]"> · seq {history.includedSeqRange[0]}–{history.includedSeqRange[1]}</span> : ''}
              {history.checkpointHash !== undefined ? <span className="font-mono text-[11px] text-fg-faint" title={`checkpoint ${history.checkpointHash}`}> · checkpoint {history.checkpointHash.slice(0, 12)}</span> : ''}
            </span>
          </ContextDetailRow>
          <ContextDetailRow label="Tools">
            <ToolChips names={toolNames} schemas={sources.toolSchemas} label={toolLabel} />
          </ContextDetailRow>
          {sections !== undefined && sections.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-line pt-2">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-fg-faint">Blocks · {sections.length}</span>
              {sections.map((section) => {
                const isOpen = openHash === section.hash
                const state = bodies[section.hash]
                const kindIcon = section.kind === 'system' ? 'sliders' : section.kind === 'memory' ? 'pin' : section.kind === 'skill' ? 'zap' : section.kind === 'compaction' ? 'archive' : 'fileText'
                return (
                  <div key={section.hash} className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => toggleBody(section.hash)}
                      aria-expanded={isOpen}
                      title={`Read the raw ${sectionLabel(section)} this request carried · sha256 ${section.hash}`}
                      className={cn(
                        'flex min-w-0 items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-xs text-fg-muted transition-colors hover:border-line hover:bg-muted/60 hover:text-fg',
                        isOpen && 'border-line bg-muted/60 text-fg',
                      )}
                    >
                      <Icon name={kindIcon} size={13} className="shrink-0 text-fg-faint" />
                      <span className="min-w-0 flex-1 truncate font-medium">{sectionLabel(section)}</span>
                      <span className="shrink-0 font-mono text-[11px] text-fg-faint">{section.chars.toLocaleString()} chars</span>
                      <span className="shrink-0 font-mono text-[11px] text-fg-faint/70 max-sm:hidden" title={`sha256 ${section.hash}`}>{section.hash.slice(0, 8)}</span>
                      <Icon name="chevron" size={12} className={cn('shrink-0 text-fg-faint transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && state?.state === 'ok' ? (
                      <div className="relative">
                        <pre className={cn(preClass, 'max-h-80 pr-10 text-[11px]')}>{state.body}</pre>
                        <CopyAction text={state.body} />
                      </div>
                    ) : null}
                    {isOpen && state?.state === 'loading' ? <span className="flex items-center gap-1.5 px-2 text-xs text-fg-faint"><Spinner size={12} /> Loading block…</span> : null}
                    {isOpen && state?.state === 'missing' ? (
                      <span className="px-2 text-xs text-warn">Not recorded — this block predates body recording, or its content changed since.</span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : (
            <>
              {sources.instructionsHash !== undefined ? (
                <ContextDetailRow label="Instructions"><span className="font-mono" title={`sha256 ${sources.instructionsHash}`}>{sources.instructionsHash.slice(0, 12)}</span></ContextDetailRow>
              ) : null}
              {sources.skills.length > 0 ? (
                <ContextDetailRow label="Skills">
                  <span className="flex flex-wrap gap-1">
                    {sources.skills.map((skill) => <code key={skill} title={skill} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">{shortSource(skill)}</code>)}
                  </span>
                </ContextDetailRow>
              ) : null}
              {sources.memory.length > 0 ? (
                <ContextDetailRow label="Memory">
                  <span className="flex flex-wrap gap-1">
                    {sources.memory.map((entry) => <code key={entry} title={entry} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">{shortSource(entry)}</code>)}
                  </span>
                </ContextDetailRow>
              ) : null}
              {parent !== undefined ? (
                <ContextDetailRow label="Parent ctx">
                  <span className="font-mono" title={`sha256 ${parent.hash}`}>{parent.chars.toLocaleString()} chars · {parent.hash.slice(0, 12)}</span>
                </ContextDetailRow>
              ) : null}
            </>
          )}
          {omissions.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-line pt-2">
              {omissions.map((omission) => (
                <span key={omission} className="flex min-w-0 items-start gap-1.5 break-words text-xs text-warn">
                  <Icon name="alertTriangle" size={12} className="mt-0.5 shrink-0" />
                  <span><span className="font-semibold">omitted:</span> {omission.replace(/^omitted:\s*/, '')}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

const REASONS: Readonly<Record<string, string>> = {
  interrupted: 'Interrupted · inspect results before continuing',
  cancelled: 'Stopped by you',
  steered: 'Redirected · your new message runs next',
  limit: 'Limit reached',
  stopped: 'Stopped by you',
  rejected: 'Rejected',
  empty: 'No content',
  failed: 'Failed',
}

export function StatusLine({ reason, onRetry, toolsRan = false }: {
  readonly reason: string
  readonly onRetry?: () => void
  /** Tools already ran in the failed turn: Retry asks first, since it could repeat them. */
  readonly toolsRan?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  if (!reason.startsWith('Permission decision') && reason.includes(':')) {
    // Quiet by design: a failed request is a line to act on, not a red slab —
    // repeated attempts stack, and three of these must still read as a
    // transcript. The raw reason is the message, truncated; the full text
    // rides on hover, and retry safety rides on the button.
    return (
      <div className="flex items-center gap-2 text-xs text-fg-muted" role="alert">
        <span className="h-px w-6 bg-line" aria-hidden="true" />
        <Icon name="alertTriangle" size={13} className="shrink-0 text-bad" />
        <span className="min-w-0 truncate" title={reason}>{reason}</span>
        {onRetry !== undefined ? (
          <button
            type="button"
            onClick={toolsRan ? () => setConfirming(true) : onRetry}
            title={toolsRan ? 'Tools already ran in this turn; retrying may repeat them' : 'Nothing was executed, so retrying is safe'}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-fg-muted hover:bg-muted hover:text-fg"
          >
            Retry
          </button>
        ) : null}
        {onRetry !== undefined && toolsRan ? (
          <ConfirmDialog
            open={confirming}
            title="Retry this request?"
            confirmLabel="Retry anyway"
            body={<p className="m-0">Tools already ran in this turn before it failed. Retrying sends the same message again, and the model may repeat those tool calls — including writes, commands, or external requests. Inspect their results first.</p>}
            onConfirm={() => { setConfirming(false); onRetry() }}
            onDismiss={() => setConfirming(false)}
          />
        ) : null}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      <span className="h-px w-6 bg-line" aria-hidden="true" />
      <span>{REASONS[reason] ?? reason}</span>
    </div>
  )
}

/**
 * Back to the tail. `unseen` counts rows that arrived while the reader was
 * away, so the button says whether anything is actually waiting below.
 */
export function JumpToBottom({ unseen = 0, onClick }: { readonly unseen?: number; readonly onClick: () => void }) {
  const label = unseen > 0 ? `Jump to latest · ${unseen} new` : 'Jump to latest'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'absolute bottom-3 left-1/2 z-10 flex min-h-9 -translate-x-1/2 items-center justify-center gap-1.5 rounded-full border border-line bg-bg text-fg shadow-pop animate-fade-up hover:bg-muted',
        unseen > 0 ? 'px-3' : 'size-9',
      )}
    >
      <Icon name="arrowDown" size={16} />
      {unseen > 0 ? <span className="text-[13px] font-medium">{unseen} new</span> : null}
    </button>
  )
}
