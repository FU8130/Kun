import { encodeSseEvent } from '../sse.js'
import type { EventBus } from '../../ports/event-bus.js'
import type { SessionStore } from '../../ports/session-store.js'
import type { RuntimeEvent } from '../../contracts/events.js'

const HEARTBEAT_INTERVAL_MS = 15_000
/**
 * Events published while a slow persisted replay is in flight. If this fills,
 * closing the stream is safer than retaining an unbounded in-memory backlog:
 * every event is already durable and the client can reconnect from its cursor.
 */
export const MAX_LIVE_EVENTS_DURING_REPLAY = 1_024

/**
 * Build an SSE response for `GET /v1/threads/{id}/events`.
 *
 * The handler subscribes before it replays persisted events, buffering live
 * updates until replay is complete. That closes the otherwise permanent gap
 * between a store snapshot and EventBus subscription. The stream closes when
 * the request's `AbortSignal`
 * fires (the client disconnects) or the server stops publishing.
 *
 * Delivery is deduplicated per connection: an event whose seq is at or
 * below the connection's high-water mark is dropped, so an event that
 * lands in both the persisted backlog and the live subscription (the
 * recorder persists before publishing) is delivered exactly once.
 * Heartbeats reuse the high-water mark instead of allocating fresh
 * seqs — after a runtime restart the in-memory seq counter starts
 * over, and stamping heartbeats with those low seqs used to rewind
 * client cursors, which made the next subscription replay the entire
 * thread history into the live transcript.
 */
export function buildEventStreamResponse(input: {
  request: Request
  threadId: string
  eventBus: EventBus
  sessionStore: SessionStore
  sinceSeq?: number
}): Response {
  const sinceSeq = input.sinceSeq ?? parseEventCursor(input.request) ?? 0
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        unsubscribe?.()
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = undefined
        }
        try {
          controller.close()
        } catch {
          // Already closed; ignore.
        }
      }
      input.request.signal.addEventListener('abort', close)
      if (input.request.signal.aborted) {
        close()
        return
      }
      try {
        let lastDeliveredSeq = sinceSeq
        const deliver = (event: RuntimeEvent): void => {
          if (typeof event.seq === 'number') {
            if (event.seq <= lastDeliveredSeq) return
            lastDeliveredSeq = event.seq
          }
          controller.enqueue(encoder.encode(encodeSseEvent(event)))
        }
        const liveDuringReplay: RuntimeEvent[] = []
        let replaying = true
        let replayOverflowed = false
        unsubscribe = input.eventBus.subscribe(input.threadId, (event: RuntimeEvent) => {
          if (closed) return
          if (replaying) {
            if (liveDuringReplay.length >= MAX_LIVE_EVENTS_DURING_REPLAY) {
              replayOverflowed = true
              return
            }
            liveDuringReplay.push(event)
            return
          }
          try {
            deliver(event)
          } catch {
            close()
          }
        })
        const highestSeq = await input.sessionStore.highestSeq(input.threadId).catch(() => 0)
        const backlog = sinceSeq >= highestSeq
          ? []
          : await input.sessionStore.loadEventsSince(input.threadId, sinceSeq)
        for (const event of backlog) deliver(event)
        if (replayOverflowed) {
          controller.enqueue(encoder.encode(
            'event: error\ndata: {"message":"SSE replay overflow; reconnect from the last event cursor."}\n\n'
          ))
          close()
          return
        }
        // Publishing is synchronous, so no new event can slip between this
        // drain and switching the subscriber into direct-delivery mode.
        for (const event of liveDuringReplay.sort((a, b) => a.seq - b.seq)) deliver(event)
        replaying = false
        heartbeatTimer = setInterval(() => {
          if (closed) return
          try {
            controller.enqueue(
              encoder.encode(
                encodeSseEvent({
                  kind: 'heartbeat',
                  seq: lastDeliveredSeq,
                  timestamp: new Date().toISOString(),
                  threadId: input.threadId
                })
              )
            )
          } catch {
            close()
          }
        }, HEARTBEAT_INTERVAL_MS)
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({
              message: error instanceof Error ? error.message : String(error)
            })}\n\n`
          )
        )
        close()
      }
    },
    cancel() {
      closed = true
      unsubscribe?.()
      if (heartbeatTimer) clearInterval(heartbeatTimer)
    }
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  })
}

/** Query cursor takes precedence over Last-Event-ID, including an explicit 0. */
export function parseEventCursor(request: Request): number | null {
  const url = new URL(request.url)
  const query = url.searchParams.get('since_seq')
  const raw = query === null ? request.headers.get('Last-Event-ID') : query
  if (raw === null || raw.trim() === '') return 0
  if (!/^\d+$/.test(raw.trim())) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
