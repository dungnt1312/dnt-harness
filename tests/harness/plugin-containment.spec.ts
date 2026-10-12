/** Plugin component paths stay inside the plugin after symlink resolution. */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPluginTreeContained, parseManifest, resolveComponents } from 'dnt-harness'

const dirs: string[] = []
const temp = async (prefix: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe('plugin component containment', () => {
  it('ignores default and manifest component symlinks that escape the plugin', async () => {
    if (process.platform === 'win32') return
    const plugin = await temp('plugin-root-')
    const outside = await temp('plugin-outside-')
    await fs.writeFile(path.join(outside, 'outside.md'), 'outside')
    await fs.writeFile(path.join(outside, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }))
    await fs.writeFile(path.join(outside, 'mcp.json'), JSON.stringify({ x: { type: 'http', url: 'https://x' } }))
    await fs.symlink(outside, path.join(plugin, 'commands'), 'dir')
    await fs.symlink(path.join(outside, 'outside.md'), path.join(plugin, 'agent.md'), 'file')
    await fs.symlink(path.join(outside, 'hooks.json'), path.join(plugin, 'hooks.json'), 'file')
    await fs.symlink(path.join(outside, 'mcp.json'), path.join(plugin, 'mcp.json'), 'file')

    const manifest = parseManifest({
      name: 'escape',
      agents: './agent.md',
      hooks: './hooks.json',
      mcpServers: './mcp.json',
    })
    const components = await resolveComponents(plugin, manifest)
    expect(components.commandDirs).toEqual([])
    expect(components.agentFiles).toEqual([])
    expect(components.hooks).toBeUndefined()
    expect(components.mcpServers).toBeUndefined()
    expect(components.notes.join('\n')).toMatch(/outside the plugin after symlink resolution/)
  })

  it('refuses a plugin tree with a nested symlink that escapes, and allows internal ones', async () => {
    if (process.platform === 'win32') return
    const plugin = await temp('plugin-tree-')
    const outside = await temp('plugin-tree-outside-')
    await fs.writeFile(path.join(outside, 'secret.md'), 'secret')
    await fs.mkdir(path.join(plugin, 'skills', 'x'), { recursive: true })
    await fs.writeFile(path.join(plugin, 'skills', 'x', 'SKILL.md'), '---\ndescription: x\n---\nbody')
    await fs.symlink(path.join(plugin, 'skills', 'x', 'SKILL.md'), path.join(plugin, 'skills', 'x', 'alias.md'), 'file')
    await expect(assertPluginTreeContained(plugin)).resolves.toBeUndefined()

    await fs.mkdir(path.join(plugin, 'commands', 'deep'), { recursive: true })
    await fs.symlink(path.join(outside, 'secret.md'), path.join(plugin, 'commands', 'deep', 'leak.md'), 'file')
    await expect(assertPluginTreeContained(plugin)).rejects.toThrow(/escapes the plugin root/)
  })
})
