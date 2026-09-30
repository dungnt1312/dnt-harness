/// <reference lib="dom" />
// The init script runs in the browser, where the DOM lib applies.
import { expect, test, type Page, type Route } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const shots = fileURLToPath(new URL('../../artifacts/product-ui/attachments', import.meta.url))

/** A real PNG, so the thumbnail and lightbox have actual pixels to lay out. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 2 // 8-bit RGB
  const rows: Buffer[] = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x += 1) { row[1 + x * 3] = (x * 4) & 255; row[2 + x * 3] = (y * 6) & 255; row[3 + x * 3] = 180 }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const IMAGE = { id: 'img-1', name: 'screenshot.png', mediaType: 'image/png', bytes: 2048 }
const IMAGE_2 = { id: 'img-2', name: 'second.png', mediaType: 'image/png', bytes: 2048 }
const FILE = { id: 'doc-1', name: 'notes.txt', mediaType: 'text/plain', bytes: 512 }

const EVENTS = [
  { type: 'turn/start', seq: 1, timestamp: 1_000, turnId: 't1' },
  { type: 'user/message', seq: 2, timestamp: 1_000, turnId: 't1', content: 'What is wrong in this screenshot?', attachments: [IMAGE, FILE] },
  { type: 'assistant/message', seq: 3, timestamp: 2_000, content: 'The layout overflows.' },
  { type: 'turn/end', seq: 4, timestamp: 2_000, turnId: 't1', reason: 'completed' },
  { type: 'turn/start', seq: 5, timestamp: 3_000, turnId: 't2' },
  { type: 'user/message', seq: 6, timestamp: 3_000, turnId: 't2', content: '', attachments: [IMAGE, IMAGE_2] },
  { type: 'assistant/message', seq: 7, timestamp: 4_000, content: 'Both look fine.' },
  { type: 'turn/end', seq: 8, timestamp: 4_000, turnId: 't2', reason: 'completed' },
]

function json(route: Route, value: unknown): Promise<void> {
  return route.fulfill({ status: 200, json: value })
}

async function serve(page: Page): Promise<void> {
  const image = png(1600, 1000)
  await page.addInitScript((snapshot) => {
    class FixtureEventSource {
      readyState = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      constructor(readonly url: string) {
        window.setTimeout(() => {
          this.readyState = 1
          this.onopen?.(new Event('open'))
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ kind: 'snapshot', events: snapshot }) }))
        }, 0)
      }
      close(): void { this.readyState = 2 }
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean { return true }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: FixtureEventSource })
    window.localStorage.clear()
  }, EVENTS)

  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/auth/state') return json(route, { required: false, paired: true })
    if (path === '/api/workspaces') return json(route, [{ id: 'w', name: 'Fixture workspace', default: true, archived: false, createdAt: 0 }])
    if (path === '/api/workspaces/w/projects') return json(route, [{ id: 'p', name: 'Fixture project', workspaceId: 'w', path: 'C:/fixture/project', createdAt: 0 }])
    if (path === '/api/workspaces/w/projects/p/files') return json(route, { path: '', entries: [] })
    if (path === '/api/workspaces/w/sessions') return json(route, [{ id: 's', workspaceId: 'w', title: 'Fixture conversation', projectId: 'p', folder: null, eventCount: EVENTS.length, createdAt: 0, updatedAt: 0, status: 'idle' }])
    if (path === '/api/workspaces/w/meta') return json(route, { workspace: { id: 'w', name: 'Fixture workspace', archived: false }, provider: 'fixture-provider', model: 'fixture-model', providers: [], models: ['fixture-model'], projects: [{ id: 'p', name: 'Fixture project', path: 'C:/fixture/project' }], permissionDefaults: {}, thinkingLevel: null })
    if (path === '/api/workspaces/w/mode') return json(route, { modes: [{ id: 'chat', name: 'Chat', source: 'bundled' }], selected: 'chat', revision: 1 })
    if (path === '/api/model-defaults') return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null })
    if (path === '/api/workspaces/w/agents/children') return json(route, [])
    if (/^\/api\/workspaces\/w\/sessions\/[^/]+\/model$/.test(path)) return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null, source: 'global' })
    if (/^\/api\/workspaces\/w\/sessions\/[^/]+\/grants$/.test(path)) return json(route, { revision: 0, roots: [], effective: [] })
    if (/^\/api\/workspaces\/w\/sessions\/[^/]+\/manifest$/.test(path)) return json(route, { modeId: 'chat', modeRevision: 1, budget: { availableTokens: 32000, usedTokens: 0, estimated: false }, history: { setting: 'all', includedTurns: 0, omittedTurns: 0 }, sources: { skills: [], memory: [], toolNames: [], toolSchemas: 0 }, omissions: [] })
    if (path === '/api/workspaces/w/skills') return json(route, [])
    if (path.startsWith('/api/workspaces/w/attachments/')) return route.fulfill({ status: 200, contentType: 'image/png', body: image })
    throw new Error(`Unexpected fixture API request: ${route.request().method()} ${url.href}`)
  })

  await page.goto('/workspaces/w/sessions/s')
  await expect(page.getByText('The layout overflows.')).toBeVisible()
}

test('image attachments render as bare thumbnails outside the bubble; files stay inside', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await serve(page)

  const thumb = page.getByRole('button', { name: 'Preview screenshot.png' }).first()
  await expect(thumb).toBeVisible()
  const img = thumb.locator('img')
  await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth)).toBe(1600)

  // The thumbnail is not nested inside the grey text bubble.
  const bubble = page.getByText('What is wrong in this screenshot?').locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]')
  await expect(bubble).toBeVisible()
  expect(await bubble.locator('img').count()).toBe(0)
  // …and sits above it.
  const thumbBox = (await thumb.boundingBox())!
  const bubbleBox = (await bubble.boundingBox())!
  expect(thumbBox.y + thumbBox.height).toBeLessThanOrEqual(bubbleBox.y + 1)
  // The thumbnail has no border of its own.
  expect(await img.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe('0px')

  // The non-image file stays in the bubble as a chip.
  await expect(bubble.getByText('notes.txt')).toBeVisible()

  // An image-only message has no empty bubble; two images become square tiles.
  const tiles = page.getByRole('button', { name: /^Preview (screenshot|second)\.png$/ })
  await expect(tiles).toHaveCount(3)
  const second = page.getByRole('button', { name: 'Preview second.png' })
  const tileBox = (await second.boundingBox())!
  expect(Math.round(tileBox.width)).toBe(112)
  expect(Math.round(tileBox.height)).toBe(112)

  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: `${shots}/thumbnails.png` })
})

test('clicking a thumbnail opens a lightbox that closes with Escape, the close button, and the backdrop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await serve(page)
  const thumb = page.getByRole('button', { name: 'Preview screenshot.png' }).first()

  // Open → Escape closes and returns focus to the thumbnail.
  await thumb.click()
  const dialog = page.getByRole('dialog', { name: 'screenshot.png' })
  await expect(dialog).toBeVisible()
  const full = dialog.locator('img')
  await expect(full).toBeVisible()
  const fullBox = (await full.boundingBox())!
  // Larger than the viewport: scaled down to fit, aspect ratio kept.
  expect(fullBox.x).toBeGreaterThanOrEqual(0)
  expect(fullBox.y).toBeGreaterThanOrEqual(0)
  expect(fullBox.x + fullBox.width).toBeLessThanOrEqual(1280)
  expect(fullBox.y + fullBox.height).toBeLessThanOrEqual(800)
  expect(Math.abs(fullBox.width / fullBox.height - 1.6)).toBeLessThan(0.02)
  await expect(dialog.getByRole('link', { name: 'screenshot.png' })).toHaveAttribute('href', '/api/workspaces/w/attachments/img-1')
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: `${shots}/lightbox.png` })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(thumb).toBeFocused()

  // Open → close button.
  await thumb.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close preview' }).click()
  await expect(dialog).toBeHidden()

  // Open → click the backdrop, outside the image.
  await thumb.click()
  await expect(dialog).toBeVisible()
  await page.mouse.click(10, 10)
  await expect(dialog).toBeHidden()

  // Clicking the image itself does not close it.
  await thumb.click()
  await expect(dialog).toBeVisible()
  await full.click()
  await expect(dialog).toBeVisible()
})
