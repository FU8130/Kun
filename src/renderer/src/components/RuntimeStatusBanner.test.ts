import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import type { KunRuntimeStatusPayload } from '@shared/kun-gui-api'
import { RuntimeStatusBanner } from './RuntimeStatusBanner'

const storeState = vi.hoisted(() => ({
  runtimeStatus: null as KunRuntimeStatusPayload | null
}))

vi.mock('../store/chat-store', () => ({
  useChatStore: (selector: (state: { runtimeStatus: KunRuntimeStatusPayload | null }) => unknown) =>
    selector(storeState)
}))

describe('RuntimeStatusBanner', () => {
  afterEach(() => {
    storeState.runtimeStatus = null
  })

  it('renders automatic restarts as an informational status banner', () => {
    storeState.runtimeStatus = {
      state: 'restarting',
      source: 'health-check',
      attempt: 1,
      maxAttempts: 3,
      at: '2026-06-18T15:00:00.000Z'
    }

    const html = renderToStaticMarkup(createElement(RuntimeStatusBanner))

    expect(html).toContain('data-variant="info"')
    expect(html).toContain('role="status"')
    expect(html).toContain('border-sky-200')
    expect(html).not.toContain('role="alert"')
  })

  it('keeps settings rollback visually distinct as a warning banner', () => {
    storeState.runtimeStatus = {
      state: 'running',
      source: 'settings-apply',
      rolledBack: true,
      at: '2026-06-18T15:01:00.000Z'
    }

    const html = renderToStaticMarkup(createElement(RuntimeStatusBanner))

    expect(html).toContain('data-variant="warning"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('border-amber-200')
  })
})
