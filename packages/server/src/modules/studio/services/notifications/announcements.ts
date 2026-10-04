const ANNOUNCEMENTS_URL = 'https://raw.githubusercontent.com/x1051445024/hermes-studio/main/docs/studio/announcements.json'

export async function fetchStudioAnnouncements(localeInput: unknown): Promise<unknown> {
  const locale = /^zh(?:[-_]|$)/i.test(String(localeInput || 'en')) ? 'zh-CN' : 'en'
  const url = new URL(ANNOUNCEMENTS_URL)
  url.searchParams.set('locale', locale)
  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('announcement_fetch_failed')
  const data = await response.json() as { ok?: boolean; platform?: string; list?: unknown }
  if (!data || data.ok !== true || data.platform !== 'desktop' || !Array.isArray(data.list)) {
    throw new Error('invalid_announcement_response')
  }
  return data
}
