import { describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import type { TurnItem } from '../contracts/items.js'
import { createThreadRecord } from '../domain/thread.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import type { UsageService } from '../services/usage-service.js'
import { TurnBudgetGate } from './turn-budget-gate.js'

const threadId = 'thread_budget_gate'
const turnId = 'turn_budget_gate'

function harness(costUsd: number) {
  const threadStore = new InMemoryThreadStore()
  const effects: string[] = []
  const items: TurnItem[] = []
  const events = {
    record: vi.fn(async (draft: { kind?: string; code?: string }) => {
      effects.push(`event:${draft.code}`)
      return draft
    })
  } as unknown as Pick<RuntimeEventRecorder, 'record'>
  const turns = {
    applyItem: vi.fn(async (_threadId: string, item: TurnItem) => {
      effects.push(`item:${item.kind === 'error' ? item.code : item.kind}`)
      items.push(item)
    })
  } as Pick<TurnService, 'applyItem'>
  const usage = {
    forThread: () => ({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitRate: null,
      turns: 0,
      costUsd
    })
  } satisfies Pick<UsageService, 'forThread'>
  const gate = new TurnBudgetGate({
    threadStore,
    turns,
    events,
    usage,
    nowIso: () => '2026-07-11T00:00:00.000Z'
  })
  return { gate, threadStore, effects, items, events, turns }
}

describe('TurnBudgetGate', () => {
  it('blocks a usage-limited goal without adding a duplicate visible item', async () => {
    const h = harness(0)
    const thread = createThreadRecord({
      id: threadId,
      title: 'goal budget',
      workspace: '/',
      model: 'm',
      goal: {
        threadId,
        objective: 'work',
        status: 'usageLimited',
        tokenBudget: 10,
        tokensUsed: 10,
        timeUsedSeconds: 0,
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z'
      }
    })

    await expect(h.gate.check(thread, threadId, turnId)).resolves.toBe('blocked')
    expect(h.effects).toEqual(['event:goal_token_budget_limited'])
    expect(h.items).toEqual([])
  })

  it('persists the exhausted-cost item before its event', async () => {
    const h = harness(2)
    const thread = createThreadRecord({
      id: threadId,
      title: 'cost budget',
      workspace: '/',
      model: 'm',
      costBudgetUsd: 1
    })

    await expect(h.gate.check(thread, threadId, turnId)).resolves.toBe('blocked')
    expect(h.effects).toEqual(['item:budget_limited', 'event:budget_limited'])
  })

  it('marks and emits the 80 percent warning only once', async () => {
    const h = harness(0.85)
    const thread = createThreadRecord({
      id: threadId,
      title: 'cost warning',
      workspace: '/',
      model: 'm',
      costBudgetUsd: 1
    })
    await h.threadStore.upsert(thread)

    await expect(h.gate.check(thread, threadId, turnId)).resolves.toBe('allow')
    const updated = await h.threadStore.get(threadId)
    expect(updated?.costBudgetWarningSent).toBe(true)
    await expect(h.gate.check(updated!, threadId, turnId)).resolves.toBe('allow')
    expect(h.effects).toEqual(['item:budget_warning', 'event:budget_warning'])
  })
})
