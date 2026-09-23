import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../web')

async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...await files(full))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('web rest seam', () => {
  it('keeps fetch() inside api.ts', async () => {
    const offenders: string[] = []
    const pattern = /\bfetch\s*\(/
    for (const file of await files(ROOT)) {
      const relative = path.relative(ROOT, file).split(path.sep).join('/')
      if (relative === 'lib/api.ts') continue
      const text = await fs.readFile(file, 'utf8')
      if (pattern.test(text)) offenders.push(relative)
    }
    expect(offenders).toEqual([])
  })
})
