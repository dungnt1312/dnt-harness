/**
 * The fixed workbench views. Files is the anchor and is always open. Terminal
 * is one of them: a closable tab beside Files, Git, and the rest. The chat
 * column has its own terminal, a footer that stays hidden until Ctrl+`.
 */
export type WorkbenchViewName = 'files' | 'context' | 'trajectory' | 'agents' | 'git' | 'terminal' | 'process'

/** The view that can never be closed, so the workbench is never tabless. */
export const ANCHOR_VIEW: WorkbenchViewName = 'files'

export interface WorkbenchPreferencesV1 {
  readonly leftWidth: number
  readonly rightWidth: number
  readonly leftCollapsed: boolean
  readonly rightCollapsed: boolean
  /**
   * Shell the Terminal view opens without being asked. `null` defers to the
   * host's own order, which prefers Git Bash and falls back to PowerShell on
   * Windows — the id is validated against the host's catalog before use, so a
   * remembered shell that is no longer installed cannot strand the view.
   */
  readonly terminalShell: string | null
  /** Whether the terminal footer under the chat is shown. Ctrl+` toggles it. */
  readonly terminalOpen: boolean
  /** Height of the terminal dock in CSS pixels. */
  readonly terminalHeight: number
}

export const WORKBENCH_STORAGE_KEY = 'dnt-harness.workbench.v1'

export const WORKBENCH_DEFAULTS: WorkbenchPreferencesV1 = {
  leftWidth: 280,
  rightWidth: 560,
  leftCollapsed: false,
  rightCollapsed: false,
  terminalShell: null,
  terminalOpen: false,
  terminalHeight: 280,
}

/**
 * The workbench tab strip and the selected view, recorded per conversation:
 * every session keeps its own open tabs, so one conversation's Trajectory or
 * Process tab never leaks into another. A conversation without a record yet —
 * and the draft before its first message, under the shared `draft` key —
 * starts from {@link WORKBENCH_TABS_DEFAULTS}. Widths, collapse and the
 * terminal stay one global preference ({@link WorkbenchPreferencesV1}).
 */
export interface WorkbenchSessionTabs {
  /** Selected fixed workbench view; opened file tabs are transient. */
  readonly inspectorTab: WorkbenchViewName
  /**
   * View tabs the operator has opened, in strip order. Views are added from
   * the nav's picker rather than all being shown at once, so the strip stays
   * short; 'files' is always part of it. This list is the record of what is
   * open, so nothing is folded back into it — see
   * {@link normalizeInspectorViews}.
   */
  readonly inspectorViews: readonly WorkbenchViewName[]
}

export const WORKBENCH_TABS_DEFAULTS: WorkbenchSessionTabs = {
  inspectorTab: ANCHOR_VIEW,
  inspectorViews: [ANCHOR_VIEW],
}

export const WORKBENCH_TABS_STORAGE_KEY = 'dnt-harness.workbench.tabs.v1'

/** Opened tab strips keyed by `<workspaceId>:<sessionId>`, plus `draft`. */
export type WorkbenchTabsRecord = Record<string, WorkbenchSessionTabs>

/**
 * Normalize one conversation's tab state: the strip is validated (anchor
 * forced in, duplicates and unknown names dropped) and the selection clamped
 * to a tab that is actually open. Used on both load and write, so a stale or
 * hand-edited record can never leave the workbench tabless.
 */
export function normalizeWorkbenchTabs(tab: unknown, views: unknown): WorkbenchSessionTabs {
  const inspectorViews = normalizeInspectorViews(views)
  return {
    inspectorTab: clampInspectorTab(tab, inspectorViews),
    inspectorViews,
  }
}

export function parseWorkbenchTabs(raw: string | null): WorkbenchTabsRecord {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    const tabs: WorkbenchTabsRecord = {}
    for (const [key, value] of Object.entries(record)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const entry = value as Record<string, unknown>
      tabs[key] = normalizeWorkbenchTabs(entry.inspectorTab, entry.inspectorViews)
    }
    return tabs
  } catch {
    return {}
  }
}

/**
 * The tab fields of the old global preference, kept only as the seed for
 * conversations without their own record. The split into per-session records
 * reads these once, so an upgrade does not reset every conversation to a bare
 * Files tab; it fades out as sessions gain records of their own.
 */
export function parseWorkbenchLegacyTabs(raw: string | null): WorkbenchSessionTabs {
  if (raw === null) return WORKBENCH_TABS_DEFAULTS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return WORKBENCH_TABS_DEFAULTS
    const record = parsed as Record<string, unknown>
    // Storage written before inspectorViews existed has only the selection as
    // evidence of what was open, so it seeds the strip.
    const stored = Array.isArray(record.inspectorViews)
      ? record.inspectorViews
      : (isInspectorTab(record.inspectorTab) ? [record.inspectorTab] : [])
    return normalizeWorkbenchTabs(record.inspectorTab, stored)
  } catch {
    return WORKBENCH_TABS_DEFAULTS
  }
}

export const PANEL_LIMITS = {
  left: { min: 232, max: 420, default: 280 },
  right: { min: 360, max: 1100, default: 560 },
  terminal: { min: 120, max: 900, default: 280 },
} as const

export function clampPanelWidth(side: 'left' | 'right' | 'terminal', value: number): number {
  const limits = PANEL_LIMITS[side]
  if (!Number.isFinite(value)) return limits.default
  return Math.min(limits.max, Math.max(limits.min, value))
}

function isInspectorTab(value: unknown): value is WorkbenchViewName {
  return value === 'files' || value === 'context' || value === 'trajectory' || value === 'agents' || value === 'git' || value === 'terminal' || value === 'process'
}

/**
 * Normalize the opened-view strip. The anchor is forced in, so a hand-edited
 * or stale entry can never leave the workbench tabless.
 *
 * The selected view is deliberately *not* folded in here. Folding it in made
 * the strip un-closable: closing the selected tab writes the selection and the
 * strip as two separate patches, and re-adding the selected view put the tab
 * straight back — the first click looked ignored, and only a second one (by
 * which time the selection had moved) took effect. The strip is the record of
 * what is open; the selection is clamped to it instead
 * ({@link clampInspectorTab}).
 */
export function normalizeInspectorViews(value: unknown): readonly WorkbenchViewName[] {
  const stored = Array.isArray(value) ? value.filter(isInspectorTab) : []
  return [...new Set<WorkbenchViewName>(['files', ...stored])]
}

/**
 * The selected view, clamped to a tab that is actually open. A stored
 * selection whose tab is gone falls back to the anchor rather than reopening
 * the view the operator just closed.
 */
export function clampInspectorTab(active: unknown, views: readonly WorkbenchViewName[]): WorkbenchViewName {
  return isInspectorTab(active) && views.includes(active) ? active : ANCHOR_VIEW
}

export function parseWorkbenchPreferences(raw: string | null): WorkbenchPreferencesV1 {
  if (raw === null) return WORKBENCH_DEFAULTS

  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return WORKBENCH_DEFAULTS
    const record = parsed as Record<string, unknown>
    return {
      leftWidth: typeof record.leftWidth === 'number'
        ? clampPanelWidth('left', record.leftWidth)
        : WORKBENCH_DEFAULTS.leftWidth,
      rightWidth: typeof record.rightWidth === 'number'
        ? clampPanelWidth('right', record.rightWidth)
        : WORKBENCH_DEFAULTS.rightWidth,
      leftCollapsed: typeof record.leftCollapsed === 'boolean'
        ? record.leftCollapsed
        : WORKBENCH_DEFAULTS.leftCollapsed,
      rightCollapsed: typeof record.rightCollapsed === 'boolean'
        ? record.rightCollapsed
        : WORKBENCH_DEFAULTS.rightCollapsed,
      terminalShell: typeof record.terminalShell === 'string' && record.terminalShell !== ''
        ? record.terminalShell
        : WORKBENCH_DEFAULTS.terminalShell,
      terminalOpen: typeof record.terminalOpen === 'boolean'
        ? record.terminalOpen
        : WORKBENCH_DEFAULTS.terminalOpen,
      terminalHeight: typeof record.terminalHeight === 'number'
        ? clampPanelWidth('terminal', record.terminalHeight)
        : WORKBENCH_DEFAULTS.terminalHeight,
    }
  } catch {
    return WORKBENCH_DEFAULTS
  }
}
