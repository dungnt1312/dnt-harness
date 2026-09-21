/** The fixed workbench views. Files is the anchor and is always open. */
export type WorkbenchViewName = 'files' | 'context' | 'artifacts' | 'agents' | 'terminal'

/** The view that can never be closed, so the workbench is never tabless. */
export const ANCHOR_VIEW: WorkbenchViewName = 'files'

export interface WorkbenchPreferencesV1 {
  readonly leftWidth: number
  readonly rightWidth: number
  readonly leftCollapsed: boolean
  readonly rightCollapsed: boolean
  /** Selected fixed workbench view; opened file tabs are transient. */
  readonly inspectorTab: WorkbenchViewName
  /**
   * View tabs the operator has opened, in strip order. Views are added from
   * the nav's picker rather than all being shown at once, so the strip stays
   * short; 'files' and the selected view are always part of it.
   */
  readonly inspectorViews: readonly WorkbenchViewName[]
  /**
   * Shell the Terminal view opens without being asked. `null` defers to the
   * host's own order, which prefers Git Bash and falls back to PowerShell on
   * Windows — the id is validated against the host's catalog before use, so a
   * remembered shell that is no longer installed cannot strand the view.
   */
  readonly terminalShell: string | null
}

export const WORKBENCH_STORAGE_KEY = 'mini-dsh.workbench.v1'

export const WORKBENCH_DEFAULTS: WorkbenchPreferencesV1 = {
  leftWidth: 280,
  rightWidth: 560,
  leftCollapsed: false,
  rightCollapsed: false,
  inspectorTab: 'files',
  inspectorViews: ['files'],
  terminalShell: null,
}

export const PANEL_LIMITS = {
  left: { min: 232, max: 420, default: 280 },
  right: { min: 360, max: 1100, default: 560 },
} as const

export function clampPanelWidth(side: 'left' | 'right', value: number): number {
  const limits = PANEL_LIMITS[side]
  if (!Number.isFinite(value)) return limits.default
  return Math.min(limits.max, Math.max(limits.min, value))
}

function isInspectorTab(value: unknown): value is WorkbenchViewName {
  return value === 'files' || value === 'context' || value === 'artifacts' || value === 'agents' || value === 'terminal'
}

/**
 * Normalize the opened-view strip. The anchor and the selected view are forced
 * in, so a hand-edited or stale entry can never leave the workbench showing a
 * view with no tab — or no tab at all.
 */
export function normalizeInspectorViews(value: unknown, active: WorkbenchViewName): readonly WorkbenchViewName[] {
  const stored = Array.isArray(value) ? value.filter(isInspectorTab) : []
  return [...new Set<WorkbenchViewName>(['files', ...stored, active])]
}

export function parseWorkbenchPreferences(raw: string | null): WorkbenchPreferencesV1 {
  if (raw === null) return WORKBENCH_DEFAULTS

  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return WORKBENCH_DEFAULTS
    const record = parsed as Record<string, unknown>
    const inspectorTab = isInspectorTab(record.inspectorTab) ? record.inspectorTab : WORKBENCH_DEFAULTS.inspectorTab
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
      inspectorTab,
      inspectorViews: normalizeInspectorViews(record.inspectorViews, inspectorTab),
      terminalShell: typeof record.terminalShell === 'string' && record.terminalShell !== ''
        ? record.terminalShell
        : WORKBENCH_DEFAULTS.terminalShell,
    }
  } catch {
    return WORKBENCH_DEFAULTS
  }
}
