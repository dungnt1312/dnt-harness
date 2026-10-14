import { useMemo, useState } from 'react'
import { Markdown } from '../../Markdown.tsx'
import { csvDelimiterOf, csvRows, type PreviewKind } from '../../lib/preview.ts'
import { TruncationNotice } from './TruncationNotice.tsx'

/**
 * Above this many rendered rows the CSV table is cut: rendering a whole large
 * sheet costs more than reading the first chunk is worth.
 */
const CSV_ROW_LIMIT = 200

/** The rendered side of the viewer's Code | Split | Preview toggle: Markdown document, sandboxed HTML, or a delimited table. */
export function FilePreview({ kind, path, content, truncated }: {
  readonly kind: PreviewKind
  readonly path: string
  readonly content: string
  /** The read was cut at 1 MB; preview covers only what was read. */
  readonly truncated: boolean
}) {
  if (kind === 'markdown') {
    return (
      <div className="min-h-0 flex-1 overflow-auto" role="region" aria-label={`Preview of ${path}`}>
        {truncated ? <TruncationNotice /> : null}
        <div className="mx-auto max-w-3xl px-6 py-4">
          <Markdown content={content} />
        </div>
      </div>
    )
  }
  if (kind === 'html') {
    return (
      <iframe
        title={`Preview of ${path}`}
        srcDoc={content}
        sandbox=""
        className="min-h-0 flex-1 border-0 bg-white"
      />
    )
  }
  return <CsvTable path={path} content={content} truncated={truncated} />
}

/** A delimited table cut after `CSV_ROW_LIMIT` rows, with a notice when cut. */
function CsvTable({ path, content, truncated }: {
  readonly path: string
  readonly content: string
  readonly truncated: boolean
}) {
  const delimiter = csvDelimiterOf(path)
  const rows = useMemo(() => csvRows(content, delimiter), [content, delimiter])
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? rows : rows.slice(0, CSV_ROW_LIMIT)
  const hidden = rows.length - visible.length
  return (
    <div className="min-h-0 flex-1 overflow-auto" role="region" aria-label={`Preview of ${path}`}>
      {truncated ? <TruncationNotice /> : null}
      <table className="border-collapse text-[12.5px]">
        <tbody>
          {visible.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === 0 ? 'bg-muted font-medium' : 'odd:bg-surface'}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} title={cell} className="max-w-64 truncate border border-line px-2 py-1 align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <p className="m-0 border-t border-line bg-warn-soft px-3 py-1.5 text-xs text-warn">
          {`Showing the first ${visible.length} of ${rows.length} rows.`}
          {!truncated ? <button type="button" className="ml-2 cursor-pointer underline" onClick={() => setShowAll(true)}>Show all rows</button> : null}
        </p>
      ) : null}
    </div>
  )
}
