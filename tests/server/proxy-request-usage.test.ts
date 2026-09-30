import { afterEach, expect, it, vi } from 'vitest'
import { codingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { codexProxyResponses, registerCodexProxyTarget } from '../../packages/server/src/modules/coding-agents/services/codex/proxy'
import { claudeProxyMessages, registerClaudeCodeProxyTarget } from '../../packages/server/src/modules/coding-agents/services/claude-code/proxy'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['codex', 'claude'])('captures separate %s request usage before awaiting the upstream', async kind => {
  const observers = [vi.fn(), vi.fn()]
  const capture = vi.spyOn(codingAgentRunManager, 'createProxyUsageObserver')
    .mockReturnValueOnce(observers[0])
    .mockReturnValueOnce(observers[1])
  vi.spyOn(codingAgentRunManager, 'handleResponseEvent').mockImplementation(() => {})
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls++
    expect(capture).toHaveBeenCalledTimes(calls)
    const response = {
      id: `response-${calls}`, object: 'response', status: 'completed',
      model: 'test-model', output: [], usage: { input_tokens: 100, output_tokens: 20 },
    }
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }))
  const input = {
    profile: 'default', provider: 'test-provider', model: 'test-model',
    baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-test-key',
    apiMode: 'codex_responses' as const, agentSessionId: `request-test-${kind}`,
  }
  const target = kind === 'codex' ? registerCodexProxyTarget(input) : registerClaudeCodeProxyTarget(input)
  const context = (): any => ({
    params: { key: target.routeKey },
    request: { body: { stream: true, model: 'test-model', input: 'hi', messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 } },
    get: (name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${target.token}` : '',
    set: vi.fn(),
  })
  const first = context()
  const second = context()
  const handler = kind === 'codex' ? codexProxyResponses : claudeProxyMessages
  await handler(first)
  await handler(second)
  for await (const _chunk of first.body) { /* Drain the lazy response stream. */ }
  for await (const _chunk of second.body) { /* Drain the lazy response stream. */ }
  await vi.waitFor(() => {
    for (const [index, observer] of observers.entries()) {
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({
        type: 'response.completed',
        data: expect.objectContaining({ response: expect.objectContaining({ id: `response-${index + 1}` }) }),
      }))
    }
  })
})
