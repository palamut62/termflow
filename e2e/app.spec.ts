import { _electron as electron, expect, test, type Page } from '@playwright/test'

async function openMoreItem(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByTitle(title).click()
}

test('opens core developer surfaces in the real Electron renderer', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERMFLOW_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('TermFlow', { exact: true })).toBeVisible()
    const recovery = page.getByText('Continue restored session')
    if (await recovery.isVisible().catch(() => false)) await recovery.click()
    await openMoreItem(page, 'Help')
    await expect(page.getByText('TermFlow Help Center')).toBeVisible()
    await page.getByLabel('Close help').click()
    await openMoreItem(page, 'Developer Workbench')
    await expect(page.getByText('Developer Workbench', { exact: true })).toBeVisible()
    await expect(page.getByText('Files', { exact: true })).toBeVisible()
    await expect(page.getByText('Command history', { exact: true })).toBeVisible()
    await expect(page.getByText('Git', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('creates, configures, and deletes an agent team in the real Electron renderer', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERMFLOW_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    const teamsButton = page.getByRole('button', { name: 'Agent Teams' })
    await expect(teamsButton).toBeEnabled()
    await teamsButton.click()
    await expect(page.getByRole('heading', { name: 'Agent Teams' })).toBeVisible()

    await page.getByRole('button', { name: 'New agent team' }).click()
    await page.getByRole('button', { name: /Product Delivery Team/ }).click()
    await expect(page.getByRole('heading', { name: 'Prepared specialists and instructions' })).toBeVisible()
    await expect(page.locator('.team-template-members article')).toHaveCount(5)
    await expect(page.locator('.team-template-tasks article')).toHaveCount(5)
    await page.getByPlaceholder('Describe the exact outcome you want this professional team to deliver.').fill('Verify the Agent Teams workflow')
    await page.getByRole('button', { name: 'Create prepared team' }).click()

    await expect(page.getByRole('heading', { name: 'Verify the Agent Teams workflow' })).toBeVisible()
    await expect(page.getByText('5 members · 5 tasks')).toBeVisible()
    const analyst = page.locator('.team-members article').filter({ hasText: 'Product Analyst' })
    await analyst.getByRole('combobox').selectOption('opencode')
    await expect(analyst.getByRole('combobox')).toHaveValue('opencode')
    await expect(page.locator('.team-tasks article')).toHaveCount(5)

    await page.getByTitle('Delete team').click()
    await expect(page.getByRole('heading', { name: 'Delete agent team?' })).toBeVisible()
    await page.getByRole('dialog').last().getByRole('button', { name: 'Delete team' }).click()
    await expect(page.getByText('Create your first agent team')).toBeVisible()
  } finally {
    await app.close()
  }
})
