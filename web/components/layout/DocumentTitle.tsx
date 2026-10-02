import { useEffect } from 'react'

export function DocumentTitle({ name }: { readonly name: string | undefined }) {
  useEffect(() => {
    document.title = name ?? 'dnt-harness'
  }, [name])
  return null
}
