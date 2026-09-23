import { useState } from 'react'
import { apiFetch, setCsrfToken } from '../../lib/api.ts'
import { Button } from '../ui/Button.tsx'

/**
 * First-run gate. The pairing code is typed here; it is never placed in the
 * URL, and a rejected code stays on this screen with the server's reason.
 */
export function PairingGate({ onPaired }: { readonly onPaired: () => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const response = await apiFetch('/api/auth/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string }
        setError(body.error ?? `HTTP ${response.status}`)
        return
      }
      const body = await response.json() as { csrf?: string }
      if (typeof body.csrf === 'string') setCsrfToken(body.csrf)
      onPaired()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'pairing failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mx-auto flex w-full max-w-md flex-col gap-3 px-6 py-16">
      <h1 className="text-lg font-medium text-fg">Pair this browser</h1>
      <p className="text-sm text-fg-muted">
        Enter the single-use code printed by the server. It expires in five minutes and is not stored in the page address.
      </p>
      <input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-label="Pairing code"
        className="rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm text-fg"
      />
      {error !== null ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
      <Button type="submit" disabled={pending || code.trim() === ''}>Pair</Button>
    </form>
  )
}
