/**
 * Local customization: per-provider HTTP(S) proxy support for coding-agent
 * upstream requests.
 *
 * Why this exists: Studio's server runtime is Electron/Node, and its global
 * `fetch` (undici) never consults the Windows system proxy. Node does not expose
 * undici's ProxyAgent for injection either, so a provider that is only reachable
 * through a local proxy (e.g. 127.0.0.1:6785) fails with `fetch failed` — which
 * surfaces to the agent CLI as `502 Bad Gateway`.
 *
 * Mechanism (no new dependencies on purpose, so this survives Studio upgrades as
 * a plain source rebuild):
 *   1. node:net connects to the proxy and performs the HTTP CONNECT handshake.
 *   2. node:tls wraps the tunnelled socket for https targets and negotiates ALPN.
 *   3. node:http / node:https / node:http2 drive the real request+response over
 *      that socket via `createConnection`, so we keep Node's own HTTP parsing.
 *   4. The result is wrapped back into a real `Response`, so callers keep using
 *      res.ok / res.status / res.headers / res.text() / res.body unchanged.
 *
 * HTTP/2 is honoured when the edge negotiates it: some Cloudflare-fronted
 * endpoints reject HTTP/1.1 connections outright, and a tunnelled socket whose
 * ALPN says h2 must speak h2 or the request dies with EPROTO.
 */
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib'

export interface ProxyEndpoint {
  host: string
  port: number
  /** https:// proxies are tunnelled through TLS to the proxy itself. */
  secure: boolean
  authorization?: string
}

export interface ProxyFetchInit {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

const CONNECT_TIMEOUT_MS = 15_000
const TLS_TIMEOUT_MS = 20_000
const RESPONSE_TIMEOUT_MS = 120_000

/** Accepts `http://host:port`, `https://host:port`, `host:port` and user:pass@ forms. */
export function parseProxyUrl(raw: unknown): ProxyEndpoint {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) throw new Error('Proxy URL must not be empty')
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    throw new Error(`Invalid proxy URL: ${trimmed}`)
  }
  const protocol = parsed.protocol.replace(':', '').toLowerCase()
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`Unsupported proxy protocol "${protocol}://" (only http:// and https:// proxies are supported)`)
  }
  const port = parsed.port ? Number(parsed.port) : protocol === 'https' ? 443 : 80
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid proxy port in ${trimmed}`)
  }
  const endpoint: ProxyEndpoint = { host: parsed.hostname, port, secure: protocol === 'https' }
  if (parsed.username || parsed.password) {
    const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
    endpoint.authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`
  }
  return endpoint
}

/**
 * Marks a failure that happened **before any request bytes were sent** (proxy TCP
 * connect, CONNECT handshake, TLS handshake inside the tunnel). The gateway may
 * safely retry such a failure: the provider never saw the request, so there is no
 * risk of duplicate generation or double billing. A proxy that explicitly refuses
 * CONNECT (non-200) is NOT marked retriable — that is a configuration problem.
 */
export function retriableConnectError(message: string, cause?: unknown): Error & { retriable: true } {
  const error = (cause === undefined ? new Error(message) : new Error(message, { cause })) as Error & { retriable: true }
  error.retriable = true
  return error
}

/** Opens a socket to the proxy and completes the CONNECT handshake to host:port. */
function openProxySocket(
  endpoint: ProxyEndpoint,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = endpoint.secure
      ? tls.connect({ host: endpoint.host, port: endpoint.port, servername: endpoint.host, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host: endpoint.host, port: endpoint.port })

    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      socket.setTimeout(0)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }
    const onAbort = () => fail(new Error('Proxy request aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      fail(new Error('Proxy request aborted'))
      return
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(
      retriableConnectError(`Timed out connecting to proxy ${endpoint.host}:${endpoint.port}`),
    ))
    socket.once('error', (error: Error) => fail(retriableConnectError(
      `Could not connect to proxy ${endpoint.host}:${endpoint.port} (${(error as NodeJS.ErrnoException).code || error.message})`,
      error,
    )))

    const onReady = () => {
      socket.write([
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        ...(endpoint.authorization ? [`Proxy-Authorization: ${endpoint.authorization}`] : []),
        'Proxy-Connection: Keep-Alive',
        '', '',
      ].join('\r\n'))

      let buffer = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        socket.off('data', onData)
        const head = buffer.subarray(0, headerEnd).toString('latin1')
        const status = Number(head.split(' ')[1])
        const rest = buffer.subarray(headerEnd + 4)
        if (rest.length) socket.unshift(rest)
        if (status === 200) {
          cleanup()
          settled = true
          resolve(socket)
          return
        }
        fail(new Error(
          `Proxy ${endpoint.host}:${endpoint.port} refused CONNECT to ${host}:${port} (HTTP ${status || '?'})`,
        ))
      }
      socket.on('data', onData)
      socket.setTimeout(CONNECT_TIMEOUT_MS * 2, () => fail(
        retriableConnectError(`Timed out waiting for the proxy CONNECT response from ${endpoint.host}:${endpoint.port}`),
      ))
    }

    // A peer that drops the connection without an error event must fail fast
    // instead of waiting out the CONNECT timeout.
    socket.once('close', () => fail(retriableConnectError(
      `Proxy ${endpoint.host}:${endpoint.port} closed the connection before the CONNECT response`,
    )))

    if (endpoint.secure) socket.once('secureConnect', onReady)
    else socket.once('connect', onReady)
  })
}

interface TargetSocket {
  socket: net.Socket | tls.TLSSocket
  alpn: string
  secure: boolean
}

async function openTargetSocket(
  host: string,
  port: number,
  secure: boolean,
  endpoint: ProxyEndpoint,
  signal?: AbortSignal,
): Promise<TargetSocket> {
  const raw = await openProxySocket(endpoint, host, port, signal)
  if (!secure) {
    raw.setTimeout(0)
    return { socket: raw, alpn: '', secure: false }
  }
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const secureSocket = tls.connect({ socket: raw, servername: host, ALPNProtocols: ['h2', 'http/1.1'] })
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      secureSocket.destroy()
      reject(error)
    }
    signal?.addEventListener('abort', () => fail(new Error('Proxy request aborted')), { once: true })
    secureSocket.once('secureConnect', () => {
      if (settled) return
      settled = true
      secureSocket.setTimeout(0)
      resolve(secureSocket)
    })
    secureSocket.once('error', (error: Error) => fail(retriableConnectError(
      `TLS handshake with ${host} through the proxy failed (${(error as NodeJS.ErrnoException).code || error.message})`,
      error,
    )))
    secureSocket.setTimeout(TLS_TIMEOUT_MS, () => fail(
      retriableConnectError(`TLS handshake with ${host} through the proxy timed out`),
    ))
    secureSocket.once('close', () => fail(retriableConnectError(
      `TLS handshake with ${host} through the proxy was closed before completing`,
    )))
  })
  return { socket, alpn: socket.alpnProtocol || '', secure: true }
}

function toResponse(
  status: number,
  statusText: string,
  rawHeaders: http.IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  stream: Readable,
): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value === undefined || name.startsWith(':')) continue
    if (Array.isArray(value)) for (const item of value) headers.append(name, String(item))
    else headers.append(name, String(value))
  }
  const safeStatus = status >= 200 && status <= 599 ? status : 502
  // undici's fetch decompresses gzip/deflate/br transparently and strips the
  // content-encoding/content-length headers; node:http hands us the raw bytes.
  // Mirror that so callers can keep using res.text()/res.body() unchanged.
  const encoding = String(headers.get('content-encoding') || '').toLowerCase().trim()
  const decodedStream = decodeContent(stream, encoding)
  if (decodedStream) {
    headers.delete('content-encoding')
    headers.delete('content-length')
  }
  return new Response(
    Readable.toWeb(decodedStream || stream) as unknown as ReadableStream,
    { status: safeStatus, statusText, headers },
  )
}

function decodeContent(stream: Readable, encoding: string): Readable | null {
  const decompressor = encoding === 'gzip' || encoding === 'x-gzip'
    ? createGunzip()
    : encoding === 'deflate'
      ? createInflate()
      : encoding === 'br'
        ? createBrotliDecompress()
        : null
  if (!decompressor) return null
  // A malformed compressed body must surface as an error (like fetch), not as
  // a silent partial response; route decompression failures onto the stream.
  decompressor.on('error', (err: Error) => stream.destroy(err))
  return stream.pipe(decompressor)
}

function requestHttp1(
  target: TargetSocket,
  host: string,
  port: number,
  path: string,
  init: ProxyFetchInit,
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = target.secure ? https : http
    const req = client.request({
      host,
      port,
      path,
      method: init.method,
      headers,
      agent: false,
      createConnection: () => target.socket as net.Socket,
      signal: init.signal,
    }, (res) => {
      res.setTimeout(RESPONSE_TIMEOUT_MS, () => res.destroy(new Error('Upstream response timed out')))
      resolve(toResponse(res.statusCode || 0, res.statusMessage || '', res.headers, res))
    })
    req.once('error', reject)
    req.end(body)
  })
}

function requestHttp2(
  target: TargetSocket,
  host: string,
  port: number,
  path: string,
  init: ProxyFetchInit,
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}:${port}`, {
      createConnection: () => target.socket as net.Socket,
    })
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      client.destroy()
      reject(error)
    }
    client.once('error', fail)
    client.once('close', () => {
      if (!settled) fail(new Error('HTTP/2 session closed before a response arrived'))
    })

    const outgoing: Record<string, string> = {
      ':method': init.method,
      ':path': path,
      ':authority': host,
    }
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (lower === 'host' || lower === 'connection' || name.startsWith(':')) continue
      outgoing[lower] = value
    }

    const stream = client.request(outgoing)
    stream.once('response', (resHeaders) => {
      settled = true
      const status = Number(resHeaders[':status'] || 0)
      stream.setTimeout(RESPONSE_TIMEOUT_MS, () => stream.destroy(new Error('Upstream response timed out')))
      stream.once('close', () => client.close())
      resolve(toResponse(
        status,
        '',
        resHeaders as Record<string, string | string[] | undefined>,
        stream as unknown as Readable,
      ))
    })
    stream.once('error', fail)
    // http2 treats an empty-string chunk as "already ended" and throws
    // ERR_STREAM_WRITE_AFTER_END, so only pass a payload when there is one.
    if (body) stream.end(body)
    else stream.end()
  })
}

/**
 * `fetch` for providers that must egress through an explicit HTTP(S) proxy.
 * Mirrors the subset of RequestInit that the coding-agent gateway uses.
 */
export async function proxyFetch(url: string, init: ProxyFetchInit, proxyUrl: string): Promise<Response> {
  const endpoint = parseProxyUrl(proxyUrl)
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new Error(`Invalid upstream URL: ${url}`)
  }
  const secure = target.protocol === 'https:'
  if (!secure && target.protocol !== 'http:') {
    throw new Error(`Unsupported upstream protocol "${target.protocol}" for proxied requests`)
  }
  const port = target.port ? Number(target.port) : secure ? 443 : 80
  const path = `${target.pathname}${target.search}`

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(init.headers || {})) {
    if (name.toLowerCase() === 'host') continue
    headers[name] = value
  }
  const body = init.body ?? ''
  if (body) headers['content-length'] = String(Buffer.byteLength(body))

  const socket = await openTargetSocket(target.hostname, port, secure, endpoint, init.signal)
  if (socket.alpn === 'h2') return requestHttp2(socket, target.hostname, port, path, init, headers, body)
  return requestHttp1(socket, target.hostname, port, path, init, headers, body)
}
