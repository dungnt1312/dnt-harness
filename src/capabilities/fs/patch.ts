// Structured patch grammar shared by execution, path authorization and previews.
export interface PatchHunk {
  readonly context?: string
  readonly lines: readonly string[]
  readonly eof: boolean
}
export interface PatchSection {
  readonly type: 'add' | 'update' | 'delete'
  readonly path: string
  readonly movePath?: string
  readonly content?: string
  readonly hunks: readonly PatchHunk[]
}
export interface PatchEdit {
  readonly old: string
  readonly new: string
  readonly oldLine: number
  readonly newLine: number
}
export interface PatchFileReceipt {
  readonly path: string
  readonly type: 'add' | 'update' | 'delete' | 'move'
  readonly movePath?: string
  readonly edits: readonly PatchEdit[]
}
export interface PatchReceipt {
  readonly tool: 'ApplyPatch'
  readonly files: readonly PatchFileReceipt[]
  readonly error?: string
}

export function parsePatch(input: string): PatchSection[] {
  const lines = input.replace(/\r\n/g, '\n').trim().split('\n')
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new Error('invalid patch: expected Begin/End Patch markers')
  const sections: PatchSection[] = []
  let i = 0
  while (i < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]!)
    if (!header) throw new Error('invalid patch: expected file section header')
    const file = header[2]!.trim()
    if (!file || file.includes('\0')) throw new Error('invalid patch path')
    const type = header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'update'
    let movePath: string | undefined
    if (type === 'update' && lines[i]?.startsWith('*** Move to: ')) {
      movePath = lines[i++]!.slice('*** Move to: '.length).trim()
      if (!movePath || movePath.includes('\0')) throw new Error('invalid move path')
    }
    const content: string[] = []
    const hunks: PatchHunk[] = []
    while (i < lines.length && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[i]!)) {
      if (type === 'add') {
        const line = lines[i++]!
        if (!line.startsWith('+')) throw new Error('invalid add file line: expected +')
        content.push(line.slice(1))
        continue
      }
      if (type === 'delete') throw new Error('invalid delete section: unexpected content')
      const marker = lines[i++]!
      if (marker !== '@@' && !marker.startsWith('@@ ')) throw new Error('invalid update: expected @@ hunk')
      const body: string[] = []
      let eof = false
      while (i < lines.length && !lines[i]!.startsWith('@@') && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[i]!)) {
        const line = lines[i++]!
        if (line === '*** End of File') { eof = true; break }
        if (!/^[ +\-]/.test(line)) throw new Error('invalid hunk line: expected space, + or -')
        body.push(line)
      }
      if (body.length === 0 || !body.some((line) => /^[+\-]/.test(line))) throw new Error('empty or unchanged hunk')
      hunks.push({ ...(marker.length > 3 ? { context: marker.slice(3) } : {}), lines: body, eof })
    }
    if (type === 'update' && hunks.length === 0) throw new Error('update requires hunks')
    sections.push({ type, path: file, ...(movePath !== undefined ? { movePath } : {}), ...(type === 'add' ? { content: content.length ? `${content.join('\n')}\n` : '' } : {}), hunks })
  }
  if (sections.length === 0) throw new Error('empty patch')
  return sections
}

/** Parse only our own complete receipt; truncated results cannot invent changes. */
export function patchReceipt(output: string | undefined): PatchReceipt | undefined {
  if (output === undefined) return undefined
  const json = output.slice(output.indexOf('{'))
  try {
    const data = JSON.parse(json) as PatchReceipt
    if (data.tool !== 'ApplyPatch' || !Array.isArray(data.files)) return undefined
    if (!data.files.every((file) => typeof file.path === 'string' && ['add', 'update', 'delete', 'move'].includes(file.type)
      && (file.movePath === undefined || typeof file.movePath === 'string') && Array.isArray(file.edits)
      && file.edits.every((edit: PatchEdit) => typeof edit.old === 'string' && typeof edit.new === 'string'
        && Number.isInteger(edit.oldLine) && edit.oldLine >= 1 && Number.isInteger(edit.newLine) && edit.newLine >= 1))) return undefined
    return data
  } catch { return undefined }
}
