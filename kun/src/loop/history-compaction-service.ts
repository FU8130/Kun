import type { ImmutablePrefix } from '../cache/immutable-prefix.js'
import type { TurnItem } from '../contracts/items.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { ModelClient, ModelToolSpec } from '../ports/model-client.js'
import type { SessionStore } from '../ports/session-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { rewriteItemHistoryWithRetry } from '../services/history-commit-coordinator.js'
import type { UsageService } from '../services/usage-service.js'
import {
  hasHooksForPhase,
  runObserverHooks,
  type ResolvedHook
} from '../hooks/hook-engine.js'
import {
  effectiveHistoryAfterLatestCompaction,
  insertCompactionIntoVisibleHistory
} from './compaction-history.js'
import { resolveCompactionModel, summarizeCompactionWithModel } from './compaction-summary.js'
import { ContextCompactor } from './context-compactor.js'
import { repairModelHistoryItems } from '../domain/model-history-repair.js'
import { recordLifecycleHookWarnings } from './turn-lifecycle-hooks.js'
import type { ContextCompactionConfig } from './model-context-profile.js'
import { estimateRequestOverheadTokens } from './model-request-estimator.js'
import type { LoopTelemetry } from './loop-telemetry.js'

export type HistoryCompactionServiceDeps = {
  sessionStore: SessionStore
  compactor: ContextCompactor
  prefix: ImmutablePrefix
  model: ModelClient
  usage: UsageService
  events: RuntimeEventRecorder
  ids: IdGenerator
  telemetry: Pick<LoopTelemetry, 'hydratePromptPressureIfCold' | 'consumePromptPressure'>
  /** Read live runtime config so hot-apply affects future compactions. */
  getContextCompaction?: () => ContextCompactionConfig | undefined
  /** Read live runtime hooks so hot-apply affects future compactions. */
  getHooks?: () => readonly ResolvedHook[] | undefined
  clearReadTracker?: (threadId?: string) => void
  rewriteThreadItemsFromSession: (threadId: string) => Promise<void>
}

/**
 * Applies automatic history compaction through the revision-aware coordinator.
 * The service never retries model/tool work after a lost history CAS: only the
 * pure heuristic transform is rebuilt from the latest persisted snapshot.
 */
export class HistoryCompactionService {
  constructor(private readonly deps: HistoryCompactionServiceDeps) {}

  async compactIfNeeded(input: {
    items: TurnItem[]
    model: string
    signal: AbortSignal
    threadId: string
    turnId: string
    toolSpecs?: readonly ModelToolSpec[]
  }): Promise<TurnItem[]> {
    await this.deps.telemetry.hydratePromptPressureIfCold(input.threadId, input.model)
    const pressure = this.deps.telemetry.consumePromptPressure(input.threadId, input.model)
    const thresholdModel = pressure?.model || input.model
    const overheadTokens = estimateRequestOverheadTokens({
      systemPrompt: this.deps.prefix.systemPrompt,
      prefix: this.deps.prefix.fewShots,
      tools: input.toolSpecs
    })
    const plan = this.deps.compactor.planCompaction(input.items, {
      model: thresholdModel,
      promptTokens: pressure?.promptTokens,
      overheadTokens
    })
    if (!plan) return input.items
    const hooks = this.deps.getHooks?.()
    if (hasHooksForPhase(hooks, 'PreCompact')) {
      const observed = await runObserverHooks(hooks, {
        phase: 'PreCompact',
        threadId: input.threadId,
        turnId: input.turnId,
        reason: String(plan.reason),
        mode: String(plan.mode)
      })
      await recordLifecycleHookWarnings(
        this.deps.events,
        { threadId: input.threadId, turnId: input.turnId },
        observed.warnings
      )
    }
    const summaryItemId = this.deps.ids.next('compaction')
    const committed = await rewriteItemHistoryWithRetry<{
      history: TurnItem[]
      result: ReturnType<ContextCompactor['compact']> | null
    }>({
      sessionStore: this.deps.sessionStore,
      threadId: input.threadId,
      maxAttempts: 2,
      build: async (snapshot, attempt) => {
        const currentItems = repairModelHistoryItems(
          effectiveHistoryAfterLatestCompaction(snapshot.items)
        )
        const currentPlan = attempt === 1
          ? plan
          : this.deps.compactor.planCompaction(currentItems, {
              model: thresholdModel,
              overheadTokens
            })
        if (!currentPlan) {
          return {
            changed: false,
            items: snapshot.items,
            value: { history: currentItems, result: null }
          }
        }
        let result = this.deps.compactor.compact({
          threadId: input.threadId,
          turnId: input.turnId,
          history: currentItems,
          prefix: this.deps.prefix,
          reason: currentPlan.reason,
          mode: currentPlan.mode,
          keepRecent: currentPlan.keepRecent,
          summaryItemId
        })
        if (result.replacedTokens === 0) {
          return {
            changed: false,
            items: snapshot.items,
            value: { history: currentItems, result: null }
          }
        }
        // A model summary generated for a stale snapshot must not be applied
        // to newer history. On retry the deterministic heuristic is used
        // instead of issuing a duplicate summarizer request.
        const contextCompaction = this.deps.getContextCompaction?.()
        if (attempt === 1 && contextCompaction?.summaryMode === 'model') {
          const compactionModel = resolveCompactionModel({
            contextCompaction,
            fallbackModel: input.model
          })
          const modelSummary = await summarizeCompactionWithModel({
            threadId: input.threadId,
            turnId: input.turnId,
            model: compactionModel.model,
            ...(compactionModel.providerId ? { providerId: compactionModel.providerId } : {}),
            modelClient: this.deps.model,
            prefix: this.deps.prefix,
            contextCompaction,
            items: currentItems,
            heuristicSummary: result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '',
            signal: input.signal,
            recordUsage: async (usageSnapshot) => {
              const usage = this.deps.usage.record(input.threadId, usageSnapshot)
              await this.deps.events.record({
                kind: 'usage',
                threadId: input.threadId,
                turnId: input.turnId,
                model: compactionModel.model,
                usage
              })
            },
            recordFallback: async (message) => {
              await this.deps.events.record({
                kind: 'error',
                threadId: input.threadId,
                turnId: input.turnId,
                message,
                code: 'compaction_summary_fallback',
                severity: 'warning'
              })
            }
          })
          if (input.signal.aborted) {
            return {
              changed: false,
              items: snapshot.items,
              value: { history: currentItems, result: null }
            }
          }
          if (modelSummary) {
            result = this.deps.compactor.compact({
              threadId: input.threadId,
              turnId: input.turnId,
              history: currentItems,
              prefix: this.deps.prefix,
              reason: currentPlan.reason,
              mode: currentPlan.mode,
              keepRecent: currentPlan.keepRecent,
              summaryOverride: modelSummary,
              summaryItemId
            })
          }
        }
        return {
          changed: true,
          items: insertCompactionIntoVisibleHistory({
            visibleItems: snapshot.items,
            compactedItems: result.next,
            summaryItem: result.summaryItem
          }),
          value: { history: result.next, result }
        }
      }
    })
    if (committed.status === 'applied') {
      const result = committed.value.result
      if (result) {
        this.deps.clearReadTracker?.(input.threadId)
        await this.deps.rewriteThreadItemsFromSession(input.threadId)
        await this.deps.events.record({
          kind: 'compaction_completed',
          threadId: input.threadId,
          turnId: input.turnId,
          itemId: result.summaryItem.id,
          summary: result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '',
          replacedTokens: result.replacedTokens,
          pinnedConstraints: this.deps.prefix.pinnedConstraints,
          ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceDigest
            ? { sourceDigest: result.summaryItem.sourceDigest }
            : {}),
          ...(result.summaryItem.kind === 'compaction' && result.summaryItem.digestMarker
            ? { digestMarker: result.summaryItem.digestMarker }
            : {}),
          ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceItemIds
            ? { sourceItemIds: result.summaryItem.sourceItemIds }
            : {})
        })
      }
      return committed.value.history
    }
    if (committed.status === 'unchanged') return committed.value.history
    // Do not fall back to the stale input after a lost CAS race. The next
    // loop step can retry compaction from this current safe history.
    return repairModelHistoryItems(
      effectiveHistoryAfterLatestCompaction(await this.deps.sessionStore.loadItems(input.threadId))
    )
  }
}
