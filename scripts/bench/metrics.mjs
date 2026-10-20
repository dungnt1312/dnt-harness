/**
 * Pure benchmark metric helpers shared by run-bench.mjs and its tests.
 *
 * Rules (spec QH-2 §11.2):
 * - Normalize each record ONCE (`cachedTokens ?? cachedInputTokens`) before any
 *   aggregation; only finite, nonnegative numbers count. Missing stays
 *   `undefined` ("unknown"), never 0.
 * - Input token semantics differ between harnesses: dnt reports the provider's
 *   `prompt_tokens`, which INCLUDES cached tokens; opencode reports input with
 *   cache reads subtracted (non-cached). Totals never add cache twice.
 * - Failed/timed-out runs stay in the success denominator; they are only
 *   excluded from the loop/latency medians, with an explicit reason.
 */

/** @param {unknown} value */
export function measured(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export const INPUT_SEMANTICS = /** @type {const} */ (['inclusive', 'non-cached'])

/** Default semantics per harness when a metrics file predates the label. */
const DEFAULT_SEMANTICS = { 'dnt-harness': 'inclusive', opencode: 'non-cached' }

/**
 * Normalize one raw metrics object (as written by harness-agent.mts or
 * opencode-run.mjs). Returns only measured fields; unknown stays undefined.
 * @param {Record<string, unknown> | null | undefined} raw
 * @param {string} [harness]
 */
export function normalizeMetrics(raw, harness) {
  const m = raw ?? {}
  const label = typeof m.inputSemantics === 'string' && INPUT_SEMANTICS.includes(/** @type {any} */ (m.inputSemantics))
    ? /** @type {'inclusive' | 'non-cached'} */ (m.inputSemantics)
    : /** @type {'inclusive' | 'non-cached' | undefined} */ (DEFAULT_SEMANTICS[/** @type {keyof typeof DEFAULT_SEMANTICS} */ (harness ?? String(m.harness ?? ''))])
  const inputTokens = measured(m.inputTokens)
  const outputTokens = measured(m.outputTokens)
  const rawCached = measured(m.cachedTokens) ?? measured(m.cachedInputTokens)
  // Under inclusive semantics cache is a subset of input; cached > input means
  // the report is inconsistent. Flag it and do not use the cache figure.
  const cacheAnomaly = label === 'inclusive' && inputTokens !== undefined && rawCached !== undefined && rawCached > inputTokens
  const cachedTokens = cacheAnomaly ? undefined : rawCached
  // Provider-inclusive input: what the model actually read, cache included.
  let inputInclusiveTokens
  if (label === 'inclusive') inputInclusiveTokens = inputTokens
  else if (label === 'non-cached' && inputTokens !== undefined && cachedTokens !== undefined) inputInclusiveTokens = inputTokens + cachedTokens
  const totalTokens = inputInclusiveTokens !== undefined && outputTokens !== undefined ? inputInclusiveTokens + outputTokens : undefined
  return {
    inputSemantics: label,
    steps: measured(m.steps),
    toolCalls: measured(m.toolCalls),
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheAnomaly,
    inputInclusiveTokens,
    totalTokens,
    firstRequestInputTokens: measured(m.firstRequestInputTokens),
  }
}

/**
 * Why a run is excluded from the medians, or undefined when it is valid.
 * @param {{ metrics?: Record<string, any> | null }} record
 */
export function exclusionReason(record) {
  const m = record.metrics
  if (m === null || m === undefined) return 'no metrics (runner crashed or wrote nothing)'
  if (m.timedOut === true) return 'timed out'
  if (Array.isArray(m.errors) && m.errors.length > 0) return 'run error (unclassified)'
  if (!((measured(m.steps) ?? 0) > 0)) return 'no model call'
  return undefined
}

/** Median of the measured values; undefined when none are known. @param {Array<number | undefined>} xs */
export function median(xs) {
  const s = xs.filter((x) => x !== undefined).sort((a, b) => a - b)
  if (s.length === 0) return undefined
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Aggregate one task × harness cell.
 * @param {Array<{ rep: number, wallMs: number, verdict: { success: boolean }, metrics?: Record<string, any> | null, stderrTail?: string }>} records
 * @param {string} harness
 */
export function summarizeCell(records, harness) {
  const rows = records.map((r) => ({ r, n: normalizeMetrics(r.metrics, harness), reason: exclusionReason(r) }))
  const valid = rows.filter((row) => row.reason === undefined)
  /** @param {keyof ReturnType<typeof normalizeMetrics>} key */
  const med = (key) => median(valid.map((row) => /** @type {number | undefined} */ (row.n[key])))
  /** @param {keyof ReturnType<typeof normalizeMetrics>} key */
  const known = (key) => valid.filter((row) => row.n[key] !== undefined).length
  const semantics = [...new Set(rows.map((row) => row.n.inputSemantics).filter((s) => s !== undefined))]
  return {
    harness,
    runs: records.length,
    validRuns: valid.length,
    excluded: rows.filter((row) => row.reason !== undefined).map((row) => ({ rep: row.r.rep, reason: row.reason })),
    // Denominator is every run, failed and timed-out included.
    successRate: records.length === 0 ? undefined : records.filter((r) => r.verdict?.success === true).length / records.length,
    inputSemantics: semantics.length === 1 ? semantics[0] : semantics.length === 0 ? undefined : 'mixed',
    stepsMedian: med('steps'),
    toolCallsMedian: med('toolCalls'),
    wallSecondsMedian: median(valid.map((row) => measured(row.r.wallMs / 1000))),
    inputTokensMedian: med('inputTokens'),
    inputInclusiveTokensMedian: med('inputInclusiveTokens'),
    outputTokensMedian: med('outputTokens'),
    cachedTokensMedian: med('cachedTokens'),
    cachedTokensKnownRuns: known('cachedTokens'),
    // Runs whose cache report exceeded inclusive input (cache figure dropped).
    cacheAnomalyRuns: rows.filter((row) => row.n.cacheAnomaly).length,
    totalTokensMedian: med('totalTokens'),
    firstRequestInputMedian: med('firstRequestInputTokens'),
  }
}

/** Render a possibly-unknown metric for reports. @param {number | undefined} v @param {number} [digits] */
export function show(v, digits) {
  if (v === undefined) return 'unknown'
  return digits === undefined ? String(v) : v.toFixed(digits)
}

// ── verifiers ───────────────────────────────────────────────────────────────

const NEGATION = String.raw`(?:no|not|never|none|nothing|doesn't|does not|doesn’t|isn't|is not|isn’t|cannot|can't|there is no|there are no)`

/**
 * An affirmative locating phrase: "defined in", "located in", "see …", or a
 * "found" that is not negated ("not found", "found no", "nothing found").
 * @param {string} answer
 */
function affirmsLocation(answer) {
  if (/\b(?:defined\s+in|located\s+in|lives\s+in|see)\b/i.test(answer)) return true
  const negatedBefore = new RegExp(String.raw`\b${NEGATION}\b[^.\n]{0,40}$`, 'i')
  for (const match of answer.matchAll(/\bfound\b/gi)) {
    const before = answer.slice(0, match.index)
    const after = answer.slice(match.index + match[0].length)
    if (negatedBefore.test(before)) continue
    if (/^\s+(?:no|nothing|zero|none)\b/i.test(after)) continue
    return true
  }
  return false
}

/**
 * Check the final answer of a read-only task against the expected answer for
 * the `discount-bug` fixture.
 * @param {string} taskId
 * @param {string} text
 */
export function verifyReadAnswer(taskId, text) {
  const answer = String(text ?? '')
  if (taskId === 'explain-rounding') {
    // Rule lives in src/discounts.js; the suite expects nearest-cent, half-up rounding.
    const file = /\bdiscounts\.js\b/i.test(answer)
    const rounding = /\bnearest\s+cent\b|\bhalf[\s-]*up\b|\bMath\.round\b|\bround(?:s|ed|ing)?\s+(?:to\s+the\s+)?nearest\b/i.test(answer)
    // "not rounding to the nearest cent", "no rounding", "instead of rounding".
    const negatedRounding = /\b(?:not|no|never|without|instead\s+of|rather\s+than)\s+(?:any\s+|by\s+)?(?:rounding|round(?:s|ed)?|Math\.round|nearest[\s-]+cent|half[\s-]*up)\b/i.test(answer)
    // "the tests expect truncation (floor)". A negated floor ("Math.round, not
    // Math.floor") is dropped first so it does not count as the expectation.
    const withoutNegatedFloor = answer.replace(/\b(?:not|no|never|instead\s+of|rather\s+than)\s+(?:a\s+|the\s+)?(?:Math\.floor|floor\w*|truncat\w*)/gi, '')
    const floorExpected = /\b(?:expect\w*|want\w*|require\w*|should|assert\w*)\b[^.\n]{0,60}?\b(?:truncat\w*|floor\w*|Math\.floor|round(?:s|ed|ing)?\s+down)\b/i.test(withoutNegatedFloor)
    return { ok: file && rounding && !negatedRounding && !floorExpected, checks: { file, rounding, negatedRounding, floorExpected } }
  }
  if (taskId === 'nonexistent-api') {
    // Must state absence of fraudScore validation, and must not point at a location.
    const negation = new RegExp(String.raw`\b${NEGATION}\b[^.\n]{0,120}\b(?:exist|exists|found|such|match|matches|function|validat\w*|fraudScore|reference|references|occurrence|occurrences|result|results)\b`, 'i')
    const absenceFirst = new RegExp(String.raw`\bfraudScore\b[^.\n]{0,80}\b${NEGATION}\b`, 'i')
    const absent = negation.test(answer) || absenceFirst.test(answer)
    // Naming any source file is pointing at a location, line number or not.
    const namesPath = /\b[\w./-]+\.(?:js|mjs|cjs|ts|json)\b/i.test(answer)
    const claimsLocation = namesPath || affirmsLocation(answer)
    return { ok: absent && !claimsLocation, checks: { absent, namesPath, claimsLocation } }
  }
  return { ok: false, checks: {} }
}
