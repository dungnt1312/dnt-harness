import { getPushKey, registerPushDevice } from '../lib/api.ts'

/**
 * Browser side of Web Push: whether this device can subscribe, and the
 * subscribe flow (permission → PushManager → host registration). iOS only
 * exposes PushManager to a Home Screen web app (16.4+).
 */

export type PushSupport = 'supported' | 'needs-install' | 'insecure' | 'unsupported'

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  if (!window.isSecureContext) return 'insecure'
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return ios && !standalone ? 'needs-install' : 'unsupported'
  }
  return 'supported'
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index)
  return out
}

/** The current subscription's endpoint, if this browser already subscribed. */
export async function currentEndpoint(): Promise<string | null> {
  if (pushSupport() !== 'supported') return null
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  return subscription?.endpoint ?? null
}

function deviceLabel(): string {
  const ua = navigator.userAgent
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${os} · ${browser}`
}

/** Ask permission, subscribe and register with the host. Throws with a user-facing reason. */
export async function enablePush(): Promise<void> {
  const support = pushSupport()
  if (support === 'needs-install') throw new Error('Add this app to your Home Screen first, then enable notifications from there.')
  if (support === 'insecure') throw new Error('Notifications need HTTPS (for example `tailscale serve`) or localhost.')
  if (support === 'unsupported') throw new Error('This browser does not support web push notifications.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted.')
  const registration = await navigator.serviceWorker.getRegistration() ?? await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const key = urlBase64ToUint8Array(await getPushKey())
  let subscription = await registration.pushManager.getSubscription()
  if (subscription !== null) {
    // A subscription made with another host key cannot receive this host's pushes.
    const existing = subscription.options.applicationServerKey
    const same = existing !== null && existing.byteLength === key.byteLength && new Uint8Array(existing).every((byte, index) => byte === key[index])
    if (!same) {
      await subscription.unsubscribe()
      subscription = null
    }
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await registerPushDevice(subscription.toJSON(), deviceLabel())
}
