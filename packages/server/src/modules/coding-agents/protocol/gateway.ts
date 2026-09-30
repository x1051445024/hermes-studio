import { openCodeSessionHeaders } from '../../studio/public/opencode-session'
import { openRouterAttributionHeaders } from '../../studio/public/openrouter-attribution'
import { proxyFetch } from './proxy-fetch'

/** A provider request issued by a Coding Agent proxy. */
export interface AgentGatewayRequest {
  url: string
  apiKey: string
  sessionId?: string
  provider?: string
  body: unknown
  headers?: Record<string, string>
  /** Local customization: egress through this HTTP(S) proxy instead of connecting directly. */
  proxyUrl?: string
  signal?: AbortSignal
}

export class ProviderApiError extends Error {
  status: number
  providerError: unknown

  constructor(status: number, providerError: unknown, message: string) {
    super(message)
    this.name = 'ProviderApiError'
    this.status = status
    this.providerError = providerError
  }
}

/**
 * Local customization: retry a failed connection setup.
 *
 * This machine's path to some providers rejects the TLS handshake intermittently
 * (measured: 0% direct, 0–25% through a local proxy). Every such failure happens
 * before a single request byte is written, so the provider never saw the request
 * and a retry cannot duplicate a generation or double-bill. Only connect-phase
 * failures are retried; once a response has started, errors propagate untouched.
 */
const CONNECT_RETRY_ATTEMPTS = 4
const CONNECT_RETRY_BASE_DELAY_MS = 150

const RETRIABLE_CONNECT_CODES = new Set([
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_TLSV1_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_TLSV13_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
])

function connectErrorCodes(error: unknown): string[] {
  const codes: string[] = []
  let current: any = error
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === 'string') codes.push(current.code)
    current = current.cause
  }
  return codes
}

/** True only for failures raised before the request body was transmitted. */
export function isRetriableConnectFailure(error: unknown): boolean {
  if ((error as { retriable?: boolean } | null)?.retriable === true) return true
  if (connectErrorCodes(error).some(code => RETRIABLE_CONNECT_CODES.has(code))) return true
  const message = error instanceof Error ? error.message : String(error)
  return /handshake failure|handshake with .* timed out|Timed out connecting to proxy|Timed out waiting for the proxy CONNECT response|ECONNREFUSED/i.test(message)
}

function delayConnectRetry(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

export class AgentRunGateway {
  async completeJson<T = any>(request: AgentGatewayRequest): Promise<T> {
    const res = await this.post(request)
    const data = await readProviderJson(res)
    if (!res.ok) throwProviderError(res, data)
    return data as T
  }

  async streamBytes(request: AgentGatewayRequest): Promise<AsyncIterable<Uint8Array>> {
    const res = await this.post(request)
    if (!res.ok) {
      const data = await readProviderJson(res)
      throwProviderError(res, data)
    }
    const contentType = res.headers.get('content-type') || ''
    if (contentType && !/text\/event-stream|application\/x-ndjson|octet-stream/i.test(contentType)) {
      const data = await readProviderJson(res)
      throwProviderError(res, data)
    }
    if (!res.body) throw new Error('Provider returned an empty stream')
    return res.body as any
  }

  private async post(request: AgentGatewayRequest): Promise<Response> {
    let lastError: unknown
    for (let attempt = 1; attempt <= CONNECT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.postOnce(request)
      } catch (error) {
        lastError = error
        if (attempt >= CONNECT_RETRY_ATTEMPTS || !isRetriableConnectFailure(error)) throw error
        await delayConnectRetry(CONNECT_RETRY_BASE_DELAY_MS * attempt)
      }
    }
    throw lastError
  }

  private postOnce(request: AgentGatewayRequest): Promise<Response> {
    const headers = {
      ...openCodeSessionHeaders(request.url, request.sessionId, request.provider),
      ...openRouterAttributionHeaders(request.url, request.provider),
      ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
      'Content-Type': 'application/json',
      ...request.headers,
    }
    const proxyUrl = typeof request.proxyUrl === 'string' ? request.proxyUrl.trim() : ''
    // Local customization: providers configured with a proxy URL egress through
    // it (node's fetch/undici ignores the Windows system proxy entirely).
    if (proxyUrl) {
      return proxyFetch(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
        signal: request.signal,
      }, proxyUrl)
    }
    return fetch(request.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request.body),
      signal: request.signal,
    })
  }
}

export async function readProviderJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text || `Provider returned HTTP ${res.status}` } }
  }
}

export function throwProviderError(res: Response, data: any): never {
  throw new ProviderApiError(
    res.status,
    data,
    data?.error?.message || `Provider returned HTTP ${res.status}`,
  )
}

export const agentRunGateway = new AgentRunGateway()
