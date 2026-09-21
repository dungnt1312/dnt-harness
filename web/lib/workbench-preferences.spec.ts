import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_DEFAULTS,
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
      inspectorTab: 'artifacts',
    }))).toMatchObject({
      leftWidth: 420,
      rightWidth: 360,
      leftCollapsed: true,
      rightCollapsed: false,
      inspectorTab: 'artifacts',
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
    })
  })

  it('keeps the anchor and the selected view in the opened strip', () => {
    expect(parseWorkbenchPreferences(JSON.stringify({
      inspectorTab: 'terminal',
      inspectorViews: ['context', 'context', 'bogus'],
    })).inspectorViews).toEqual(['files', 'context', 'terminal'])

    // A strip stored without the anchor must not leave the workbench tabless.
    expect(parseWorkbenchPreferences(JSON.stringify({
      inspectorTab: 'files',
      inspectorViews: 'not-an-array',
    })).inspectorViews).toEqual(['files'])
  })

  it('clamps each panel only within its own range', () => {
    expect(clampPanelWidth('left', 231)).toBe(232)
    expect(clampPanelWidth('left', 421)).toBe(420)
    expect(clampPanelWidth('right', 359)).toBe(360)
    expect(clampPanelWidth('right', 1101)).toBe(1100)
    expect(clampPanelWidth('right', Number.NaN)).toBe(560)
  })
})
