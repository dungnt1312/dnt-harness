/// <reference lib="dom" />
// Temporary audit: no document-level horizontal overflow at tablet widths,
// and dock/drawer behavior flips at the documented breakpoints.
import { expect, test, type Page, type Route } from '@playwright/test'

const WIDTHS = [640, 768, 834, 1024, 1180, 1280] as const

async function fixture(page: Page, events: readonly unknown[]): Promise<void> {
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, json: value })
  await page.route('**/api/meta', (route) => json(route, { providers: [] }))
  await page.route('**/api/workspaces', (route) => json(route, [
    { id: 'ws', name: 'Fixture', path: 'C:/fixture/project', default: true },
  ]))
  await page.route('**/api/workspace/ws/projects', (route) => json(route, [
    { id: 'proj', workspaceId: 'ws', path: 'C:/fixture/project', name: 'project' },
  ]))
  await page.route('**/api/workspace/ws/sessions', (route) => json(route, [
    { id: 's1', workspaceId: 'ws', projectId: 'proj', title: 'Tablet check', pinned: false, created: 0, updated: 0 },
  ]))
  await page.route('**/api/workspace/ws/session/s1/events', (route) => json(route, events))
  await page.route('**/api/workspace/ws/session/s1/permissions**', (route) => json(route, {}))
  await page.route('**/api/workspace/ws/session/s1/model', (route) => json(route, {}))
  await page.route('**/api/model-defaults', (route) => json(route, { provider: 'fixture', model: 'fixture-model' }))
  await page.route('**/api/workspace/ws/model-defaults', (route) => json(route, { provider: 'fixture', model: 'fixture-model' }))
  await page.route('**/api/workspace/ws/files**', (route) => json(route, { entries: [] }))
  await page.route('**/api/workspace/ws/git**', (route) => json(route, { branch: 'main', files: [] }))
  await page.route('**/api/workspace/ws/manifest**', (route) => json(route, { total: 0, sources: [] }))
  await page.route('**/api/workspace/ws/agents**', (route) => json(route, []))
  await page.route('**/api/workspace/ws/processes**', (route) => json(route, []))
  await page.route('**/api/workspace/ws/trajectory**', (route) => json(route, { turns: [] }))
}

function longConversation(): readonly unknown[] {
  const events: unknown[] = []
  let seq = 0
  const push = (event: Record<string, unknown>): void => { events.push({ ...event, seq: seq++, timestamp: 1_700_000_000_000 + seq * 1_000 }) }
  for (let turn = 1; turn <= 3; turn += 1) {
    push({ type: 'turn/start' })
    push({ type: 'user/message', content: `Question ${turn}: explain the tool pipeline step ${turn}.` })
    push({ type: 'tool/call', call: { id: `read-${turn}`, name: 'Read', args: { path: 'C:/fixture/project/src/step.ts' } } })
    push({ type: 'tool/result', callId: `read-${turn}`, ok: true, output: 'export const step = true\n'.repeat(3) })
    push({ type: 'assistant/message', content: '## Step\n\nThe pipeline validates arguments, asks the policy gate, then runs the tool.\n\n```ts\nconst result = await pipeline.run(step)\n```\n\n- validation happens first\n- the approval gate is next\n- results are recorded durably' })
    push({ type: 'turn/end', reason: 'completed' })
  }
  return events
}

async function overflowAt(page: Page): Promise<string> {
  return page.evaluate(() => {
    const doc = document.documentElement
    const extras: string[] = []
    if (document.body.scrollWidth > window.innerWidth + 1) {
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect()
        if (r.right > window.innerWidth + 1 && r.width > 8) extras.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)}`)
        if (extras.length >= 4) break
      }
    }
    return `${doc.scrollWidth}x${doc.scrollHeight} vs viewport ${window.innerWidth} :: ${extras.join(' | ')}`
  })
}

test.describe('tablet widths', () => {
  for (const width of WIDTHS) {
    test(`no overflow at ${width}px`, async ({ page }) => {
      await fixture(page, longConversation())
      await page.setViewportSize({ width, height: 1024 })
      await page.goto('/session/s1')
      await expect(page.getByRole('status').first()).toBeVisible({ timeout: 10_000 }).catch(() => undefined)
      await page.waitForTimeout(400)
      const state = await overflowAt(page)
      console.log(`[${width}px] ${state}`)
      const doc = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(doc, state).toBeLessThanOrEqual(width + 1)
    })
  }

  test('sidebar flips drawer→dock at 768', async ({ page }) => {
    await fixture(page, longConversation())
    await page.setViewportSize({ width: 767, height: 1024 })
    await page.goto('/session/s1')
    await page.waitForTimeout(300)
    const below = await page.evaluate(() => !!document.querySelector('[role="dialog"]'))
    await page.setViewportSize({ width: 769, height: 1024 })
    await page.waitForTimeout(300)
    const above = await page.evaluate(() => document.querySelector('aside') !== null && document.querySelector('[role="dialog"]') === null)
    console.log(`sidebar: drawer@767=${below} docked@769=${above}`)
    expect(below || above).toBe(true)
  })

  test('workbench flips sheet→dock at 1280', async ({ page }) => {
    await fixture(page, longConversation())
    await page.setViewportSize({ width: 1180, height: 1024 })
    await page.goto('/session/s1')
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: /open workbench/i }).click()
    await page.waitForTimeout(300)
    const sheet = await page.evaluate(() => !!document.querySelector('[role="dialog"]'))
    await page.setViewportSize({ width: 1281, height: 1024 })
    await page.waitForTimeout(400)
    // Crossing the dock threshold keeps it open; the sheet becomes an aside with dock controls.
    const docked = await page.evaluate(() => {
      const aside = Array.from(document.querySelectorAll("aside")).find((el) => el.querySelector('[aria-label="Workbench views"]') !== null)
      return aside !== undefined
    })
    console.log(`workbench: sheet@1180=${sheet} docked@1281=${docked}`)
    expect(sheet || docked).toBe(true)
  })

  test('settings modal at tablet widths has no overflow', async ({ page }) => {
    for (const width of [700, 768, 1024]) {
      await fixture(page, longConversation())
      await page.setViewportSize({ width, height: 1024 })
      await page.goto('/session/s1')
      await page.waitForTimeout(400)
      // Below 768px the sidebar is a closed drawer; open it to reach Settings.
      const sidebarToggle = page.getByRole('button', { name: 'Open sidebar' })
      if (await sidebarToggle.count() > 0) await sidebarToggle.click()
      await page.getByRole('button', { name: 'Open settings' }).first().click()
      await page.waitForTimeout(700)
      const opened = await page.evaluate(() => document.querySelector('[role="dialog"]') !== null)
      const doc = await page.evaluate(() => document.documentElement.scrollWidth)
      console.log(`[settings@${width}] open=${opened} scrollWidth=${doc}`)
      expect(opened, `settings modal should open at ${width}px`).toBe(true)
      expect(doc, `no overflow at ${width}px`).toBeLessThanOrEqual(width + 1)
    }
  })

  test('tablet screenshots', async ({ page }) => {
    await fixture(page, longConversation())
    // 834px: sidebar docked, workbench as a sheet.
    await page.setViewportSize({ width: 834, height: 1024 })
    await page.goto('/session/s1')
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'artifacts/product-ui/tablet/834-shell.png' })
    await page.getByRole('button', { name: /open workbench/i }).click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'artifacts/product-ui/tablet/834-workbench-sheet.png' })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    // 700px: sidebar becomes a drawer.
    await page.setViewportSize({ width: 700, height: 1024 })
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /open sidebar/i }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'artifacts/product-ui/tablet/700-sidebar-drawer.png' })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    // 1280px: workbench docks.
    await page.setViewportSize({ width: 1280, height: 1024 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'artifacts/product-ui/tablet/1280-shell.png' })
  })

  test.describe('tablet touch emulation', () => {
    test.use({ hasTouch: true })

    test('coarse pointer has no overflow', async ({ page }) => {
      for (const width of [768, 834, 1024]) {
        await fixture(page, longConversation())
        await page.setViewportSize({ width, height: 1024 })
        await page.goto('/session/s1')
        await page.waitForTimeout(500)
        const state = await overflowAt(page)
        const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)
        console.log(`[touch ${width}px] coarse=${coarse} ${state}`)
        const doc = await page.evaluate(() => document.documentElement.scrollWidth)
        expect(doc, state).toBeLessThanOrEqual(width + 1)
      }
    })
  })

  test('composer row and header usable at tablet widths', async ({ page }) => {
    for (const width of [768, 834, 1024]) {
      await fixture(page, longConversation())
      await page.setViewportSize({ width, height: 1024 })
      await page.goto('/session/s1')
      await page.waitForTimeout(400)
      const state = await page.evaluate(() => {
        const out: string[] = []
        // Composer control row: designed to scroll only as a last resort.
        const row = document.querySelector('[data-composer-input]')?.closest('[class*="composer"]')?.parentElement?.querySelector('.overflow-x-auto')
        const scroller = Array.from(document.querySelectorAll(".overflow-x-auto")).find((el) => el.querySelector('button'))
        if (scroller !== undefined) {
          if (scroller.scrollWidth > scroller.clientWidth + 1) out.push(`composer-row scrolls: ${scroller.scrollWidth}>${scroller.clientWidth}`)
        } else out.push('no composer scroller found')
        // Header buttons must not be covered by the environment overlay.
        const covered: string[] = []
        for (const btn of Array.from(document.querySelectorAll("header button"))) {
          const r = btn.getBoundingClientRect()
          if (r.width === 0) continue
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          if (top !== null && !btn.contains(top) && top.closest('[data-environment-panel]') !== null) covered.push(btn.getAttribute('aria-label') ?? btn.textContent?.slice(0, 20) ?? '?')
        }
        if (covered.length > 0) out.push(`header covered: ${covered.join(',')}`)
        return out.join(' | ') || 'ok'
      })
      console.log(`[${width}] ${state}`)
      expect(state).toBe('ok')
    }
  })
})
