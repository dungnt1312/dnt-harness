/**
 * Client-side preview kinds for the workbench file viewer: documents the
 * browser renders itself from already-read text. Media (image/audio/video)
 * stays in `mediaKindOf`; code and unknown formats stay in the code view.
 */
export type PreviewKind = 'markdown' | 'html' | 'csv'

const PREVIEW_BY_EXTENSION: Readonly<Record<string, PreviewKind>> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  csv: 'csv',
  tsv: 'csv',
}

/** The preview kind a path qualifies for, or null when only the code view fits. */
export function previewKindOf(path: string): PreviewKind | null {
  return PREVIEW_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? null
}

/** The delimiter a CSV-kind file splits on: tab for `.tsv`, comma otherwise. */
export function csvDelimiterOf(path: string): string {
  return path.toLowerCase().endsWith('.tsv') ? '\t' : ','
}

/**
 * Parse delimited text into rows (RFC 4180): quoted fields may hold the
 * delimiter, escaped quotes and newlines. The final line counts even without
 * a trailing newline; empty trailing lines are dropped.
 */
export function csvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"' && field === '') {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (char === '\r' && text[index + 1] === '\n') index += 1
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}
