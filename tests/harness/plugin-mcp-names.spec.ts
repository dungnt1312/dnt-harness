/**
 * A plugin's server name is derived, not chosen by the user, so it must always
 * satisfy the rule for names being written (`validateNewServerName`): sanitizing
 * `.` or a trailing `_` must not produce `__` or an edge underscore, or the
 * plugin's server would be refused at sync and silently vanish.
 */
import { describe, expect, it } from 'vitest'
import { validateNewServerName } from '../../src/harness/mcp/config.ts'
import { pluginServerName } from '../../src/harness/plugins/mcp.ts'

describe('pluginServerName', () => {
  it('keeps ordinary names identical to Claude\'s (plugin_<plugin>_<server>)', () => {
    expect(pluginServerName('toolkit', 'docs')).toBe('plugin_toolkit_docs')
    expect(pluginServerName('my.plugin', 'api')).toBe('plugin_my_plugin_api')
    expect(pluginServerName('x', 'my server')).toBe('plugin_x_my_server')
  })

  it.each([
    ['a_', 'b'],
    ['a.', 'b'],
    ['x', 'y_'],
    ['x', 'docs.'],
    ['x', '_y'],
    ['x', 'a..b'],
    ['x', '...'],
  ])('always yields a name that is allowed to be written: %s / %s', (plugin, server) => {
    expect(() => validateNewServerName(pluginServerName(plugin, server))).not.toThrow()
  })
})
