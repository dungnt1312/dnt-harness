// What each gallery row reads as, which of its text is cut, and whether axe is clean.
// Usage: node scripts/measure-toolcards.mjs <baseUrl>
import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const [base = 'http://127.0.0.1:4176'] = process.argv.slice(2)
const browser = await chromium.launch()
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } })
      const page = await context.newPage()
      await page.goto(`${base}/dev/toolcard-gallery.html?theme=${theme}`)
      await page.waitForSelector('[data-shot="rows"]')
      for (let left = await page.locator('[data-expand] > div > button[aria-expanded="false"]').count(); left > 0; left -= 1) await page.locator('[data-expand] > div > button[aria-expanded="false"]').first().click()
      await page.waitForTimeout(700)
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
      const axeText = axe.violations.length === 0 ? 'clean' : axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`).join(' | ')
      console.log(`\n=== ${theme} ${width}px — axe ${axeText}`)
      if (theme === 'dark') { await context.close(); continue }
      const report = await page.$$eval('[data-label]', (rows) => rows.map((row) => {
        const line = row.firstElementChild?.matches('button, div') ? (row.querySelector('button[aria-expanded]') ?? row.firstElementChild) : row
        const cut = [...line.querySelectorAll('span')]
          .filter((span) => getComputedStyle(span).display !== 'none' && span.children.length === 0 && span.scrollWidth > span.clientWidth + 1)
          .map((span) => `"${span.textContent}" (${span.clientWidth}/${span.scrollWidth}px)`)
        return { label: row.getAttribute('data-label'), text: line.innerText.replace(/\s+/g, ' ').trim(), cut }
      }))
      for (const { label, text, cut } of report) console.log(`${label.padEnd(22)} | ${text}${cut.length ? `\n${' '.repeat(22)}   CUT: ${cut.join(' · ')}` : ''}`)
      await context.close()
    }
  }
} finally {
  await browser.close()
}
