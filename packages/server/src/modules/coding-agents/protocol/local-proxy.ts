import { createConnection } from 'node:net'
import { config } from '../../studio/public/config'

export interface CodingAgentProxyTargetOptions {
  useLocalProxy?: boolean
}

const DEFAULT_LOCAL_PROXY_URL = 'http://127.0.0.1:8787'
const LOCAL_PROXY_URL_ENV = 'HERMES_CODING_AGENT_LOCAL_PROXY_URL'
const LOCAL_PROXY_ENABLED_ENV = 'HERMES_CODING_AGENT_LOCAL_PROXY'
const LOCAL_PROXY_PROBE_TIMEOUT_MS = 250

function configuredLocalProxyUrl(): string | null {
  const configured = process.env[LOCAL_PROXY_URL_ENV]?.trim()
  if (!configured) return null
  try {
    const url = new URL(configured)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function normalizedLocalProxyUrl(): string {
  return configuredLocalProxyUrl() || DEFAULT_LOCAL_PROXY_URL
}

function explicitProxyDecision(): boolean | null {
  const value = process.env[LOCAL_PROXY_ENABLED_ENV]?.trim().toLowerCase()
  if (!value) return null
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  return null
}

function localProxyPort(url: string): number | null {
  try {
    const parsed = new URL(url)
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}

export function localCodingAgentProxyUrl(path: string): string {
  return `${normalizedLocalProxyUrl()}${path.startsWith('/') ? path : `/${path}`}`
}

export function studioCodingAgentProxyUrl(path: string): string {
  return `http://127.0.0.1:${config.port}${path.startsWith('/') ? path : `/${path}`}`
}

export async function shouldUseLocalCodingAgentProxy(): Promise<boolean> {
  const explicit = explicitProxyDecision()
  if (explicit !== null) return explicit

  // A fresh install must stay on Studio's route unless the user explicitly
  // configures a local endpoint. Probe only that configured endpoint; do not
  // infer opt-in from an unrelated process listening on the default port.
  const url = configuredLocalProxyUrl()
  if (!url) return false
  const port = localProxyPort(url)
  if (!port) return false
  const host = new URL(url).hostname

  return new Promise(resolve => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (available: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(available)
    }
    socket.setTimeout(LOCAL_PROXY_PROBE_TIMEOUT_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
  })
}

export function proxyTargetBaseUrl(
  path: string,
  options: CodingAgentProxyTargetOptions = {},
): string {
  return options.useLocalProxy ? localCodingAgentProxyUrl(path) : studioCodingAgentProxyUrl(path)
}

export const localCodingAgentProxyTestValues = {
  enabledEnv: LOCAL_PROXY_ENABLED_ENV,
  urlEnv: LOCAL_PROXY_URL_ENV,
  defaultUrl: DEFAULT_LOCAL_PROXY_URL,
}
