import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
const getSessionDetailPaginatedMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn()
const getRecordedUsageTotalsMock = vi.fn()
const getUsageMock = vi.fn()
const getLatestModelCallUsageMock = vi.fn()
const getContextUsageMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  createSession: vi.fn(),
  addMessage: vi.fn(),
  updateSessionStats: vi.fn(),
  getSessionDetailPaginated: getSessionDetailPaginatedMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: vi.fn(),
  getRecordedUsageTotals: getRecordedUsageTotalsMock,
  getUsage: getUsageMock,
  getLatestModelCallUsage: getLatestModelCallUsageMock,
  getContextUsage: getContextUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  countTokens: vi.fn(() => 0),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildCompressedHistory: vi.fn(),
  buildDbHistory: buildDbHistoryMock,
  buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
  getOrCreateSession: vi.fn(),
}))

// contextTokensFromUsageRecord stays real so the seeded context bar is checked
// against the shipped cache-inclusive formula, not against a restatement of it.
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../packages/server/src/modules/studio/services/chat-run/usage')>()),
  calcAndUpdateUsage: vi.fn(),
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/message-format', () => ({
  handleMessage: vi.fn((messages: any[]) => messages),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/content-blocks', () => ({
  contentBlocksToString: vi.fn((value: any) => String(value || '')),
  extractTextForPreview: vi.fn((value: any) => String(value || '')),
  isContentBlockArray: vi.fn(() => false),
  convertContentBlocks: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/sse-utils', () => ({
  readSseFrames: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/response-utils', () => ({
  extractResponseText: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/response-stream', () => ({
  applyResponseStreamEvent: vi.fn(),
  flushResponseRunToDb: vi.fn(),
}))

describe('loadSessionStateFromDb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getContextUsageMock.mockReturnValue(undefined)
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: 'gpt-test',
      provider: 'openai',
      source: 'cli',
    })
    getSessionDetailPaginatedMock.mockReturnValue({
      messages: [
        { role: 'user', content: 'old large context' },
        { role: 'assistant', content: 'old large answer' },
        { role: 'user', content: 'new tail' },
      ],
    })
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'small summary',
      lastMessageIndex: 0,
      messageCountAtTime: 1,
    })
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'old large context' },
      { role: 'assistant', content: 'old large answer' },
      { role: 'user', content: 'new tail' },
    ])
    buildSnapshotAwareHistoryMock.mockResolvedValue([
      { role: 'user', content: '[Previous context summary]\n\nsmall summary' },
      { role: 'user', content: 'new tail' },
    ])
    estimateUsageTokensFromMessagesMock.mockImplementation((messages: any[]) => {
      if (messages?.[0]?.content?.includes('small summary')) {
        return { inputTokens: 9_000, outputTokens: 0 }
      }
      return { inputTokens: 28_000, outputTokens: 0 }
    })
    getRecordedUsageTotalsMock.mockReturnValue({
      inputTokens: 28_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiCalls: 1,
    })
    getUsageMock.mockReturnValue({ input_tokens: 8_000, output_tokens: 1_000 })
    getLatestModelCallUsageMock.mockReturnValue({
      input_tokens: 8_000,
      output_tokens: 1_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      usage_scope: 'model_call',
    })
  })

  it('hydrates persisted usage without reconstructing complete history on resume', async () => {
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(buildDbHistoryMock).not.toHaveBeenCalled()
    expect(buildSnapshotAwareHistoryMock).not.toHaveBeenCalled()
    expect(state.inputTokens).toBe(28_000)
    expect(state.outputTokens).toBe(2_000)
    expect(state.contextTokens).toBe(9_000)
  })

  it('seeds the context bar with the cached prompt prefix of the last model call', async () => {
    // Warm coding-agent session: almost the whole prompt is served from the
    // provider cache, so input+output alone would read 3.8k out of 229k.
    getLatestModelCallUsageMock.mockReturnValue({
      input_tokens: 3_614,
      output_tokens: 179,
      cache_read_tokens: 225_433,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      usage_scope: 'model_call',
    })
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(state.contextTokens).toBe(229_226)
  })

  it('leaves the context bar unset when the session has no per-call usage row', async () => {
    getLatestModelCallUsageMock.mockReturnValue(undefined)
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(state.contextTokens).toBeUndefined()
    expect(state.inputTokens).toBe(28_000)
  })

  it('restores a native context snapshot without using run totals as context', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', source: 'coding_agent', agent: 'codex' })
    getLatestModelCallUsageMock.mockReturnValue(undefined)
    getContextUsageMock.mockReturnValue({ contextTokens: 66_624, updatedAt: 200 })
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(state.contextTokens).toBe(66_624)
    expect(state.inputTokens).toBe(28_000)
    expect(state.outputTokens).toBe(2_000)
  })

  it('does not restore an older snapshot over a newer per-call measurement', async () => {
    getContextUsageMock.mockReturnValue({ contextTokens: 66_624, updatedAt: 100 })
    getLatestModelCallUsageMock.mockReturnValue({
      input_tokens: 1_000, output_tokens: 100, cache_read_tokens: 9_000, created_at: 200,
      usage_scope: 'model_call',
    })
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(state.contextTokens).toBe(10_100)
  })

  it('retains messages and accounting when the optional context snapshot cannot be read', async () => {
    getContextUsageMock.mockImplementation(() => { throw new Error('snapshot unavailable') })
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(state.messages).toHaveLength(3)
    expect(state.inputTokens).toBe(28_000)
    expect(state.outputTokens).toBe(2_000)
    expect(state.contextTokens).toBe(9_000)
  })

  it('can restore a native snapshot even when per-call context lookup fails', async () => {
    getLatestModelCallUsageMock.mockImplementation(() => { throw new Error('per-call lookup unavailable') })
    getContextUsageMock.mockReturnValue({ contextTokens: 66_624, updatedAt: 200 })
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(state.messages).toHaveLength(3)
    expect(state.contextTokens).toBe(66_624)
  })

  it('restores the persisted tool-result anchor for a Hermes background delegation', async () => {
    getSessionDetailPaginatedMock.mockReturnValue({
      messages: [{
        id: 42,
        role: 'tool',
        content: JSON.stringify({
          mode: 'background',
          delegation_id: 'delegation-1',
          goals: ['Inspect the task'],
        }),
        display_content: null,
        tool_call_id: 'delegate-call-1',
        tool_name: 'delegate_task',
        timestamp: 100,
      }],
    })
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(state.backgroundDelegations).toEqual({
      'delegation-1': expect.objectContaining({
        delegationId: 'delegation-1',
        status: 'running',
        messageId: 42,
        toolCallId: 'delegate-call-1',
        dispatchPayload: expect.objectContaining({ mode: 'background' }),
      }),
    })
  })

  it('restores Cursor native usage without turning aggregate consumption into context occupancy', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'cursor', source: 'coding_agent' })
    getRecordedUsageTotalsMock.mockReturnValue({ inputTokens: 24_003, outputTokens: 474, cacheReadTokens: 20_736, cacheWriteTokens: 0 })
    getUsageMock.mockReturnValue({ input_tokens: 24_003, output_tokens: 474, cache_read_tokens: 20_736 })
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(getRecordedUsageTotalsMock).toHaveBeenCalledWith('session-1', 'coding_agent')
    expect(state.inputTokens).toBe(24_003)
    expect(state.outputTokens).toBe(474)
    expect(state.cacheReadTokens).toBe(20_736)
    expect(state.cacheWriteTokens).toBe(0)
    expect(state.contextTokens).toBeUndefined()
  })
})
