import { describe, expect, it } from 'vitest'
import { startNodeHttpServer } from '../src/server/node-http-server.js'
import { Router } from '../src/server/router.js'

describe('Node HTTP server', () => {
  it('hides internal exception details in 500 responses', async () => {
    const router = new Router()
    router.add('GET', '/boom', () => {
      throw new Error('leaked stack detail: /tmp/private-token')
    })
    const server = await startNodeHttpServer({
      router,
      host: '127.0.0.1',
      port: 0
    })

    try {
      const response = await fetch(`http://${server.host}:${server.port}/boom`)
      const body = await response.json() as { code?: string; message?: string }

      expect(response.status).toBe(500)
      expect(body).toEqual({
        code: 'internal_error',
        message: 'Internal server error.'
      })
      expect(JSON.stringify(body)).not.toContain('private-token')
    } finally {
      await server.close()
    }
  })

  it('aborts the Fetch request when an SSE client disconnects', async () => {
    const router = new Router()
    let resolveAbort: (() => void) | undefined
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve
    })
    router.add('GET', '/events', (request) => {
      request.signal.addEventListener('abort', () => resolveAbort?.(), { once: true })
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: connected\n\n'))
        }
      }), { headers: { 'content-type': 'text/event-stream' } })
    })
    const server = await startNodeHttpServer({ router, host: '127.0.0.1', port: 0 })
    const controller = new AbortController()

    try {
      const response = await fetch(`http://${server.host}:${server.port}/events`, { signal: controller.signal })
      await response.body!.getReader().read()
      controller.abort()
      await aborted
    } finally {
      await server.close()
    }
  })

  it('force-closes a live SSE connection during shutdown', async () => {
    const router = new Router()
    router.add('GET', '/events', () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: connected\n\n'))
      }
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const server = await startNodeHttpServer({ router, host: '127.0.0.1', port: 0 })

    const response = await fetch(`http://${server.host}:${server.port}/events`)
    await response.body!.getReader().read()

    await expect(Promise.race([
      server.close(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('server close timed out')), 1_000))
    ])).resolves.toBeUndefined()
  })
})
