/**
 * Control-plane auth against the real host, not a fixture: the built client
 * (`web-dist/`, so run `npm run build:web` first) served by `createWebServer`
 * with pairing on. Proves the paired-user path end to end — the gate, a CSRF
 * mutation, a reload that keeps both the session and the CSRF token — and
 * that a revoked session returns the page to the gate instead of stranding
 * it on HTTP errors.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createWebServer, type WebServer } from '../../src/web/server.ts'

let server: WebServer | undefined
let home = ''

test.beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-auth-e2e-'))
  server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), controlPlaneAuth: true })
})

test.afterEach(async () => {
  await server?.close()
  server = undefined
  await fs.rm(home, { recursive: true, force: true })
})

async function pair(page: Page, live: WebServer): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible({ timeout: 20_000 })
  await page.getByLabel('Pairing code').fill(live.auth.issuePairingCode().code)
  await page.getByRole('button', { name: 'Pair' }).click()
  await expect(page.locator('[data-composer-input]')).toBeVisible({ timeout: 20_000 })
}

/** Pick a mode other than the current one; the PUT carries the CSRF token. */
async function switchMode(page: Page): Promise<number> {
  await page.getByRole('button', { name: /Workspace mode/ }).click()
  const response = page.waitForResponse((candidate) => /\/api\/workspaces\/[^/]+\/mode$/.test(new URL(candidate.url()).pathname) && candidate.request().method() === 'PUT')
  await page.locator('[role="menuitemradio"][aria-checked="false"]').first().click()
  return (await response).status()
}

test('a paired browser works across a reload and returns to the gate when its session is revoked', async ({ page }) => {
  const live = server!
  await page.goto(live.url)
  await pair(page, live)
  expect(await switchMode(page)).toBe(200)

  // Settings sections load under the paired session, with no refusal.
  const refusals: string[] = []
  page.on('response', (response) => { if (response.status() === 401 || response.status() === 403) refusals.push(`${response.status()} ${response.url()}`) })
  await page.getByRole('button', { name: 'Open settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const section of ['Providers', 'Hooks', 'Agents', 'MCP', 'Secrets']) {
    await settings.getByRole('tab', { name: new RegExp(section) }).click()
    await expect(settings.getByRole('heading', { name: section, exact: true }).first()).toBeVisible()
  }
  await settings.getByRole('button', { name: 'Close settings' }).click()
  expect(refusals).toEqual([])

  // A reload keeps the session and recovers the CSRF token from the host.
  await page.reload()
  await expect(page.locator('[data-composer-input]')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toHaveCount(0)
  expect(await switchMode(page)).toBe(200)

  // Revocation mid-use: whichever request comes next — background traffic or
  // the user's own action — is refused, and the page returns to the gate.
  live.auth.logoutAll()
  const gate = page.getByRole('heading', { name: 'Pair this browser' })
  const modeButton = page.getByRole('button', { name: /Workspace mode/ })
  if (await modeButton.isVisible()) {
    // A user action that reaches the host: pick another mode.
    await modeButton.click().catch(() => {})
    await page.locator('[role="menuitemradio"][aria-checked="false"]').first().click().catch(() => {})
  }
  await expect(gate).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-composer-input]')).toHaveCount(0)

  // Pairing again mounts a fresh shell that loads with the new session.
  await pair(page, live)
  expect(await switchMode(page)).toBe(200)
})

test('a browser that never paired sees the gate even after another browser paired', async ({ browser, page }) => {
  const live = server!
  await page.goto(live.url)
  await pair(page, live)

  const stranger = await browser.newContext()
  const other = await stranger.newPage()
  await other.goto(live.url)
  await expect(other.getByRole('heading', { name: 'Pair this browser' })).toBeVisible({ timeout: 20_000 })
  await stranger.close()
})
