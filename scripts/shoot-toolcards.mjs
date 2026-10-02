// Screenshots of the dev tool-card gallery (web/dev/toolcard-gallery.html).
// Usage: node scripts/shoot-toolcards.mjs <baseUrl> <outDir> [tag] [pagePath]
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const [base = 'http://127.0.0.1:4176', out = 'artifacts/toolcards', tag = 'current', pagePath = '/dev/toolcard-gallery.html'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 })
      await page.goto(`${base}${pagePath}?theme=${theme}`)
      await page.waitForSelector('[data-shot="rows"]')
      for (let left = await page.locator('[data-expand] > div > button[aria-expanded="false"]').count(); left > 0; left -= 1) await page.locator('[data-expand] > div > button[aria-expanded="false"]').first().click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${out}/${tag}-${theme}-${width}.png`, fullPage: true, animations: 'disabled' })
      await page.close()
    }
  }
} finally {
  await browser.close()
}
console.log('shots written to', out)
