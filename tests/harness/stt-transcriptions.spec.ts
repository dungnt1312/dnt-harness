/**
 * Speech-to-text adapter over the OpenAI-compatible Transcriptions API
 * (`POST {baseUrl}/audio/transcriptions`, multipart; `{ "text": ... }` back).
 */
import { describe, expect, it } from 'vitest'
import { transcribe, type TranscriptionConfig } from '../../src/harness/stt/transcriptions.ts'

const CONFIG: TranscriptionConfig = { baseUrl: 'http://stt.test/v1', apiKey: 'sk-stt', model: 'whisper-1' }

/** Captures the outgoing request and answers with the scripted response. */
function capture(reply: (request: Request) => Response): { requests: Request[]; fetch: typeof fetch } {
  const requests: Request[] = []
  const stub: typeof fetch = (input, init) => {
    const request = new Request(typeof input === 'string' ? input : input, init)
    requests.push(request)
    return Promise.resolve(reply(request))
  }
  return { requests, fetch: stub }
}

describe('transcribe', () => {
  it('POSTs multipart to {baseUrl}/audio/transcriptions with model, language and prompt, and returns text', async () => {
    const { requests, fetch } = capture(() => Response.json({ text: 'xin chào' }))
    await expect(transcribe(CONFIG, new Uint8Array([1, 2, 3]), { language: 'vi', prompt: 'terms', fetch })).resolves.toBe('xin chào')
    const request = requests[0]
    expect(request).toBeDefined()
    if (request === undefined) return
    expect(request.method).toBe('POST')
    expect(request.url).toBe('http://stt.test/v1/audio/transcriptions')
    expect(request.headers.get('authorization')).toBe('Bearer sk-stt')
    const form = await request.formData()
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('language')).toBe('vi')
    expect(form.get('prompt')).toBe('terms')
    expect(form.get('response_format')).toBe('json')
    const file = form.get('file')
    expect(file).toBeInstanceOf(File)
    expect((file as File).size).toBe(3)
  })

  it('omits language and prompt when absent', async () => {
    const { requests, fetch } = capture(() => Response.json({ text: 'hello' }))
    await expect(transcribe(CONFIG, new Uint8Array([1]), { fetch })).resolves.toBe('hello')
    const form = await requests[0]!.formData()
    expect(form.get('language')).toBeNull()
    expect(form.get('prompt')).toBeNull()
  })

  it('surfaces a provider error with its status', async () => {
    const { fetch } = capture(() => new Response('{"error":{"message":"bad audio"}}', { status: 400 }))
    await expect(transcribe(CONFIG, new Uint8Array([1]), { fetch })).rejects.toThrow('400')
  })

  it('rejects a body that is not a transcription object', async () => {
    const { fetch } = capture(() => Response.json('nope'))
    await expect(transcribe(CONFIG, new Uint8Array([1]), { fetch })).rejects.toThrow()
  })
})
