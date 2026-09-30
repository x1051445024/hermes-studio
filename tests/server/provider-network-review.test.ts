import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRunGateway } from '../../packages/server/src/modules/coding-agents/protocol/gateway'
import { proxyFetch } from '../../packages/server/src/modules/coding-agents/protocol/proxy-fetch'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(cleanup.splice(0).map(close => close()))
})

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler)
  const sockets = new Set<net.Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { server, port: (server.address() as net.AddressInfo).port }
}

async function tunnelTo(port: number) {
  let tunnels = 0
  let tunneledBytes = 0
  const proxy = await serve((_req, res) => res.writeHead(405).end())
  proxy.server.on('connect', (_req, socket, head) => {
    tunnels += 1
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.on('data', chunk => { tunneledBytes += chunk.length })
      socket.pipe(upstream).pipe(socket)
    })
    socket.on('close', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
  })
  return {
    url: `http://127.0.0.1:${proxy.port}`,
    tunnels: () => tunnels,
    bytes: () => tunneledBytes,
  }
}

describe('provider network review regressions', () => {
  it('sends HTTP/1 request bytes through CONNECT rather than opening a direct connection', async () => {
    const upstream = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    const proxy = await tunnelTo(upstream.port)
    const response = await proxyFetch(`http://127.0.0.1:${upstream.port}/v1/responses`, {
      method: 'POST', headers: {}, body: '{}',
    }, proxy.url)
    expect(await response.json()).toEqual({ ok: true })
    expect(proxy.tunnels()).toBe(1)
    expect(proxy.bytes()).toBeGreaterThanOrEqual(0)
  })

  it('decodes compressed upstream responses like fetch', async () => {
    const upstream = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(gzipSync('{"ok":true}'))
    })
    const proxy = await tunnelTo(upstream.port)
    const response = await proxyFetch(`http://127.0.0.1:${upstream.port}/v1/responses`, {
      method: 'POST', headers: {}, body: '{}',
    }, proxy.url)
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('forwards the abort signal to the underlying fetch call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetchMock)
    const signal = AbortSignal.abort()
    await new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses',
      apiKey: 'test-key',
      body: {},
      signal,
    }).catch(() => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal)
  })

  it('retries connect-looking failures within the fixed budget and then surfaces the error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('response failed after ECONNREFUSED in upstream log'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses',
      apiKey: 'test-key',
      body: {},
    })).rejects.toThrow('response failed')
    // CONNECT_RETRY_ATTEMPTS = 4 (patch 0006 connect retry budget)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
