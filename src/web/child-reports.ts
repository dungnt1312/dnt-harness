/**
 * Pure delegation-report formatting: the joined text a root's turn continues
 * with when its delegated children settle. Shared by the server (which
 * produces the message) and the web projection (which must recognize it,
 * including in older logs that predate the `origin: 'continuation'` stamp).
 *
 * Kept free of kernel/executor imports so the web bundle pulls in nothing
 * beyond these types.
 */

/** A settled (or partially settled) child, in the shape `formatChildReports` needs. */
export interface ChildReportHandle {
  readonly childSessionId: string
  readonly status: string
  readonly definitionName: string
  readonly result?: { readonly report: string; readonly filesTouched: readonly string[] }
  readonly partial?: { readonly report: string; readonly filesTouched: readonly string[] }
  readonly error?: string
}

/**
 * First line of the joined-reports message. Older logs predate the
 * `origin: 'continuation'` stamp, so the web projection also recognizes this
 * exact header to keep those reports out of the user column.
 */
export const CHILD_REPORTS_HEADER = 'Delegated agents you left running have finished. Their reports follow; use them to complete the task.'

/**
 * The message a root's turn continues with when delegated children finished
 * after the model stopped calling tools: one section per child, reports first.
 * Nothing in it is an instruction — it is data the model asked for.
 */
export function formatChildReports(handles: readonly ChildReportHandle[]): string {
  const sections = handles.map((child) => {
    const head = `### ${child.definitionName} (${child.childSessionId}) — ${child.status}`
    if (child.result !== undefined) {
      const files = child.result.filesTouched.length > 0 ? `\nFiles touched: ${child.result.filesTouched.join(', ')}` : ''
      return `${head}\n${child.result.report}${files}`
    }
    const lines = [head, child.error ?? 'no result']
    if (child.partial !== undefined) {
      if (child.partial.report !== '') lines.push(`Last thing it said before stopping: ${child.partial.report}`)
      if (child.partial.filesTouched.length > 0) lines.push(`Files touched before stopping: ${child.partial.filesTouched.join(', ')} (unverified — check them before relying on them)`)
    }
    return lines.join('\n')
  })
  return [CHILD_REPORTS_HEADER, ...sections].join('\n\n')
}
