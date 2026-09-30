import { describe, it, expect, vi } from 'vitest'

const mockSocket = vi.hoisted(() => ({
  id: 'agent-socket-1',
  connected: true,
  io: { on: vi.fn() },
  on: vi.fn((event: string, handler: (...args: any[]) => void) => {
    if (event === 'connect') queueMicrotask(() => handler())
    return mockSocket
  }),
  emit: vi.fn((event: string, data?: any, ack?: Function) => {
    if (event === 'message' && ack) ack({ id: data?.id || 'msg-id' })
    return mockSocket
  }),
  disconnect: vi.fn(),
}))

const bridgeMock = vi.hoisted(() => ({
  chat: vi.fn(async (_sessionId: string) => {
    return { ok: true, run_id: 'bridge-run-id', session_id: _sessionId, status: 'running' }
  }),
  streamOutput: vi.fn(async function* (runId: string) {
    yield {
      ok: true,
      run_id: runId,
      session_id: 'session-1',
      status: 'complete',
      delta: 'done',
      cursor: 1,
      output: 'done',
      done: true,
      events: [],
      event_cursor: 0,
    }
  }),
  contextEstimate: vi.fn(),
  interrupt: vi.fn(),
  destroy: vi.fn(),
}))

const trackerMock = vi.hoisted(() => ({
  startWorkspaceRunCheckpoint: vi.fn(() => {}),
  completeWorkspaceRunCheckpointDraft: vi.fn(() => null),
  discardWorkspaceRunCheckpoint: vi.fn(),
}))

vi.mock('socket.io-client', () => ({ io: vi.fn(() => mockSocket) }))
vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({ getToken: vi.fn(async () => 'test-token') }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({ model: { default: 'model-a', provider: 'provider-a' } })),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({ updateUsage: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/group-chat-agent-runtime', () => ({
  createGroupPrimaryAgentBridge: vi.fn(() => bridgeMock),
  cancelGroupEkkoClarification: vi.fn(() => ({ resolved: false })),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => trackerMock)

describe('group chat room full local access', () => {
  it('skips the non-owner workspace-scoped security policy when the room enables fullLocalAccess', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any) => ({ ok: true, output: 'done' }))
    const clients = new AgentClients()
    clients.setChatRunService({ runAndWait, abortSession: vi.fn(async () => {}) })
    const client = await clients.createAgent({
      agentId: 'agent-full',
      agent: 'codex',
      profile: 'default',
      name: 'FullAccessAgent',
      description: 'Handles owner-granted full access runs',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any)
    const storage = {
      getRoom: vi.fn(() => ({
        name: 'Full Access Room',
        workspace: '/srv/group-chat/full-room',
        ownerAuthUserId: 42,
        fullLocalAccess: 1,
      })),
      getRoomMembers: vi.fn(() => [
        { userId: 'auth:42', name: 'Room Owner' },
        { userId: 'member-guest', name: 'Guest' },
      ]),
      getRoomAgents: vi.fn(() => [{
        id: 'room-agent-full',
        agentId: 'agent-full',
        name: 'FullAccessAgent',
        executorType: 'remote',
        ownerMemberId: 'auth:42',
      }]),
    }
    ;(clients as any).rooms.set('room-full', new Map([[client.agentId, client]]))
    clients.setStorage(storage)

    await clients.processMentions('room-full', {
      messageId: 'message-guest',
      content: '@FullAccessAgent read the G: drive report',
      senderName: 'Guest',
      senderId: 'member-guest',
      timestamp: 1,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-full' }],
    })

    const guestInstructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(guestInstructions).not.toContain('# Security context: request from a non-owner')

    runAndWait.mockClear()
    storage.getRoom.mockReturnValue({
      name: 'Full Access Room',
      workspace: '/srv/group-chat/full-room',
      ownerAuthUserId: 42,
      fullLocalAccess: 0,
    })
    await clients.processMentions('room-full', {
      messageId: 'message-guest-2',
      content: '@FullAccessAgent read the G: drive report',
      senderName: 'Guest',
      senderId: 'member-guest',
      timestamp: 2,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-full' }],
    })

    const scopedInstructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(scopedInstructions).toContain('# Security context: request from a non-owner')
    expect(scopedInstructions).toContain('"authorized_workspace": "/srv/group-chat/full-room"')
    client.disconnect()
  })
})
