import { useEffect } from 'react'

export function DocumentTitle({ name }: { readonly name: string | undefined }) {
  useEffect(() => {
    document.title = name ?? 'mini-dsh'
  }, [name])
  return null
}
