import { _electron as electron, expect, test } from '@playwright/test'

test('opens core developer surfaces in the real Electron renderer', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERMFLOW_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('TermFlow', { exact: true })).toBeVisible()
    const recovery = page.getByText('Continue restored session')
    if (await recovery.isVisible().catch(() => false)) await recovery.click()
    await page.getByTitle('Help').click()
    await expect(page.getByText('TermFlow Help Center')).toBeVisible()
    await page.getByLabel('Close help').click()
    await page.getByTitle('Developer Workbench').click()
    await expect(page.getByText('Developer Workbench', { exact: true })).toBeVisible()
    await expect(page.getByText('Files', { exact: true })).toBeVisible()
    await expect(page.getByText('Command history', { exact: true })).toBeVisible()
    await expect(page.getByText('Git', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})
