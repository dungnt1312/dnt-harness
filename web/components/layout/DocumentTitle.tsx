import { useEffect } from 'react'

/** Loopback is one per machine, so only a real domain needs to tell installs apart. */
function installHost(): string | undefined {
  const { hostname } = window.location
  return hostname === '' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' ? undefined : hostname
}

/** Host first: window lists truncate the tail, and the host is what differs between installs. */
export function documentTitle(name: string | undefined, host: string | undefined): string {
  const base = name ?? 'dnt-harness'
  return host === undefined ? base : `${host} · ${base}`
}

export function DocumentTitle({ name }: { readonly name: string | undefined }) {
  useEffect(() => {
    document.title = documentTitle(name, installHost())
  }, [name])
  return null
}
