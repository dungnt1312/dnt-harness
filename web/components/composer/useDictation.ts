import { useCallback, useEffect, useRef, useState } from 'react'
import { getSpeechToTextSettings, transcribeSpeech } from '../../lib/api.ts'

export type DictationState = 'idle' | 'recording' | 'transcribing'

/**
 * Whether dictation is configured, shared by every composer instance: one
 * fetch for the page, revalidated on each mount. Unconfigured = no mic button.
 */
let configuredCache: boolean | null = null
const configuredWaiters: ((value: boolean) => void)[] = []

function configured(): Promise<boolean> {
  if (configuredCache !== null) return Promise.resolve(configuredCache)
  return new Promise((resolve) => {
    configuredWaiters.push((value) => resolve(value))
    if (configuredWaiters.length > 1) return
    void getSpeechToTextSettings()
      .then((settings) => { configuredCache = settings.provider !== null && settings.model !== null })
      .catch(() => { configuredCache = false })
      .finally(() => { const value = configuredCache === true; const waiters = [...configuredWaiters]; configuredWaiters.length = 0; for (const waiter of waiters) waiter(value) })
  })
}

/**
 * Push-to-talk dictation for the composer: MediaRecorder captures the mic,
 * stop sends the blob to `/api/speech-to-text/transcribe`, and the finished
 * text is handed to the caller to insert at the caret. One recording at a time;
 * a failure leaves the draft untouched and reports the reason. The mic only
 * appears once Settings has a speech-to-text provider and model.
 */
export function useDictation(onText: (text: string) => void, onError: (message: string) => void): {
  readonly state: DictationState
  /** False when the browser cannot record or Settings has no STT pair. */
  readonly supported: boolean
  readonly toggle: () => void
} {
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const [state, setState] = useState<DictationState>('idle')
  const [configuredState, setConfiguredState] = useState(configuredCache)
  const browserSupported = typeof MediaRecorder !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined
  const supported = browserSupported && configuredState === true
  const onTextRef = useRef(onText)
  const onErrorRef = useRef(onError)
  useEffect(() => { onTextRef.current = onText; onErrorRef.current = onError }, [onText, onError])

  useEffect(() => {
    let current = true
    void configured().then((value) => { if (current) setConfiguredState(value) })
    return () => { current = false }
  }, [])


  // The stream outlives the recorder; one track set for the whole hook's life.
  useEffect(() => () => { recorder.current?.stream.getTracks().forEach((track) => track.stop()) }, [])

  const fail = useCallback((message: string): void => {
    recorder.current?.stream.getTracks().forEach((track) => track.stop())
    recorder.current = null
    setState('idle')
    onErrorRef.current(message)
  }, [])

  const start = useCallback(async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunks.current = []
      mr.ondataavailable = (event) => { if (event.data.size > 0) chunks.current.push(event.data) }
      mr.onstop = () => {
        const blob = new Blob(chunks.current, { type: mr.mimeType !== '' ? mr.mimeType : 'audio/webm' })
        recorder.current = null
        if (blob.size === 0) { setState('idle'); return }
        setState('transcribing')
        void transcribeSpeech(blob, navigator.language.slice(0, 2))
          .then((text) => { setState('idle'); if (text.trim() !== '') onTextRef.current(text) })
          .catch((cause: unknown) => fail(`Dictation failed: ${cause instanceof Error ? cause.message : String(cause)}`))
      }
      recorder.current = mr
      mr.start()
      setState('recording')
    } catch (cause) {
      onErrorRef.current(`Microphone unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }, [fail])

  const toggle = useCallback((): void => {
    const mr = recorder.current
    if (mr === null) { void start(); return }
    if (mr.state === 'recording') mr.stop()
  }, [start])

  return { state, supported, toggle }
}
