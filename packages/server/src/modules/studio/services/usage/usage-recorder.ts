import { logger } from '../../public/logging'
import { saveContextUsage, updateUsage, fillMissingUsageCost } from '../../repositories/usage-store'
import { getUsagePricing } from '../../repositories/usage-pricing-store'
import { getModelCatalogSnapshot, refreshModelCatalog } from '../../public/model-catalog'
import { normalizeUsageCost, estimateUsageCost, type UsageCost } from './usage-cost'
import { estimateCatalogUsageCost } from './catalog-pricing'

export interface NormalizedTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface RecordSessionUsageInput {
  sessionId: string
  runId?: string | null
  source: 'hermes' | 'coding_agent' | 'ekko_agent'
  agent: 'hermes' | 'claude_code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor' | 'ekko_agent'
  profile?: string | null
  model?: string | null
  provider?: string | null
  usageScope?: 'model_call' | 'run'
  contextHistoryRevision?: number
  contextNativeSessionId?: string
  purpose?: string
  apiCalls?: number
  usage?: unknown
  fallbackUsage?: Partial<NormalizedTokenUsage>
  isEstimated?: boolean
  cost?: UsageCost
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined
}

function finiteToken(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value == null || (typeof value === 'string' && !value.trim())) continue
    const token = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(token) && token >= 0) return Math.floor(token)
  }
  return undefined
}

function usagePayload(value: unknown): Record<string, any> {
  const root = asRecord(value) || {}
  const response = asRecord(root.response)
  const result = asRecord(root.result)
  return asRecord(root.usage)
    || asRecord(response?.usage)
    || asRecord(result?.usage)
    || root
}

function positiveToken(value: unknown): number {
  const token = Number(value || 0)
  return Number.isFinite(token) && token > 0 ? Math.floor(token) : 0
}

/**
 * Context occupied by a single model call.
 *
 * Providers report the prompt they actually received in three buckets: the
 * fresh input tokens plus the prefix served from (cache read) or written to
 * (cache write) their prompt cache, and `normalizeTokenUsage` keeps them apart
 * so cost accounting can price them differently. Reading input+output alone
 * therefore reports only the uncached slice — on a warm coding-agent session
 * that is 1-3% of the real prompt, which is why the context bar sat near zero
 * and never warned before a turn overran the model's window.
 *
 * Reasoning tokens are deliberately left out: providers already count them
 * inside output tokens, so adding them would double-count.
 */
export function contextTokensFromModelCall(usage: {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: positiveToken(usage.inputTokens)
      + positiveToken(usage.cacheReadTokens)
      + positiveToken(usage.cacheWriteTokens),
    outputTokens: positiveToken(usage.outputTokens),
  }
}

export function recordSessionContextUsage(sessionId: string, contextTokens: number): void {
  try {
    saveContextUsage(sessionId, contextTokens)
  } catch (err) {
    logger.warn({ err, sessionId }, '[usage-recorder] failed to persist context measurement')
  }
}

export function normalizeTokenUsage(
  value: unknown,
  fallback: Partial<NormalizedTokenUsage> = {},
  options: { inputIncludesCache?: boolean } = {},
): NormalizedTokenUsage & { isEstimated: boolean } {
  const usage = usagePayload(value)
  const inputDetails = asRecord(usage.input_tokens_details)
    || asRecord(usage.inputTokensDetails)
    || asRecord(usage.prompt_tokens_details)
    || asRecord(usage.promptTokensDetails)
    || {}
  const outputDetails = asRecord(usage.output_tokens_details)
    || asRecord(usage.outputTokensDetails)
    || asRecord(usage.completion_tokens_details)
    || asRecord(usage.completionTokensDetails)
    || {}

  const rawInput = finiteToken(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens)
  const rawOutput = finiteToken(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens)
  const rawCacheRead = finiteToken(
    usage.cache_read_tokens,
    usage.cacheReadTokens,
    usage.cache_read_input_tokens,
    usage.cached_input_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cache_hit_tokens,
    inputDetails.cached_tokens,
    inputDetails.cachedTokens,
  )
  const rawCacheWrite = finiteToken(
    usage.cache_write_tokens,
    usage.cacheWriteTokens,
    usage.cache_creation_input_tokens,
  )
  const rawReasoning = finiteToken(
    usage.reasoning_tokens,
    usage.reasoningTokens,
    outputDetails.reasoning_tokens,
    outputDetails.reasoningTokens,
  )

  const inputTokens = rawInput ?? finiteToken(fallback.inputTokens) ?? 0
  const cacheReadTokens = rawCacheRead ?? finiteToken(fallback.cacheReadTokens) ?? 0
  const cacheWriteTokens = rawCacheWrite ?? finiteToken(fallback.cacheWriteTokens) ?? 0

  return {
    inputTokens: options.inputIncludesCache
      ? Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
      : inputTokens,
    outputTokens: rawOutput ?? finiteToken(fallback.outputTokens) ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: rawReasoning ?? finiteToken(fallback.reasoningTokens) ?? 0,
    isEstimated: rawInput == null || rawOutput == null,
  }
}

export function recordSessionUsage(input: RecordSessionUsageInput): NormalizedTokenUsage {
  const usage = normalizeTokenUsage(input.usage, input.fallbackUsage)
  try {
    let cost = normalizeUsageCost(input.cost) || normalizeUsageCost(input.usage)
    let hasManualPricing = false
    if (!cost && input.model && input.provider) {
      try {
        const pricing = getUsagePricing(input.profile || 'default')
          .find(row => row.provider === input.provider && row.model === input.model)
        hasManualPricing = !!pricing
        cost = estimateUsageCost(usage, pricing)
        if (cost && pricing) cost.costPricing = { source: 'manual', rates: pricing }
      } catch (err) {
        logger.warn({ err }, '[usage-recorder] failed to read model pricing')
      }
    }
    const catalog = !cost && !hasManualPricing ? getModelCatalogSnapshot() : undefined
    if (!cost && !hasManualPricing && input.provider && input.model) {
      cost = estimateCatalogUsageCost(catalog, input.provider, input.model, usage, input.usageScope, input.apiCalls)
    }
    const row = updateUsage(input.sessionId, {
      runId: input.runId || '',
      source: input.source,
      agent: input.agent,
      usageScope: input.usageScope,
      contextHistoryRevision: input.contextHistoryRevision,
      contextNativeSessionId: input.contextNativeSessionId,
      purpose: input.purpose,
      apiCalls: input.apiCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      model: input.model || '',
      provider: input.provider || '',
      profile: input.profile || 'default',
      isEstimated: input.isEstimated ?? usage.isEstimated,
      ...(cost || {}),
    })
    // Cold start: persist tokens immediately, then fill this new row after the shared download.
    // Replays return no inserted row, so a later catalog never reprices historical usage.
    if (row && !cost && !hasManualPricing && !catalog && input.provider && input.model) {
      const provider = input.provider
      const model = input.model
      void refreshModelCatalog().then(snapshot => {
        const estimate = estimateCatalogUsageCost(snapshot, provider, model, usage, input.usageScope, input.apiCalls)
        if (estimate) fillMissingUsageCost(row, estimate)
      }).catch(err => logger.warn({ err }, '[usage-recorder] failed to fill catalog cost'))
    }
  } catch (err) {
    logger.warn({
      err,
      sessionId: input.sessionId,
      runId: input.runId,
      source: input.source,
    }, '[usage-recorder] failed to persist session usage')
  }
  return usage
}
