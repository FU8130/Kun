import { describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import { makeUserItem } from '../domain/item.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import type { ModelClient, ModelRequest } from '../ports/model-client.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { UsageService } from '../services/usage-service.js'
import { ContextCompactor } from './context-compactor.js'
import { HistoryCompactionService } from './history-compaction-service.js'
import type { LoopTelemetry } from './loop-telemetry.js'
import type { ResolvedHook } from '../hooks/hook-engine.js'
import type { ContextCompactionConfig } from './model-context-profile.js'

const threadId = 'thread_compaction_service'
const turnId = 'turn_compaction_service'

function silentModel(): ModelClient {
  return {
    provider: 'test',
    model: 'test-model',
    async *stream() {
      yield { kind: 'completed' as const, stopReason: 'stop' as const }
    }
  }
}

function createEvents(sessionStore: InMemorySessionStore): RuntimeEventRecorder {
  const bus = new InMemoryEventBus()
  return new RuntimeEventRecorder({
    eventBus: bus,
    sessionStore,
    allocateSeq: (id) => bus.allocateSeq(id),
    nowIso: () => '2026-01-01T00:00:00.000Z'
  })
}

describe('HistoryCompactionService', () => {
  it('hydrates pressure, atomically writes the visible marker, then projects and reports it', async () => {
    const sessionStore = new InMemorySessionStore()
    for (let index = 0; index < 5; index += 1) {
      await sessionStore.appendItem(threadId, makeUserItem({
        id: `item_${index}`,
        threadId,
        turnId,
        text: `older context ${index} ${'x'.repeat(120)}`
      }))
    }
    const telemetryCalls: string[] = []
    const telemetry = {
      hydratePromptPressureIfCold: vi.fn(async () => {
        telemetryCalls.push('hydrate')
      }),
      consumePromptPressure: vi.fn(() => {
        telemetryCalls.push('consume')
        return undefined
      })
    } as unknown as Pick<LoopTelemetry, 'hydratePromptPressureIfCold' | 'consumePromptPressure'>
    const effectOrder: string[] = []
    const service = new HistoryCompactionService({
      sessionStore,
      compactor: new ContextCompactor({ softThreshold: 1, hardThreshold: 2 }),
      prefix: createImmutablePrefix({ systemPrompt: 'stable prefix' }),
      model: silentModel(),
      usage: new UsageService(),
      events: createEvents(sessionStore),
      ids: new SequentialIdGenerator(),
      telemetry,
      clearReadTracker: (id) => {
        effectOrder.push(`clear:${id}`)
      },
      rewriteThreadItemsFromSession: async (id) => {
        effectOrder.push(`project:${id}`)
      }
    })

    const history = await service.compactIfNeeded({
      items: await sessionStore.loadItems(threadId),
      model: 'test-model',
      signal: new AbortController().signal,
      threadId,
      turnId
    })

    expect(telemetryCalls).toEqual(['hydrate', 'consume'])
    expect(history[0]).toMatchObject({ kind: 'compaction', id: 'compaction_1' })
    expect(effectOrder).toEqual([`clear:${threadId}`, `project:${threadId}`])
    const persisted = await sessionStore.loadItems(threadId)
    expect(persisted.map((item) => item.id)).toEqual([
      'item_0',
      'item_1',
      'item_2',
      'item_3',
      'compaction_1',
      'item_4'
    ])
    await expect(sessionStore.loadEventsSince(threadId, 0)).resolves.toEqual([
      expect.objectContaining({ kind: 'compaction_completed', itemId: 'compaction_1' })
    ])
  })

  it('only consumes the pending prompt-pressure signal when no compaction is needed', async () => {
    const sessionStore = new InMemorySessionStore()
    const item = makeUserItem({ id: 'item_only', threadId, turnId, text: 'short' })
    const telemetry = {
      hydratePromptPressureIfCold: vi.fn(async () => undefined),
      consumePromptPressure: vi.fn(() => undefined)
    } as unknown as Pick<LoopTelemetry, 'hydratePromptPressureIfCold' | 'consumePromptPressure'>
    const rewriteThreadItemsFromSession = vi.fn(async () => undefined)
    const service = new HistoryCompactionService({
      sessionStore,
      compactor: new ContextCompactor({ softThreshold: 1_000_000, hardThreshold: 1_100_000 }),
      prefix: createImmutablePrefix({ systemPrompt: 'stable prefix' }),
      model: silentModel(),
      usage: new UsageService(),
      events: createEvents(sessionStore),
      ids: new SequentialIdGenerator(),
      telemetry,
      rewriteThreadItemsFromSession
    })

    const inputItems = [item]
    const history = await service.compactIfNeeded({
      items: inputItems,
      model: 'test-model',
      signal: new AbortController().signal,
      threadId,
      turnId
    })

    expect(history).toBe(inputItems)
    expect(history).toEqual([item])
    expect(telemetry.hydratePromptPressureIfCold).toHaveBeenCalledWith(threadId, 'test-model')
    expect(telemetry.consumePromptPressure).toHaveBeenCalledWith(threadId, 'test-model')
    expect(rewriteThreadItemsFromSession).not.toHaveBeenCalled()
    await expect(sessionStore.loadItems(threadId)).resolves.toEqual([])
  })

  it('reads hooks and model-summary settings lazily after construction', async () => {
    const sessionStore = new InMemorySessionStore()
    for (let index = 0; index < 5; index += 1) {
      await sessionStore.appendItem(threadId, makeUserItem({
        id: `live_item_${index}`,
        threadId,
        turnId,
        text: `live runtime config ${index} ${'x'.repeat(120)}`
      }))
    }
    const requests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'test',
      model: 'initial-model',
      async *stream(request) {
        requests.push(request)
        yield { kind: 'assistant_text_delta' as const, text: 'summary from live config' }
        yield { kind: 'completed' as const, stopReason: 'stop' as const }
      }
    }
    const seenPreCompact = vi.fn()
    let hooks: readonly ResolvedHook[] | undefined
    let contextCompaction: ContextCompactionConfig | undefined
    const service = new HistoryCompactionService({
      sessionStore,
      compactor: new ContextCompactor({ softThreshold: 1, hardThreshold: 2 }),
      prefix: createImmutablePrefix({ systemPrompt: 'stable prefix' }),
      model,
      usage: new UsageService(),
      events: createEvents(sessionStore),
      ids: new SequentialIdGenerator(),
      telemetry: {
        hydratePromptPressureIfCold: async () => undefined,
        consumePromptPressure: () => undefined
      },
      getHooks: () => hooks,
      getContextCompaction: () => contextCompaction,
      rewriteThreadItemsFromSession: async () => undefined
    })

    hooks = [{ phase: 'PreCompact', run: seenPreCompact }]
    contextCompaction = { summaryMode: 'model', summaryModel: 'live-summary-model' }
    const history = await service.compactIfNeeded({
      items: await sessionStore.loadItems(threadId),
      model: 'main-model',
      signal: new AbortController().signal,
      threadId,
      turnId
    })

    expect(seenPreCompact).toHaveBeenCalledWith(expect.objectContaining({ phase: 'PreCompact' }))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ model: 'live-summary-model' })
    expect(history[0]).toMatchObject({ kind: 'compaction', summary: expect.stringContaining('summary from live config') })
  })
})
