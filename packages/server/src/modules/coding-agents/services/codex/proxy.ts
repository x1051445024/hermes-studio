import { Readable } from 'stream'
import type { Context } from 'koa'
import {
  anthropicMessagesUrl as resolveAnthropicMessagesUrl,
  chatCompletionsUrl as resolveChatCompletionsUrl,
  responsesUrl as resolveResponsesUrl,
} from '../../protocol/endpoint-resolver'
import { sseEvent } from '../../protocol/sse'
import { AgentTargetRegistry, type AgentTargetInput, type RegisteredAgentTarget } from '../../protocol/target-registry'
import type { ApiMode } from '../../protocol/types'
import {
  anthropicMessageToResponses,
  openAiChatToResponses,
  responsesToAnthropicMessages,
  responsesToOpenAiChat,
  stripHistoricalResponsesInlineImages,
  truncateResponsesToolOutputs,
} from '../../protocol/adapters/responses'
import {
  anthropicMessagesSseToResponsesEvents,
  normalizeResponsesSseEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from '../../protocol/adapters/responses-stream'
import { agentRunGateway } from '../../protocol/gateway'
import { proxyTargetBaseUrl, type CodingAgentProxyTargetOptions } from '../../protocol/local-proxy'
import { codingAgentRunManager } from '../runtime/run-manager'

export interface CodexProxyTargetInput extends AgentTargetInput {
  profile: string
}

type CodexProxyTarget = RegisteredAgentTarget<CodexProxyTargetInput> & {
  observeUsage?: (event: CanonicalResponsesEvent) => void
}

const targetRegistry = new AgentTargetRegistry<CodexProxyTargetInput>(
  input => [
    input.profile.trim(), input.provider, input.model, input.apiMode, input.baseUrl,
    input.agentSessionId || '', input.chatSessionId || '',
    input.preserveClientIdentity ? 'preserve-client-identity' : '',
  ],
)

function proxyBaseUrl(routeKey: string, options: CodingAgentProxyTargetOptions = {}): string {
  return proxyTargetBaseUrl(`/api/codex-proxy/${routeKey}/v1`, options)
}

export function registerCodexProxyTarget(
  input: CodexProxyTargetInput,
  options: CodingAgentProxyTargetOptions = {},
): { baseUrl: string; token: string; routeKey: string } {
  const target = targetRegistry.register({
    ...input,
    profile: input.profile.trim(),
  })

  return { baseUrl: proxyBaseUrl(target.routeKey, options), token: target.token, routeKey: target.routeKey }
}

export function restoreCodexProxyTarget(
  input: CodexProxyTargetInput,
  token: string,
  options: CodingAgentProxyTargetOptions = {},
): { baseUrl: string; token: string; routeKey: string } {
  const target = targetRegistry.register({
    ...input,
    profile: input.profile.trim(),
  }, { token })

  return { baseUrl: proxyBaseUrl(target.routeKey, options), token: target.token, routeKey: target.routeKey }
}

export function revokeCodexProxyTargets(profile: string, provider: string): number {
  const normalizedProfile = String(profile || '').trim()
  const normalizedProvider = String(provider || '').trim()
  return targetRegistry.removeWhere(target => (
    target.profile === normalizedProfile && target.provider === normalizedProvider
  ))
}

function findTarget(routeKey: string): CodexProxyTarget | null {
  return targetRegistry.find(routeKey)
}

function authToken(ctx: Context): string {
  const apiKey = ctx.get('x-api-key').trim()
  if (apiKey) return apiKey
  const auth = ctx.get('authorization').trim()
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

export function isAuthorizedCodexProxyRequest(ctx: Context): boolean {
  const routeKey = /^\/api\/codex-proxy\/([^/]+)\/v1\/responses$/.exec(ctx.path)?.[1] || ''
  const target = findTarget(routeKey)
  return Boolean(target && authToken(ctx) === target.token)
}

function requireTarget(ctx: Context): CodexProxyTarget | null {
  const target = findTarget(String(ctx.params.key || ''))
  if (!target) {
    ctx.status = 404
    ctx.body = { error: { type: 'not_found_error', message: 'Codex proxy target not found' } }
    return null
  }
  if (authToken(ctx) !== target.token) {
    ctx.status = 401
    ctx.body = { error: { type: 'authentication_error', message: 'Invalid Codex proxy token' } }
    return null
  }
  return { ...target, observeUsage: codingAgentRunManager.createProxyUsageObserver(target.agentSessionId) }
}

function chatCompletionsUrl(target: CodexProxyTarget): string {
  return resolveChatCompletionsUrl(target.baseUrl)
}

function anthropicMessagesUrl(target: CodexProxyTarget): string {
  return resolveAnthropicMessagesUrl(target.baseUrl)
}

export function normalizeGrokResponsesRequest(body: any): any {
  if (!body || typeof body !== 'object') return body
  let changed = false
  const input = Array.isArray(body.input) ? body.input.map((item: any) => {
    if (!item || typeof item !== 'object' || item.role !== 'system') return item
    changed = true
    return { ...item, role: 'developer' }
  }) : body.input
  const normalized = changed ? { ...body, input } : body
  if (!Object.prototype.hasOwnProperty.call(normalized, 'max_output_tokens')) return normalized
  const { max_output_tokens: _maxOutputTokens, ...withoutMaxOutputTokens } = normalized
  return withoutMaxOutputTokens
}

export function normalizeGrokChatCompletionsRequest(body: any): any {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body
  let changed = false
  const messages = body.messages.map((message: any) => {
    if (!message || typeof message !== 'object' || message.role !== 'system') return message
    changed = true
    return { ...message, role: 'developer' }
  })
  return changed ? { ...body, messages } : body
}

// Identity headers a genuine Codex CLI sends. When the provider enables
// `preserve_client_identity`, these are copied from the live inbound request
// (i.e. from the real Codex CLI this Studio session spawned) so upstreams that
// only accept official-looking client traffic see the authentic, current
// version metadata instead of Studio's generic Authorization-only request.
const CODEX_IDENTITY_HEADER_NAMES: Array<[string, string]> = [
  ['originator', 'originator'],
  ['user-agent', 'user-agent'],
  ['openai-beta', 'openai-beta'],
  ['x-openai-client-user-agent', 'x-openai-client-user-agent'],
  ['x-codex-beta-features', 'x-codex-beta-features'],
  ['x-codex-window-id', 'x-codex-window-id'],
  ['x-codex-turn-metadata', 'x-codex-turn-metadata'],
  ['session-id', 'session-id'],
  ['thread-id', 'thread-id'],
  ['x-client-request-id', 'x-client-request-id'],
]

function identityRequestHeaders(target: CodexProxyTarget, ctx: Context): Record<string, string> {
  if (target.preserveClientIdentity !== true) return {}
  // Accept both explicit agentId='codex' and apiMode='codex_responses'
  // (user-configured Codex upstreams). The 0.7.18 baseline compared against a
  // literal 'responses' that no AgentApiMode value ever matches (known TS2367);
  // the native Responses wire mode is 'codex_responses', so compare against it.
  if (target.agentId !== 'codex' && target.apiMode !== 'codex_responses') return {}
  const headers: Record<string, string> = {}
  for (const [incoming, outgoing] of CODEX_IDENTITY_HEADER_NAMES) {
    const value = ctx.get(incoming).trim()
    if (value) {
      // Normalize codex_exec → codex_cli_rs in originator/user-agent. Strict
      // upstreams (new-api "Coding 分组" client review) verify the client id
      // inside the user-agent string and reject codex_exec (Studio's exec
      // transport) as non-official; codex_cli_rs is the official CLI identity.
      // Verified against the real upstream: UA codex_cli_rs → 200, UA codex_exec → 403.
      headers[outgoing] = incoming === 'originator' || incoming === 'user-agent'
        ? value.split('codex_exec').join('codex_cli_rs')
        : value
    }
  }
  return headers
}

function upstreamRequestHeaders(target: CodexProxyTarget, ctx?: Context): Record<string, string> {
  const configured = target.extraHeaders
  const explicit = configured && typeof configured === 'object' ? { ...configured } : {}
  const identity = ctx ? identityRequestHeaders(target, ctx) : {}
  return { ...identity, ...explicit }
}

function nativeResponsesBody(target: CodexProxyTarget, body: any, stream?: boolean): any {
  const normalized = target.agentId === 'grok' ? normalizeGrokResponsesRequest(body) : body
  return truncateResponsesToolOutputs({
    ...normalized,
    model: target.model,
    ...(stream === undefined ? {} : { stream }),
  })
}

async function callOpenAiChat(target: CodexProxyTarget, body: any, ctx: Context): Promise<any> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const adapted = responsesToOpenAiChat(body, target)
  const chatBody = target.agentId === 'grok' ? normalizeGrokChatCompletionsRequest(adapted) : adapted
  return agentRunGateway.completeJson({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    proxyUrl: target.proxyUrl,
    headers: upstreamRequestHeaders(target, ctx),
    body: chatBody,
  })
}

async function callAnthropicMessages(target: CodexProxyTarget, body: any, ctx: Context): Promise<any> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const anthropicBody = responsesToAnthropicMessages(body, target)
  return agentRunGateway.completeJson({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    proxyUrl: target.proxyUrl,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      ...upstreamRequestHeaders(target, ctx),
    },
    body: anthropicBody,
  })
}

async function callOpenAiResponses(target: CodexProxyTarget, body: any, ctx: Context): Promise<any> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const responsesBody = nativeResponsesBody(target, body)
  return agentRunGateway.completeJson({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    proxyUrl: target.proxyUrl,
    headers: upstreamRequestHeaders(target, ctx),
    body: responsesBody,
  })
}

function responsesEventStream(events: AsyncIterable<CanonicalResponsesEvent>): Readable {
  async function* generate() {
    for await (const event of events) {
      yield sseEvent(event.type, event.data)
    }
  }
  return Readable.from(generate())
}

function responseEventForCodexClient(target: CodexProxyTarget, event: CanonicalResponsesEvent): CanonicalResponsesEvent {
  if (event.type !== 'response.completed') return event
  const response = (event.data as any).response
  if (target.agentId === 'opencode') {
    // OpenCode's OpenAI Responses provider validates `response.completed`
    // usage before it accepts the terminal event. Chat-compatible upstreams
    // are allowed to omit usage, so keep real usage when available and emit
    // the minimum valid shape otherwise. Without this terminal frame OpenCode
    // reports an `unknown` finish reason and starts another agent step forever.
    return {
      ...event,
      data: {
        ...event.data,
        response: {
          ...response,
          usage: response?.usage || {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
        },
      },
    }
  }
  if (target.apiMode === 'codex_responses') return event
  if (!response?.usage) return event
  const { usage: _usage, ...responseWithoutUsage } = response
  return {
    ...event,
    data: {
      ...event.data,
      response: responseWithoutUsage,
    },
  }
}

function observableResponsesEvents(target: CodexProxyTarget, events: AsyncIterable<CanonicalResponsesEvent>): AsyncIterable<CanonicalResponsesEvent> {
async function* observe() {
    for await (const event of normalizeResponsesSseEvents(events)) {
      target.observeUsage?.(event)
      const clientEvent = responseEventForCodexClient(target, event)
      // Grok, OpenCode and DSH report the same model activity through their native
      // stdout streams. The proxy remains responsible for transport and usage
      // accounting, but must not become a second chat lifecycle source.
      if (target.agentId !== 'grok' && target.agentId !== 'opencode' && target.agentId !== 'dsh') {
        codingAgentRunManager.handleResponseEvent(target.agentSessionId, clientEvent)
      }
      yield clientEvent
    }
  }
  return observe()
}

async function openAiChatToResponsesSseStream(target: CodexProxyTarget, body: any, ctx: Context): Promise<Readable> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const adapted = responsesToOpenAiChat(body, target, true)
  const chatBody = target.agentId === 'grok' ? normalizeGrokChatCompletionsRequest(adapted) : adapted
  const stream = await agentRunGateway.streamBytes({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    proxyUrl: target.proxyUrl,
    headers: upstreamRequestHeaders(target, ctx),
    body: chatBody,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiChatSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
  })))
}

async function anthropicMessagesToResponsesSseStream(target: CodexProxyTarget, body: any, ctx: Context): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const anthropicBody = responsesToAnthropicMessages(body, target, true)
  const stream = await agentRunGateway.streamBytes({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    proxyUrl: target.proxyUrl,
    headers: {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      ...upstreamRequestHeaders(target, ctx),
    },
    body: anthropicBody,
  })
  return responsesEventStream(observableResponsesEvents(target, anthropicMessagesSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
  })))
}

async function openAiResponsesSseStream(target: CodexProxyTarget, body: any, ctx: Context): Promise<Readable> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const responsesBody = nativeResponsesBody(target, body, true)
  const stream = await agentRunGateway.streamBytes({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    sessionId: target.chatSessionId || target.agentSessionId || target.routeKey,
    provider: target.provider,
    proxyUrl: target.proxyUrl,
    headers: upstreamRequestHeaders(target, ctx),
    body: responsesBody,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiResponsesSseToResponsesEvents(stream)))
}

export async function codexProxyResponses(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  try {
    // Sanitize once before API-mode dispatch so native Responses, Chat
    // Completions, and Anthropic adapters all receive the same bounded history.
    const sanitizedBody = stripHistoricalResponsesInlineImages(ctx.request.body || {})
    const requestBody = target.agentId === 'grok'
      ? normalizeGrokResponsesRequest(sanitizedBody)
      : sanitizedBody
    if ((requestBody as any).stream === true) {
      const stream = target.apiMode === 'anthropic_messages'
        ? await anthropicMessagesToResponsesSseStream(target, requestBody, ctx)
        : target.apiMode === 'codex_responses'
          ? await openAiResponsesSseStream(target, requestBody, ctx)
          : await openAiChatToResponsesSseStream(target, requestBody, ctx)
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = stream
    } else {
      ctx.body = target.apiMode === 'anthropic_messages'
        ? anthropicMessageToResponses(await callAnthropicMessages(target, requestBody, ctx), target)
        : target.apiMode === 'codex_responses'
          ? await callOpenAiResponses(target, requestBody, ctx)
          : openAiChatToResponses(await callOpenAiChat(target, requestBody, ctx), target)
    }
  } catch (err: any) {
    ctx.status = err.status || 502
    ctx.body = {
      error: {
        type: 'api_error',
        message: err?.message || 'Codex proxy request failed',
        provider_error: err?.providerError,
      },
    }
  }
}

export async function codexProxyModels(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  ctx.body = {
    object: 'list',
    data: [{
      id: target.model,
      object: 'model',
      created: 0,
      owned_by: target.provider,
    }],
  }
}
