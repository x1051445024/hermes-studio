import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const width of [1280, 390]) {
  test(`cleared native context remains unknown instead of using lifetime billing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const sid = 'context-cleared-session'
    await page.addInitScript(({ sid }) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        [sid]: {
          session_id: sid, messages: [], isWorking: false, events: [],
          inputTokens: 9_000_000, outputTokens: 40_000,
        },
      }
    }, { sid })
    await mockHermesApi(page, {
      sessions: [{
        id: sid, profile: 'research', source: 'coding_agent', agent: 'codex',
        agent_mode: 'global', model: 'test-model', provider: 'test-provider',
        title: 'Cleared context', started_at: 1, last_active: 2, message_count: 0,
        input_tokens: 9_000_000, output_tokens: 40_000,
      }],
    })
    await mockChatSocket(page)
    await page.goto(`/#/hermes/session/${sid}`)
    const context = page.locator('.context-info')
    await expect(context).toContainText('unknown', { timeout: 20_000 })
    await expect(context).not.toContainText('9.0M')
    await page.reload()
    await expect(context).toContainText('unknown', { timeout: 20_000 })
  })

  test(`coding-agent context uses the restored snapshot at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const sid = 'context-snapshot-session'
    await page.addInitScript(({ sid }) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        [sid]: {
          session_id: sid,
          messages: [{ id: 1, role: 'user', content: 'Context snapshot check', timestamp: 1 }],
          isWorking: false, events: [],
          inputTokens: 9_000_000, outputTokens: 40_000, contextTokens: 66_624,
        },
      }
    }, { sid })
    await mockHermesApi(page, {
      sessions: [{
        id: sid, profile: 'research', source: 'coding_agent', agent: 'codex', agent_mode: 'global',
        model: 'test-model', provider: 'test-provider', title: 'Context snapshot',
        started_at: 1, last_active: 2, message_count: 1,
        input_tokens: 9_000_000, output_tokens: 40_000,
      }],
    })
    await mockChatSocket(page)
    await page.goto(`/#/hermes/session/${sid}`)
    await expect(page.getByText('Context snapshot check', { exact: true })).toBeVisible({ timeout: 20_000 })
    const context = page.locator('.context-info')
    await expect(context).toContainText('66.6k')
    await page.reload()
    await expect(page.getByText('Context snapshot check', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(context).toContainText('66.6k')

    await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Check compacted context')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__.emitted.some((event: any) => event.event === 'run'))
    await page.evaluate(sid => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'context-run' })
      socket.__trigger('usage.updated', {
        event: 'usage.updated', session_id: sid,
        inputTokens: 9_000_000, outputTokens: 40_000, contextTokens: 20_000,
      })
    }, sid)
    await expect(context).toContainText('20.0k')
    await expect(context).not.toContainText('9.0M')
    await page.screenshot({ path: testInfo.outputPath(`context-${width}.png`), fullPage: true })
  })
}
