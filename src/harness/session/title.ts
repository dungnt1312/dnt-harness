import type { SessionEvent } from './events.ts'

/** Longest derived title before ellipsis truncation. */
export const TITLE_MAX_LENGTH = 48

/**
 * Derive a short conversation title from the first non-empty user message.
 *
 * A title is *derived*, not authored: the first `user/message` in the log is
 * the durable fact. Every projection — the live listing, the boot-time summary
 * rebuild, and the rename reset — computes the same string from that fact, so a
 * restart can never lose a title it never stored.
 *
 * @returns the collapsed, truncated title, or null when the log holds no user
 *   message yet (a brand-new conversation).
 */
export function deriveTitle(events: readonly SessionEvent[]): string | null {
  for (const event of events) {
    // Host-injected context and joined reports are not what the user typed.
    if (event.type !== 'user/message' || event.origin !== undefined) continue
    const content = event.content.trim().replace(/\s+/g, ' ')
    if (content === '') continue
    return content.length > TITLE_MAX_LENGTH ? `${content.slice(0, TITLE_MAX_LENGTH)}…` : content
  }
  return null
}
