/** The bundled command layer: lowest precedence, and the shipped /image and /video files are well-formed. */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandsService } from '../../src/harness/commands/service.ts'
import { loadCommandLayers, scanCommandsDir } from '../../src/harness/commands/catalog.ts'
import { expandCommand } from '../../src/harness/commands/invoke.ts'
import { allowedByRules } from '../../src/harness/commands/allowed-tools.ts'

const SHIPPED = path.resolve(import.meta.dirname, '../../commands')

let root = ''
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-bundled-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

const write = async (rel: string, content: string): Promise<void> => {
  const file = path.join(root, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

describe('bundled command layer', () => {
  it('is the lowest layer: user, workspace, and project commands of the same name replace it', async () => {
    await write('app/commands/same.md', 'BUNDLED')
    await write('app/commands/only.md', 'ONLY BUNDLED')
    await write('user/commands/same.md', 'USER')
    const service = new CommandsService(path.join(root, 'data'), {
      bundledDir: path.join(root, 'app/commands'),
      userClaudeDir: path.join(root, 'user'),
      homeDir: root,
    })
    const rows = (await service.catalog('ws')).rows
    expect(rows.map((row) => `${row.name}:${row.source}`)).toEqual(['only:bundled', 'same:user'])
    await write('data/workspaces/ws/commands/same.md', 'WORKSPACE')
    expect((await service.find('ws', undefined, 'same'))?.source).toBe('workspace')
    expect((await service.find('ws', undefined, 'ONLY'))?.source).toBe('bundled')
  })

  it('a missing bundled folder is no error and no command', async () => {
    const service = new CommandsService(path.join(root, 'data'), { bundledDir: path.join(root, 'nowhere'), homeDir: root })
    expect(await service.catalog('ws')).toEqual({ rows: [], errors: [] })
  })

  it('without a bundled folder the layers are unchanged', async () => {
    const service = new CommandsService(path.join(root, 'data'), { homeDir: root })
    expect((await service.layers('ws')).map((layer) => layer.source)).toEqual(['workspace'])
  })
})

describe('shipped commands/', () => {
  it('declares /image and /video with a hint, a one-tool grant, and no model invocation', async () => {
    const { rows, errors } = await scanCommandsDir(SHIPPED, { source: 'bundled' })
    expect(errors).toEqual([])
    expect(rows.map((row) => row.name)).toEqual(['image', 'video'])
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]))
    expect(byName['image']).toMatchObject({ allowedTools: ['GenerateImage'], disableModelInvocation: true, userInvocable: true, argumentHint: '<describe the image>' })
    expect(byName['video']).toMatchObject({ allowedTools: ['GenerateVideo'], disableModelInvocation: true, userInvocable: true, argumentHint: '<describe the video>' })
    // No notes: every frontmatter key is one the harness enforces.
    expect(rows.every((row) => row.notes === undefined)).toBe(true)
  })

  it('grants exactly its own tool, and not the other paid tool, for the turn', async () => {
    const { rows } = await loadCommandLayers([{ source: 'bundled', dir: SHIPPED }])
    const image = rows.find((row) => row.name === 'image')!
    const call = (name: string) => ({ name, args: { prompt: 'x' } })
    expect(allowedByRules(image.allowedTools, call('GenerateImage'))).toBe(true)
    expect(allowedByRules(image.allowedTools, call('GenerateVideo'))).toBe(false)
    expect(allowedByRules(image.allowedTools, call('EditImage'))).toBe(false)
    expect(allowedByRules(image.allowedTools, { name: 'Bash', args: { command: 'ls' } })).toBe(false)
    const video = rows.find((row) => row.name === 'video')!
    expect(allowedByRules(video.allowedTools, call('GenerateVideo'))).toBe(true)
    expect(allowedByRules(video.allowedTools, call('GenerateImage'))).toBe(false)
  })

  it('puts the typed description into the prompt exactly once, safely', async () => {
    const { rows } = await loadCommandLayers([{ source: 'bundled', dir: SHIPPED }])
    for (const name of ['image', 'video']) {
      const command = rows.find((row) => row.name === name)!
      const expanded = await expandCommand(command, 'a fox in "deep snow" $HOME !`id`', {})
      expect(expanded.split('a fox in "deep snow" $HOME').length - 1).toBe(1)
      // No ARGUMENTS: footer: the body already places the text.
      expect(expanded).not.toMatch(/\nARGUMENTS:/)
      // Argument text can never become an inline shell marker.
      expect(expanded).not.toMatch(/(^|\s)!`id`/)
      // An empty call tells the model to ask, not to call the tool.
      expect(await expandCommand(command, '', {})).toMatch(/do not call the tool/)
    }
  })
})
