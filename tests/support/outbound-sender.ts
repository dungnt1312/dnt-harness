/**
 * Tests inject a low-level sender UNDER the outbound policy envelope: URL
 * validation, redirect: 'manual', the combined signal and the policy
 * dispatcher all still run; only the final send is replaced.
 */
import { loadRealUndici, OutboundHttp, type OutboundHttpOptions, type OutboundResponse, type OutboundSendInit } from '../../src/harness/mcp/outbound-http.ts'

/** The init a fetch-like test handler sees: what the envelope built. */
export type SentInit = OutboundSendInit & RequestInit

export type FetchLikeHandler = (url: string, init: SentInit) => Promise<Response | OutboundResponse>

/** Send through real Undici with the envelope's dispatcher (for handlers that fall through to a fixture). */
export async function realSend(url: string, init: SentInit): Promise<OutboundResponse> {
  const undici = await loadRealUndici()
  return undici.fetch(url, init as never) as unknown as OutboundResponse
}

/** An {@link OutboundHttp} whose final send is `handler(url.href, init)`. */
export function senderHttp(handler: FetchLikeHandler, options: Omit<OutboundHttpOptions, 'sender'> = {}): OutboundHttp {
  return new OutboundHttp({ ...options, sender: async (url, init) => handler(url.href, init as SentInit) })
}
