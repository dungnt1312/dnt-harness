import { useEffect, useRef, useState } from 'react'
import { searchProjectFiles, type ProjectSearchResult } from '../../lib/api.ts'

export const SEARCH_DEBOUNCE_MS = 200
const SEARCH_LIMIT = 50

interface SearchState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly result: ProjectSearchResult | null
  readonly error: string | null
}

const PENDING: SearchState = { status: 'loading', result: null, error: null }

/** Debounced file-name search for one project. A blank (trimmed) query never reaches the API; only the latest request's response is kept. */
export function useFileSearch(workspaceId: string, projectId: string) {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState>(PENDING)
  const generation = useRef(0)

  // Another project: drop the query so results never open files of the wrong one.
  useEffect(() => { setQuery('') }, [workspaceId, projectId])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setState(PENDING)
      return
    }
    setState((current) => ({ ...current, status: 'loading', error: null }))
    const timer = setTimeout(() => {
      const request = ++generation.current
      searchProjectFiles(workspaceId, projectId, trimmed, SEARCH_LIMIT).then(
        (result) => { if (generation.current === request) setState({ status: 'ready', result, error: null }) },
        (cause: unknown) => { if (generation.current === request) setState({ status: 'error', result: null, error: String(cause) }) },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      generation.current++ // a response still in flight belongs to a query that is gone
    }
  }, [query, workspaceId, projectId])

  return { query, setQuery, searching: query.trim() !== '', ...state }
}
