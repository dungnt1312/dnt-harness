import { expect, type Locator, type Page } from '@playwright/test'

/** The workbench region, opening it first when it is a closed sheet. */
export async function openWorkbench(page: Page): Promise<Locator> {
  const opener = page.getByRole('button', { name: 'Open workbench' })
  if (await opener.isVisible()) await opener.click()
  const workbench = page.getByRole('region', { name: 'Workbench' })
  await expect(workbench).toBeVisible()
  return workbench
}

/**
 * Select a workbench view, opening it from the nav picker when it has no tab
 * yet. Only Files is permanently in the strip; the rest are opened on demand,
 * and the picker is portalled outside the workbench region.
 */
export async function selectWorkbenchView(page: Page, name: string): Promise<Locator> {
  const workbench = await openWorkbench(page)
  const tab = workbench.getByRole('button', { name, exact: true })
  if (await tab.count() === 0) {
    await workbench.getByRole('button', { name: 'Open a view' }).click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  } else {
    await tab.click()
  }
  await expect(tab).toHaveAttribute('aria-pressed', 'true')
  return workbench
}
