import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sendPreviewTool, SEND_PREVIEW_TOOL } from '../../src/harness/tools/preview-tool.ts'
import { resolveInGrants } from '../../src/capabilities/fs/grants.ts'
import type { ToolExecution } from '../../src/harness/tools/types.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])
const ID = 'a'.repeat(64)
const STORED = 'e'.repeat(64)

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'preview-'))
  await fs.writeFile(path.join(root, 'shot.png'), PNG)
  await fs.writeFile(path.join(root, 'notes.txt'), 'not an image')
  const exec: ToolExecution = { root, workspaceId: 'ws-1' }
  const stored: Buffer[] = []
  const tool = sendPreviewTool({
    store: async (_ws, input) => { stored.push(input.bytes); return { id: STORED, name: input.name, mediaType: 'image/png', bytes: input.bytes.length } },
    read: async (ws, id) => {
      if (ws !== 'ws-1' || id !== ID) throw new Error(`attachment '${id}' is not stored in this workspace`)
      return { bytes: PNG, mediaType: 'image/png' }
    },
    resolvePath: (run, target) => resolveInGrants(run, target, 'read'),
  })
  return { tool, exec, stored }
}

const chart = { type: 'bar', labels: ['a', 'b'], series: [{ name: 'hits', values: [1, 2.5] }] }

describe('SendPreview tool', () => {
  it('previews a stored attachment and keeps title and caption', async () => {
    const { tool, exec } = await setup()
    const out = JSON.parse(await tool.execute({ attachmentId: ID, title: ' Shot ', caption: 'after fix' }, exec))
    // Content-addressed: an already stored image keeps its id, nothing is re-stored.
    expect(out).toEqual({ kind: 'image', attachmentId: ID, mediaType: 'image/png', title: 'Shot', caption: 'after fix' })
    expect(tool.name).toBe(SEND_PREVIEW_TOOL)
  })

  it('previews a granted image file by storing its bytes', async () => {
    const { tool, exec, stored } = await setup()
    const out = JSON.parse(await tool.execute({ path: 'shot.png' }, exec))
    expect(out).toMatchObject({ kind: 'image', attachmentId: STORED })
    expect(stored).toEqual([PNG])
  })

  it('rejects a non-image file, a path outside the grants, and a missing attachment', async () => {
    const { tool, exec } = await setup()
    await expect(tool.execute({ path: 'notes.txt' }, exec)).rejects.toThrow(/not a supported image/)
    await expect(tool.execute({ path: '/etc/hosts' }, exec)).rejects.toThrow()
    await expect(tool.execute({ attachmentId: 'f'.repeat(64) }, exec)).rejects.toThrow(/not stored/)
  })

  it('previews a chart, echoing the validated spec', async () => {
    const { tool, exec } = await setup()
    const out = JSON.parse(await tool.execute({ chart, title: 'Hits' }, exec))
    expect(out).toEqual({ kind: 'chart', chart, title: 'Hits' })
  })

  it('needs exactly one of image source or chart', async () => {
    const { tool, exec } = await setup()
    await expect(tool.execute({}, exec)).rejects.toThrow(/exactly one/)
    await expect(tool.execute({ chart, path: 'shot.png' }, exec)).rejects.toThrow(/exactly one/)
    await expect(tool.execute({ chart, attachmentId: ID }, exec)).rejects.toThrow(/exactly one/)
  })

  it.each([
    ['unknown type', { ...chart, type: 'pie' }, /type/],
    ['no labels', { ...chart, labels: [] }, /labels/],
    ['too many points', { ...chart, labels: Array.from({ length: 501 }, String), series: [{ name: 's', values: Array.from({ length: 501 }, () => 1) }] }, /501|500/],
    ['no series', { ...chart, series: [] }, /series/],
    ['too many series', { ...chart, series: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, values: [1, 2] })) }, /series/],
    ['length mismatch', { ...chart, series: [{ name: 's', values: [1] }] }, /values/],
    ['non-finite value', { ...chart, series: [{ name: 's', values: [1, null] }] }, /finite/],
    ['unnamed series', { ...chart, series: [{ name: '', values: [1, 2] }] }, /name/],
    ['an oversize label', { ...chart, labels: ['a', 'x'.repeat(201)] }, /200/],
    ['an oversize series name', { ...chart, series: [{ name: 'x'.repeat(201), values: [1, 2] }] }, /200/],
  ])('rejects a chart with %s', async (_label, bad, message) => {
    const { tool, exec } = await setup()
    await expect(tool.execute({ chart: bad }, exec)).rejects.toThrow(message)
  })

  it('requires a workspace-scoped execution for an image', async () => {
    const { tool } = await setup()
    await expect(tool.execute({ attachmentId: ID }, { root: '/tmp' })).rejects.toThrow(/workspace/)
  })
})
