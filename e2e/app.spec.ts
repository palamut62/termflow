import { _electron as electron, expect, test } from '@playwright/test'

test('opens the help center and the tmux settings in the real Electron renderer', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERMFLOW_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('TermFlow', { exact: true })).toBeVisible()
    const recovery = page.getByText('Continue restored session')
    if (await recovery.isVisible().catch(() => false)) await recovery.click()

    // Help and the developer surfaces live behind the toolbar's More menu.
    await page.getByLabel('More actions').click()
    await page.getByTitle('Help').click()
    await expect(page.getByText('TermFlow Help Center')).toBeVisible()
    // The tmux topics are the product's core documentation now.
    await page.getByPlaceholder('Search help topics...').fill('panes')
    await expect(page.getByText('Split a window into panes').first()).toBeVisible()
    await page.getByLabel('Close help').click()

    // The prefix key is the defining tmux setting; it must be reachable.
    await page.getByLabel('Open Settings').click()
    await page.locator('.settings-nav-item', { hasText: 'Terminal' }).click()
    await expect(page.getByText('tmux prefix key')).toBeVisible()
  } finally {
    await app.close()
  }
})
