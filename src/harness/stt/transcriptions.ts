/**
 * Speech-to-text over the OpenAI-compatible Transcriptions API: one multipart
 * `POST {baseUrl}/audio/transcriptions`, `{ "text": ... }` back. OpenAI, Groq
 * and Mistral (Voxtral) all speak it, so provider choice is pure configuration.
 */

/** The endpoint a call resolves at execution time (Settings may change between calls). */
export interface TranscriptionConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

export interface TranscribeOptions {
  /** ISO-639-1 hint (`vi`); omitted = provider auto-detects. */
  readonly language?: string | undefined
  /** Biasing text for domain terms, exactly the OpenAI `prompt` field. */
  readonly prompt?: string | undefined
  readonly timeoutMs?: number
  /** Test seam. */
  readonly fetch?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_BYTES = 25 * 1024 * 1024 // OpenAI/Groq request ceiling for one file.

export class TranscriptionError extends Error {}

/** Transcribe audio bytes; the filename is derived from the media type when known. */
export async function transcribe(config: TranscriptionConfig, bytes: Uint8Array, options: TranscribeOptions = {}): Promise<string> {
  if (bytes.byteLength === 0) throw new TranscriptionError('no audio bytes to transcribe')
  if (bytes.byteLength > MAX_BYTES) throw new TranscriptionError(`audio is ${bytes.byteLength} bytes; the transcription API accepts at most ${MAX_BYTES}`)
  const form = new FormData()
  form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/webm' }), 'speech.webm')
  form.append('model', config.model)
  form.append('response_format', 'json')
  if (options.language !== undefined && options.language !== '') form.append('language', options.language)
  if (options.prompt !== undefined && options.prompt !== '') form.append('prompt', options.prompt)
  const doFetch = options.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(`${config.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new TranscriptionError(`transcription request failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!response.ok) throw new TranscriptionError(`transcription failed (${response.status}): ${(await response.text().catch(() => '')).slice(0, 300)}`)
  const body: unknown = await response.json().catch(() => null)
  if (body === null || typeof body !== 'object' || typeof (body as Record<string, unknown>)['text'] !== 'string') {
    throw new TranscriptionError('transcription endpoint answered without a text field')
  }
  return (body as { readonly text: string }).text
}
