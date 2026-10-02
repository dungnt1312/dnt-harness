import { describe, expect, it } from 'vitest'
import {
  ANCHOR_VIEW,
  WORKBENCH_DEFAULTS,
  WORKBENCH_TABS_DEFAULTS,
  clampInspectorTab,
  clampPanelWidth,
  normalizeWorkbenchTabs,
  parseWorkbenchLegacyTabs,
  parseWorkbenchPreferences,
  parseWorkbenchTabs,
} from './workbench-preferences.ts'

describe('workbench preferences (global panel state)', () => {
  it('uses defaults for absent or malformed storage', () => {
    expect(parseWorkbenchPreferences(null)).toEqual(WORKBENCH_DEFAULTS)
    expect(parseWorkbenchPreferences('{broken')).toEqual(WORKBENCH_DEFAULTS)
  })

  it('clamps independently validated persisted widths', () => {
    expect(parseWorkbenchPreferences(JSON.stringify({
      leftWidth: 9999,
      rightWidth: -1,
      leftCollapsed: true,
      rightCollapsed: false,
    }))).toMatchObject({
      leftWidth: 420,
      rightWidth: 360,
      leftCollapsed: true,
      rightCollapsed: false,
    })
  })

  it('falls back field by field without discarding valid widths', () => {
    expect(parseWorkbenchPreferences(JSON.stringify({
      leftWidth: 300,
      rightWidth: 400,
      leftCollapsed: 'no',
      rightCollapsed: null,
    }))).toEqual({
      leftWidth: 300,
      rightWidth: 400,
      leftCollapsed: false,
      rightCollapsed: false,
      terminalShell: null,
      terminalOpen: false,
      terminalHeight: 280,
    })
  })

  it('ignores the legacy tab fields that moved to per-session records', () => {
    expect(parseWorkbenchPreferences(JSON.stringify({ inspectorTab: 'trajectory', inspectorViews: ['files', 'trajectory'] })))
      .toEqual(WORKBENCH_DEFAULTS)
  })

  it('clamps each panel only within its own range', () => {
    expect(clampPanelWidth('left', 231)).toBe(232)
    expect(clampPanelWidth('left', 421)).toBe(420)
    expect(clampPanelWidth('right', 359)).toBe(360)
    expect(clampPanelWidth('right', 1101)).toBe(1100)
    expect(clampPanelWidth('right', Number.NaN)).toBe(560)
    expect(clampPanelWidth('terminal', 50)).toBe(120)
    expect(clampPanelWidth('terminal', 2000)).toBe(900)
  })
})

describe('per-session workbench tabs', () => {
  it('keeps the anchor and dedupes the opened strip without folding the selection back in', () => {
    // A stored strip is the record of what is open: the selected view is
    // *not* added to it, or closing that tab would re-add it and take two
    // clicks. Here 'trajectory' is selected but deliberately not open.
    expect(normalizeWorkbenchTabs('bogus', ['context', 'context', 'bogus'])).toEqual({
      inspectorViews: ['files', 'context'],
      inspectorTab: 'files',
    })
    // A strip stored without the anchor must not leave the workbench tabless.
    expect(normalizeWorkbenchTabs('files', 'not-an-array')).toEqual({
      inspectorViews: ['files'],
      inspectorTab: 'files',
    })
  })

  it('clamps the selection to an open tab, falling back to the anchor', () => {
    expect(clampInspectorTab('trajectory', ['files', 'trajectory'])).toBe('trajectory')
    expect(clampInspectorTab('trajectory', ['files'])).toBe(ANCHOR_VIEW)
    expect(clampInspectorTab('terminal', ['files', 'terminal'])).toBe('terminal')
    expect(clampInspectorTab('bogus', ['files'])).toBe(ANCHOR_VIEW)
  })

  it('parses one record entry per conversation, dropping malformed entries', () => {
    const record = parseWorkbenchTabs(JSON.stringify({
      'w1:s1': { inspectorTab: 'trajectory', inspectorViews: ['files', 'trajectory'] },
      'w1:s2': { inspectorTab: 'files' },
      'w1:bad': null,
      'w1:bad2': 'nope',
    }))
    expect(record['w1:s1']).toEqual({ inspectorTab: 'trajectory', inspectorViews: ['files', 'trajectory'] })
    // A conversation remembered as closed-to-Files stays distinct from one
    // never recorded: an entry is evidence, its absence is not.
    expect(record['w1:s2']).toEqual({ inspectorTab: 'files', inspectorViews: ['files'] })
    expect(record['w1:bad']).toBeUndefined()
    expect(record['w1:bad2']).toBeUndefined()
  })

  it('uses an empty record for absent or malformed storage', () => {
    expect(parseWorkbenchTabs(null)).toEqual({})
    expect(parseWorkbenchTabs('{broken')).toEqual({})
    expect(parseWorkbenchTabs(JSON.stringify(['w1:s1']))).toEqual({})
  })

  it('seeds from the legacy global tab fields for the upgrade path', () => {
    expect(parseWorkbenchLegacyTabs(JSON.stringify({ inspectorTab: 'trajectory', inspectorViews: ['files', 'trajectory'] })))
      .toEqual({ inspectorTab: 'trajectory', inspectorViews: ['files', 'trajectory'] })
    // Storage written before inspectorViews existed has only the selection as
    // evidence of what was open.
    expect(parseWorkbenchLegacyTabs(JSON.stringify({ inspectorTab: 'trajectory' })))
      .toEqual({ inspectorTab: 'trajectory', inspectorViews: ['files', 'trajectory'] })
    expect(parseWorkbenchLegacyTabs(null)).toEqual(WORKBENCH_TABS_DEFAULTS)
    expect(parseWorkbenchLegacyTabs('{broken')).toEqual(WORKBENCH_TABS_DEFAULTS)
  })
})
