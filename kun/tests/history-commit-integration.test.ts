import { describe, expect, it } from 'vitest'
import { makeAssistantTextItem, makeUserItem } from '../src/domain/item.js'
import type { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { bootstrapThread, makeHarness, makeSilentModel } from './loop-test-harness.js'

type ConditionalRewriteGate = {
  entered: Promise<void>
  release(): void
}

function blockFirstConditionalRewrite(store: InMemorySessionStore): ConditionalRewriteGate {
  const raw = store.rewriteItemsIfRevision.bind(store)
  let entered!: () => void
  let release!: () => void
  let blocked = false
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve
  })
  store.rewriteItemsIfRevision = async (...args) => {
    if (!blocked) {
      blocked = true
      entered()
      await releasePromise
    }
    return raw(...args)
  }
  return { entered: enteredPromise, release }
}

describe('revision-aware history integrations', () => {
  it('retains a newly-started turn when discard races a full-history replacement', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h, { request: { prompt: 'first request' } })
    await h.turns.applyItem(h.threadId, makeAssistantTextItem({
      id: 'item_discarded_response',
      threadId: h.threadId,
      turnId: h.turnId,
      text: 'discard this generated response'
    }))
    const gate = blockFirstConditionalRewrite(h.sessionStore)

    const interrupting = h.turns.interruptTurn({
      threadId: h.threadId,
      turnId: h.turnId,
      discard: true
    })
    await gate.entered
    const next = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'new request must survive' }
    })
    gate.release()
    await expect(interrupting).resolves.toEqual({ status: 'aborted' })

    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user_message', text: 'first request' }),
      expect.objectContaining({ kind: 'user_message', text: 'new request must survive' })
    ]))
    expect(items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'item_discarded_response' })
    ]))
    const thread = await h.threadStore.get(h.threadId)
    expect(thread?.turns.find((turn) => turn.id === next.turnId)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user_message', text: 'new request must survive' })
    ]))

    await h.turns.interruptTurn({ threadId: h.threadId, turnId: next.turnId })
  })

  it('retries load-time healing from current history instead of dropping a concurrent append', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h, { request: { prompt: 'heal this history' } })
    await h.sessionStore.appendItem(h.threadId, {
      id: 'item_malformed_tool_call',
      threadId: h.threadId,
      turnId: h.turnId,
      role: 'tool',
      status: 'completed',
      createdAt: '2026-07-10T00:00:00.000Z',
      kind: 'tool_call',
      callId: '',
      toolName: '',
      toolKind: 'tool_call',
      arguments: {}
    })
    const gate = blockFirstConditionalRewrite(h.sessionStore)

    const running = h.loop.runTurn(h.threadId, h.turnId)
    await gate.entered
    await h.sessionStore.appendItem(h.threadId, makeUserItem({
      id: 'item_late_history_append',
      threadId: h.threadId,
      turnId: 'turn_late',
      text: 'late history append'
    }))
    gate.release()
    await expect(running).resolves.toBe('completed')

    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'item_late_history_append', text: 'late history append' })
    ]))
    expect(items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'item_malformed_tool_call' })
    ]))
  })
})
