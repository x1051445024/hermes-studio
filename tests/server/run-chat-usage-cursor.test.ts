import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionDetailMock = vi.fn()
const getSessionMock = vi.fn()
const getSessionContextMessagesMock = vi.fn()
const getSessionContextMessageMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const deleteCompressionSnapshotMock = vi.fn()
const getRecordedUsageTotalsMock = vi.fn()
const getUsageMock = vi.fn()
const getLatestModelCallUsageMock = vi.fn()
const getContextUsageMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSessionDetail: getSessionDetailMock,
  getSession: getSessionMock,
  getSessionContextMessages: getSessionContextMessagesMock,
  getSessionContextMessage: getSessionContextMessageMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
  deleteCompressionSnapshot: deleteCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: vi.fn(),
  getRecordedUsageTotals: getRecordedUsageTotalsMock,
  getUsage: getUsageMock,
  getLatestModelCallUsage: getLatestModelCallUsageMock,
  getContextUsage: getContextUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe('cursor-aware chat usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getContextUsageMock.mockReturnValue(undefined)
    getSessionMock.mockReturnValue({ id: 'session-1', history_revision: 0 })
    getSessionDetailMock.mockImplementation(() => {
      throw new Error('full history must not be read')
    })
    getCompressionSnapshotMock.mockReturnValue({
      summary: 'summary',
      lastMessageIndex: 9,
      messageCountAtTime: 10,
      compressedThroughMessageId: 10,
      protectedHeadThroughMessageId: 1,
      historyRevision: 0,
    })
    const rows = [
      { id: 1, session_id: 'session-1', role: 'user', content: 'head', timestamp: 1 },
      { id: 11, session_id: 'session-1', role: 'assistant', content: 'tail', timestamp: 11 },
    ]
    getSessionContextMessagesMock.mockImplementation((_sid: string, options: { afterId?: number; throughId?: number } = {}) => (
      rows.filter(row => (
        (options.afterId == null || row.id > options.afterId) &&
        (options.throughId == null || row.id <= options.throughId)
      ))
    ))
    getSessionContextMessageMock.mockImplementation((_sid: string, id: number) => (
      id === 10
        ? { id: 10, session_id: 'session-1', role: 'assistant', content: 'boundary', timestamp: 10 }
        : rows.find(row => row.id === id) || null
    ))
  })

  it('counts summary plus bounded cursor context without loading full history', async () => {
    const { calcAndUpdateUsage } = await import('../../packages/server/src/modules/studio/services/chat-run/usage')
    const state: any = { messages: [], events: [], queue: [], isWorking: false }
    const emit = vi.fn()

    const usage = await calcAndUpdateUsage('session-1', state, emit, {
      truncateToolResultsForContext: true,
    })

    expect(usage.inputTokens + usage.outputTokens).toBeGreaterThan(0)
    expect(getSessionDetailMock).not.toHaveBeenCalled()
    expect(deleteCompressionSnapshotMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      session_id: 'session-1',
    }))
  })

  it('uses native Coding Agent usage without consulting messages or compression snapshots', async () => {
    getRecordedUsageTotalsMock.mockReturnValue({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 5 })
    getUsageMock.mockReturnValue({ input_tokens: 70, output_tokens: 10, model: 'native-model', cache_read_tokens: 20, cache_write_tokens: 3 })
    // Lifetime totals are cost counters; the window holds the last call only,
    // cached prefix included.
    getLatestModelCallUsageMock.mockReturnValue({
      input_tokens: 70,
      output_tokens: 10,
      cache_read_tokens: 6_000,
      cache_write_tokens: 500,
      usage_scope: 'model_call',
    })
    const { calcAndUpdateUsage } = await import('../../packages/server/src/modules/studio/services/chat-run/usage')
    const state: any = { messages: [], events: [], queue: [], isWorking: false }

    const emit = vi.fn()
    const usage = await calcAndUpdateUsage('session-1', state, emit, {
      nativeSource: 'coding_agent',
    })

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      nativeUsageAvailable: true,
      nativeModel: 'native-model',
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
      contextInputTokens: 6_570,
      contextOutputTokens: 10,
    })
    expect(state).toMatchObject({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 5 })
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      inputTokens: 100, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 5,
    }))
    expect(getCompressionSnapshotMock).not.toHaveBeenCalled()
    expect(getSessionDetailMock).not.toHaveBeenCalled()
    expect(getSessionContextMessagesMock).not.toHaveBeenCalled()
  })

  it('uses a newer native snapshot after compaction without changing lifetime totals', async () => {
    getRecordedUsageTotalsMock.mockReturnValue({ inputTokens: 900_000, outputTokens: 40_000 })
    getLatestModelCallUsageMock.mockReturnValue({
      input_tokens: 100_000, output_tokens: 1_000, created_at: 100, usage_scope: 'model_call',
    })
    getContextUsageMock.mockReturnValue({ contextTokens: 20_000, updatedAt: 200 })
    const { calcAndUpdateUsage } = await import('../../packages/server/src/modules/studio/services/chat-run/usage')
    const state: any = { messages: [], events: [], queue: [], isWorking: false }

    const usage = await calcAndUpdateUsage('session-1', state, vi.fn(), { nativeSource: 'coding_agent' })

    expect(usage.inputTokens).toBe(900_000)
    expect(usage.outputTokens).toBe(40_000)
    expect((usage.contextInputTokens || 0) + (usage.contextOutputTokens || 0)).toBe(20_000)
    expect(getSessionDetailMock).not.toHaveBeenCalled()
  })

  it('falls back to the latest cached-inclusive row when only run aggregates were recorded', async () => {
    getRecordedUsageTotalsMock.mockReturnValue({ inputTokens: 100, outputTokens: 40 })
    getLatestModelCallUsageMock.mockReturnValue(undefined)
    // Global native turns (Codex/Grok) record run-scope aggregates only; the
    // latest row still seeds the bar with its cached-inclusive totals.
    getUsageMock.mockReturnValue({ input_tokens: 70, output_tokens: 10, cache_read_tokens: 20, cache_write_tokens: 3 })
    const { calcAndUpdateUsage } = await import('../../packages/server/src/modules/studio/services/chat-run/usage')
    const state: any = { messages: [], events: [], queue: [], isWorking: false }

    const usage = await calcAndUpdateUsage('session-1', state, vi.fn(), {
      nativeSource: 'coding_agent',
    })

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      nativeUsageAvailable: true,
      nativeModel: '',
      contextInputTokens: 93,
      contextOutputTokens: 10,
    })
  })

  it('does not emit fake zero usage when the native ledger has no row', async () => {
    getRecordedUsageTotalsMock.mockReturnValue({ inputTokens: 0, outputTokens: 0 })
    getUsageMock.mockReturnValue(undefined)
    const { calcAndUpdateUsage } = await import('../../packages/server/src/modules/studio/services/chat-run/usage')
    const emit = vi.fn()
    const result = await calcAndUpdateUsage('session-1', { messages: [], events: [], queue: [], isWorking: false } as any, emit, { nativeSource: 'coding_agent' })
    expect(result.nativeUsageAvailable).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })
})
