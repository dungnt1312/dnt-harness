import { describe, expect, it } from 'vitest'
import {
  ANCHOR_VIEW,
  WORKBENCH_DEFAULTS,
  clampInspectorTab,
  clampPanelWidth,
  parseWorkbenchPreferences,
} from './workbench-preferences.ts'

describe('workbench preferences', () => {
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
      inspectorTab: 'trajectory',
      inspectorViews: ['files', 'trajectory'],
    }))).toMatchObject({
      leftWidth: 420,
      rightWidth: 360,
      leftCollapsed: true,
      rightCollapsed: false,
      inspectorTab: 'trajectory',
      inspectorViews: ['files', 'trajectory'],
    })
  })

  it('falls back field by field without discarding valid widths', () => {
    expect(parseWorkbenchPreferences(JSON.stringify({
      leftWidth: 300,
      rightWidth: 400,
      leftCollapsed: 'no',
      rightCollapsed: null,
      inspectorTab: 'invalid',
    }))).toEqual({
      leftWidth: 300,
      rightWidth: 400,
      leftCollapsed: false,
      rightCollapsed: false,
      inspectorTab: 'files',
      inspectorViews: ['files'],
      terminalShell: null,
      terminalOpen: false,
      terminalHeight: 280,
    })
  })

  it('keeps the anchor and dedupes the opened strip without folding the selection back in', () => {
    // A stored strip is the record of what is open: the selected view is
    // *not* added to it, or closing that tab would re-add it and take two
    // clicks. Here 'trajectory' is selected but deliberately not open.
    expect(parseWorkbenchPreferences(JSON.stringify({
      inspectorTab: 'bogus',
      inspectorViews: ['context', 'context', 'bogus'],
    }))).toMatchObject({
      inspectorViews: ['files', 'context'],
      inspectorTab: 'files',
    })

    // A strip stored without the anchor must not leave the workbench tabless.
    expect(parseWorkbenchPreferences(JSON.stringify({
      inspectorTab: 'files',
      inspectorViews: 'not-an-array',
    })).inspectorViews).toEqual(['files'])
  })

  it('seeds the strip from the selection when no strip was ever recorded', () => {
    // Storage written before inspectorViews existed has only the selection as
    // evidence of what was open.
    expect(parseWorkbenchPreferences(JSON.stringify({ inspectorTab: 'trajectory' }))).toMatchObject({
      inspectorViews: ['files', 'trajectory'],
      inspectorTab: 'trajectory',
    })
    // Terminal is a workbench tab again, so a stored selection seeds the strip.
    expect(parseWorkbenchPreferences(JSON.stringify({ inspectorTab: 'terminal' }))).toMatchObject({
      inspectorViews: ['files', 'terminal'],
      inspectorTab: 'terminal',
    })
  })

  it('clamps the selection to an open tab, falling back to the anchor', () => {
    expect(clampInspectorTab('trajectory', ['files', 'trajectory'])).toBe('trajectory')
    expect(clampInspectorTab('trajectory', ['files'])).toBe(ANCHOR_VIEW)
    expect(clampInspectorTab('terminal', ['files', 'terminal'])).toBe('terminal')
    expect(clampInspectorTab('bogus', ['files'])).toBe(ANCHOR_VIEW)
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
