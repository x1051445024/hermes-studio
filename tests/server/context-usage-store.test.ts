import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let db: DatabaseSync
const jsonRows = new Map<string, Record<string, unknown>>()
let sqliteAvailable = true

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  isSqliteAvailable: () => sqliteAvailable,
  getDb: () => db,
  jsonSet: (table: string, key: string, value: Record<string, unknown>) => jsonRows.set(`${table}:${key}`, value),
  jsonGet: (table: string, key: string) => jsonRows.get(`${table}:${key}`),
  jsonGetAll: () => ({}),
  jsonDelete: (table: string, key: string) => jsonRows.delete(`${table}:${key}`),
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import * as usageStore from '../../packages/server/src/modules/studio/repositories/usage-store'
import { clearSessionMessages, deleteSession, updateSession } from '../../packages/server/src/modules/studio/repositories/session-store'

describe('non-billable context usage snapshots', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    sqliteAvailable = true
    jsonRows.clear()
    initAllHermesTables()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  it('persists the newest measurement without creating or changing billable rows', () => {
    usageStore.updateUsage('context-1', {
      runId: 'run-1', source: 'coding_agent', agent: 'codex',
      inputTokens: 120, outputTokens: 70, apiCalls: 1,
    })
    const before = usageStore.getRecordedUsageTotals('context-1', 'coding_agent')
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200)

    usageStore.saveContextUsage('context-1', 66_624)
    usageStore.saveContextUsage('context-1', 12_345.9)

    expect(usageStore.getContextUsage('context-1')).toEqual({ contextTokens: 12_345, updatedAt: 200 })
    expect(usageStore.getContextUsage('other-session')).toBeUndefined()
    expect(usageStore.getRecordedUsageTotals('context-1', 'coding_agent')).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_usage').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_context_usage').get()).toEqual({ count: 1 })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, undefined, null, '123'])(
    'does not replace a valid measurement with invalid value %s',
    value => {
      usageStore.saveContextUsage('context-1', 100)
      usageStore.saveContextUsage('context-1', value as number)
      expect(usageStore.getContextUsage('context-1')?.contextTokens).toBe(100)
    },
  )

  it('allows an explicit zero and removes snapshots together with usage', () => {
    usageStore.saveContextUsage('context-1', 100)
    usageStore.saveContextUsage('context-1', 0)
    expect(usageStore.getContextUsage('context-1')?.contextTokens).toBe(0)
    usageStore.deleteUsage('context-1')
    expect(usageStore.getContextUsage('context-1')).toBeUndefined()
  })

  it('keeps JSON fallback snapshots separate from its billable record', () => {
    sqliteAvailable = false
    usageStore.updateUsage('context-1', { inputTokens: 120, outputTokens: 70 })
    const before = usageStore.getUsage('context-1')
    usageStore.saveContextUsage('context-1', 66_624)
    expect(usageStore.getContextUsage('context-1')?.contextTokens).toBe(66_624)
    expect(usageStore.getUsage('context-1')).toEqual(before)
    usageStore.deleteUsage('context-1')
    expect(usageStore.getContextUsage('context-1')).toBeUndefined()
  })

  it.each(['clear', 'delete'])('removes obsolete context when sessions %s their history', operation => {
    db.prepare('INSERT INTO sessions (id, started_at, last_active) VALUES (?, 0, 0)').run('context-1')
    usageStore.saveContextUsage('context-1', 66_624)

    if (operation === 'clear') clearSessionMessages('context-1')
    else deleteSession('context-1')

    expect(usageStore.getContextUsage('context-1')).toBeUndefined()
  })

  it('does not revive an old model call after clearing history, even within the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    db.prepare('INSERT INTO sessions (id, started_at, last_active) VALUES (?, 0, 0)').run('context-1')
    usageStore.updateUsage('context-1', {
      source: 'coding_agent', agent: 'claude_code', usageScope: 'model_call',
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 60_000,
    })
    usageStore.saveContextUsage('context-1', 60_120)
    const ledger = db.prepare('SELECT * FROM session_usage').all()
    const totals = usageStore.getRecordedUsageTotals('context-1', 'coding_agent')

    clearSessionMessages('context-1')

    expect(usageStore.getLatestModelCallUsage('context-1')).toBeUndefined()
    expect(usageStore.getContextUsage('context-1')).toBeUndefined()
    expect(db.prepare('SELECT * FROM session_usage').all()).toEqual(ledger)
    expect(usageStore.getRecordedUsageTotals('context-1', 'coding_agent')).toEqual(totals)

    usageStore.updateUsage('context-1', {
      source: 'coding_agent', agent: 'claude_code', usageScope: 'model_call',
      inputTokens: 300, outputTokens: 40,
    })
    expect(usageStore.getLatestModelCallUsage('context-1')).toEqual(expect.objectContaining({
      input_tokens: 300, output_tokens: 40,
    }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_usage').get()).toEqual({ count: 2 })
  })

  it('invalidates both measurements when the native session changes, without losing billing', () => {
    db.prepare(`
      INSERT INTO sessions (id, started_at, last_active, agent_native_session_id) VALUES (?, 0, 0, ?)
    `).run('context-1', 'native-before')
    usageStore.updateUsage('context-1', {
      source: 'coding_agent', agent: 'claude_code', usageScope: 'model_call',
      inputTokens: 100, outputTokens: 20,
    })
    usageStore.saveContextUsage('context-1', 60_120)
    const totals = usageStore.getRecordedUsageTotals('context-1', 'coding_agent')

    updateSession('context-1', { title: 'Renamed only' })
    expect(usageStore.getContextUsage('context-1')?.contextTokens).toBe(60_120)
    expect(usageStore.getLatestModelCallUsage('context-1')).toBeDefined()

    updateSession('context-1', { agent_native_session_id: 'native-after' })

    expect(usageStore.getContextUsage('context-1')).toBeUndefined()
    expect(usageStore.getLatestModelCallUsage('context-1')).toBeUndefined()
    expect(usageStore.getRecordedUsageTotals('context-1', 'coding_agent')).toEqual(totals)

    usageStore.saveContextUsage('context-1', 2_000)
    expect(usageStore.getContextUsage('context-1')?.contextTokens).toBe(2_000)
  })

  it('invalidates a retained snapshot when history revision changes', () => {
    db.prepare('INSERT INTO sessions (id, started_at, last_active) VALUES (?, 0, 0)').run('context-1')
    usageStore.saveContextUsage('context-1', 60_120)
    updateSession('context-1', { history_revision: 1 })
    expect(usageStore.getContextUsage('context-1')).toBeUndefined()
    usageStore.saveContextUsage('context-1', 2_000)
    expect(usageStore.getContextUsage('context-1')?.contextTokens).toBe(2_000)
  })

  it('keeps delayed billing in its original history revision instead of reviving cleared context', () => {
    db.prepare('INSERT INTO sessions (id, started_at, last_active) VALUES (?, 0, 0)').run('context-1')
    clearSessionMessages('context-1')
    usageStore.updateUsage('context-1', {
      source: 'coding_agent', usageScope: 'model_call',
      inputTokens: 100, outputTokens: 20,
      contextHistoryRevision: 0, contextNativeSessionId: '',
    })
    expect(usageStore.getLatestModelCallUsage('context-1')).toBeUndefined()
    expect(usageStore.getRecordedUsageTotals('context-1', 'coding_agent')).toEqual(expect.objectContaining({
      inputTokens: 100, outputTokens: 20,
    }))
  })

  it('reopens cleared history with unknown context and intact lifetime billing, then accepts a fresh call', async () => {
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')
    const { calcAndUpdateUsage } = await import('../../packages/server/src/modules/studio/services/chat-run/usage')
    db.prepare(`
      INSERT INTO sessions (id, started_at, last_active, source, agent)
      VALUES (?, 0, 0, 'coding_agent', 'claude_code')
    `).run('context-1')
    usageStore.updateUsage('context-1', {
      source: 'coding_agent', usageScope: 'model_call',
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 60_000,
    })
    usageStore.saveContextUsage('context-1', 66_624)
    expect((await loadSessionStateFromDb('context-1', new Map())).contextTokens).toBe(66_624)

    clearSessionMessages('context-1')
    const reopened = await loadSessionStateFromDb('context-1', new Map())
    expect(reopened.contextTokens).toBeUndefined()
    expect(reopened.inputTokens).toBe(100)
    expect(reopened.outputTokens).toBe(20)
    expect(await calcAndUpdateUsage('context-1', reopened, vi.fn(), { nativeSource: 'coding_agent' }))
      .toMatchObject({ inputTokens: 100, outputTokens: 20 })

    usageStore.updateUsage('context-1', {
      source: 'coding_agent', usageScope: 'model_call', inputTokens: 2_500, outputTokens: 100,
    })
    expect((await loadSessionStateFromDb('context-1', new Map())).contextTokens).toBe(2_600)
  })

  it('adds boundary columns to old databases without rewriting billed tokens', () => {
    db.prepare('INSERT INTO sessions (id, started_at, last_active, history_revision) VALUES (?, 0, 0, 1)')
      .run('context-1')
    for (const table of ['session_usage', 'session_context_usage']) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN context_history_revision`)
      db.exec(`ALTER TABLE ${table} DROP COLUMN context_native_session_id`)
    }
    db.prepare(`
      INSERT INTO session_usage (session_id, usage_scope, input_tokens, output_tokens)
      VALUES (?, 'model_call', 123, 45)
    `).run('context-1')
    db.prepare('INSERT INTO session_context_usage (session_id, context_tokens, updated_at) VALUES (?, 60000, 1)')
      .run('context-1')

    initAllHermesTables()

    expect(usageStore.getUsage('context-1')).toEqual(expect.objectContaining({
      input_tokens: 123, output_tokens: 45,
    }))
    expect(usageStore.getLatestModelCallUsage('context-1')).toBeUndefined()
    expect(usageStore.getContextUsage('context-1')).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_usage').get()).toEqual({ count: 1 })
  })

  it.each(['history_revision', 'agent_native_session_id'])('applies the %s boundary in JSON fallback', field => {
    sqliteAvailable = false
    jsonRows.set('sessions:context-1', { history_revision: 0, agent_native_session_id: 'native-before' })
    usageStore.updateUsage('context-1', {
      usageScope: 'model_call', inputTokens: 100, outputTokens: 20,
    })
    usageStore.saveContextUsage('context-1', 60_120)
    const ledger = usageStore.getUsage('context-1')
    jsonRows.set('sessions:context-1', {
      history_revision: field === 'history_revision' ? 1 : 0,
      agent_native_session_id: field === 'agent_native_session_id' ? 'native-after' : 'native-before',
    })

    expect(usageStore.getContextUsage('context-1')).toBeUndefined()
    expect(usageStore.getLatestModelCallUsage('context-1')).toBeUndefined()
    expect(usageStore.getUsage('context-1')).toEqual(ledger)

    usageStore.updateUsage('context-1', {
      usageScope: 'model_call', inputTokens: 300, outputTokens: 40,
    })
    usageStore.saveContextUsage('context-1', 340)
    expect(usageStore.getLatestModelCallUsage('context-1')?.input_tokens).toBe(300)
    expect(usageStore.getContextUsage('context-1')?.contextTokens).toBe(340)
  })
})
