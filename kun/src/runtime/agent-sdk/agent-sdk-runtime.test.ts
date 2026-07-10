import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AgentSdkRuntime,
  decideSdkBuiltinSandbox,
  type SdkRuntimeDeps,
  type SdkTurnContext
} from './agent-sdk-runtime.js'
import type { SdkApi, SdkCanUseTool, SdkMessage, SdkQueryResult } from './sdk-protocol.js'
import type { RuntimeEventDraft } from '../../services/runtime-event-recorder.js'
import type { TurnItem } from '../../contracts/items.js'

function fakeSdk(messages: SdkMessage[], onQuery?: (opts: unknown) => void): SdkApi {
  const query = (input: { options?: unknown }): SdkQueryResult => {
    onQuery?.(input.options)
    async function* gen(): AsyncGenerator<SdkMessage> {
      for (const m of messages) yield m
    }
    const it = gen() as SdkQueryResult
    it.interrupt = async () => {}
    return it
  }
  return {
    query,
    createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }),
    tool: (name) => ({ name })
  }
}

function makeDeps(overrides: Partial<SdkRuntimeDeps> = {}): {
  deps: SdkRuntimeDeps
  events: RuntimeEventDraft[]
  items: TurnItem[]
  finished: Array<{ status: string; error?: string }>
  sessions: string[]
} {
  const events: RuntimeEventDraft[] = []
  const items: TurnItem[] = []
  const finished: Array<{ status: string; error?: string }> = []
  const sessions: string[] = []
  let n = 0
  const ctx: SdkTurnContext = {
    workspace: '/ws',
    userText: 'hello',
    approvalPolicy: 'auto',
    bridgeableTools: [{ name: 'generate_image', description: 'gen', inputSchema: {} }]
  }
  const deps: SdkRuntimeDeps = {
    handlesProvider: (id) => id === 'claude-sub',
    loadTurnContext: async () => ctx,
    executeKunTool: async () => ({ output: 'tool-ok' }),
    decideToolApproval: async () => ({ allow: true }),
    recordEvent: async (d) => {
      events.push(d)
    },
    applyItem: async (_t, item) => {
      items.push(item)
    },
    finishTurn: async (_t, _u, status, error) => {
      finished.push({ status, error })
    },
    saveSessionId: async (_t, id) => {
      sessions.push(id)
    },
    loadSdk: async () => fakeSdk([]),
    baseEnv: () => ({ PATH: '/bin', ANTHROPIC_API_KEY: 'leak' }),
    kunSystemPrompt: () => 'You are kun.',
    nextId: (p) => `${p}_${++n}`,
    ...overrides
  }
  return { deps, events, items, finished, sessions }
}

const STREAM: SdkMessage[] = [
  { type: 'system', subtype: 'init', session_id: 'sess_42' } as SdkMessage,
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }
  } as SdkMessage,
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hi there' },
        { type: 'tool_use', id: 'toolu_1', name: 'mcp__kun__generate_image', input: { prompt: 'cat' } }
      ]
    }
  } as SdkMessage,
  {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }]
    }
  } as SdkMessage,
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'all done',
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 }
  } as SdkMessage
]

describe('AgentSdkRuntime.runTurn', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  test('decideSdkBuiltinSandbox limits SDK reads to the workspace in workspace-write mode', () => {
    expect(decideSdkBuiltinSandbox('Read', { file_path: '/tmp/outside.txt' }, {
      workspace: '/ws',
      sandboxMode: 'workspace-write'
    })).toMatchObject({
      allow: false,
      message: expect.stringContaining('limited to workspace paths')
    })
    expect(decideSdkBuiltinSandbox('Read', { file_path: '/ws/inside.txt' }, {
      workspace: '/ws',
      sandboxMode: 'workspace-write'
    })).toBeNull()
  })

  test('rejects SDK Glob patterns that select paths outside the workspace', () => {
    const context = { workspace: '/ws', sandboxMode: 'read-only' as const }
    expect(decideSdkBuiltinSandbox('Glob', { pattern: '../.ssh/**' }, context)).toMatchObject({
      allow: false,
      message: expect.stringContaining('workspace glob patterns')
    })
    expect(decideSdkBuiltinSandbox('Glob', { pattern: '/etc/**' }, context)).toMatchObject({
      allow: false,
      message: expect.stringContaining('workspace glob patterns')
    })
    expect(decideSdkBuiltinSandbox('Glob', { pattern: 'src/**/*.ts' }, context)).toBeNull()
    // Grep's pattern is content regex; its optional `path` remains the
    // filesystem selector and must stay contained.
    expect(decideSdkBuiltinSandbox('Grep', { pattern: 'secret', path: '../.ssh' }, context)).toMatchObject({
      allow: false,
      message: expect.stringContaining('limited to workspace paths')
    })
  })

  test('denies an SDK file operation that escapes through a workspace symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-sdk-sandbox-'))
    cleanup.push(root)
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(workspace), mkdir(outside)])
    await symlink(outside, join(workspace, 'escape'))

    expect(decideSdkBuiltinSandbox('Write', { file_path: join(workspace, 'escape', 'owned.txt') }, {
      workspace,
      sandboxMode: 'workspace-write'
    })).toMatchObject({
      allow: false,
      message: expect.stringContaining('limited to the workspace sandbox')
    })
  })

  test('denies unknown SDK tools even in danger-full-access mode', () => {
    expect(decideSdkBuiltinSandbox('FutureWriteTool', {}, {
      workspace: '/ws',
      sandboxMode: 'danger-full-access'
    })).toMatchObject({
      allow: false,
      message: expect.stringContaining('SDK tool allowlist')
    })
  })

  test('drives the SDK stream into kun events/items and completes the turn', async () => {
    const { deps, events, items, finished, sessions } = makeDeps({ loadSdk: async () => fakeSdk(STREAM) })
    const runtime = new AgentSdkRuntime(deps)
    const status = await runtime.runTurn('th', 'tn', new AbortController().signal)

    expect(status).toBe('completed')
    expect(finished).toEqual([{ status: 'completed', error: undefined }])
    expect(sessions).toEqual(['sess_42'])

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('assistant_text_delta')
    expect(kinds).toContain('tool_call_ready')
    expect(kinds).toContain('tool_call_finished')
    expect(kinds).toContain('usage')

    // Persisted milestones: tool_call item + tool_result + completed assistant text
    const persistedKinds = items.map((i) => i.kind)
    expect(persistedKinds).toContain('tool_call')
    expect(persistedKinds).toContain('tool_result')
    expect(persistedKinds).toContain('assistant_text')
  })

  test('scopes the env: strips ANTHROPIC_API_KEY and injects the token', async () => {
    let seenOptions: { env?: Record<string, string | undefined> } = {}
    const sdk = fakeSdk(STREAM, (opts) => {
      seenOptions = opts as typeof seenOptions
    })
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'hi',
        approvalPolicy: 'auto',
        oauthToken: 'sk-ant-oat01-tok',
        bridgeableTools: []
      })
    })
    await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
    expect(seenOptions.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(seenOptions.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-tok')
  })

  test('gates SDK built-ins with the workspace sandbox before approval policy', async () => {
    let canUseTool: SdkCanUseTool | undefined
    let permissionMode: unknown
    const sdk = fakeSdk(STREAM, (opts) => {
      canUseTool = (opts as { canUseTool?: SdkCanUseTool }).canUseTool
      permissionMode = (opts as { permissionMode?: unknown }).permissionMode
    })
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'hi',
        approvalPolicy: 'auto',
        sandboxMode: 'workspace-write',
        bridgeableTools: []
      })
    })

    await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)

    expect(permissionMode).toBe('default')
    expect(canUseTool).toBeDefined()
    await expect(canUseTool!('Bash', { command: 'pwd' })).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('does not run host shell commands')
    })
    await expect(canUseTool!('Write', { file_path: '/tmp/outside.txt', content: 'x' })).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('limited to the workspace sandbox')
    })
    await expect(canUseTool!('Write', { file_path: '/ws/inside.txt', content: 'x' })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/ws/inside.txt', content: 'x' }
    })
  })

  test('null turn context fails the turn early', async () => {
    const { deps, finished } = makeDeps({ loadTurnContext: async () => null })
    const status = await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
    expect(status).toBe('failed')
    expect(finished[0].status).toBe('failed')
  })

  test('an already-aborted signal yields an aborted turn', async () => {
    const ac = new AbortController()
    ac.abort()
    const { deps, finished } = makeDeps({ loadSdk: async () => fakeSdk(STREAM) })
    const status = await new AgentSdkRuntime(deps).runTurn('th', 'tn', ac.signal)
    expect(status).toBe('aborted')
    expect(finished[0].status).toBe('aborted')
  })

  test('fails an SDK turn that exceeds the runtime wall-time limit', async () => {
    let interrupted = false
    const { deps, events, finished } = makeDeps({
      getTurnLimits: () => ({ maxWallTimeMs: 1 }),
      loadSdk: async () => ({
        query: ({ options }) => {
          const abortController = (options as { abortController: AbortController }).abortController
          const stream: SdkQueryResult = {
            async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessage> {
              await new Promise<void>((resolve) => {
                abortController.signal.addEventListener('abort', resolve, { once: true })
              })
            },
            interrupt: async () => { interrupted = true }
          }
          return stream
        },
        createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }),
        tool: () => ({})
      })
    })

    const status = await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)

    expect(status).toBe('failed')
    expect(interrupted).toBe(true)
    expect(finished).toContainEqual(expect.objectContaining({
      status: 'failed', error: expect.stringContaining('wall time')
    }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'turn_wall_time_limit' }))
  })

  test('a query failure records an error event and fails the turn', async () => {
    const { deps, events, finished } = makeDeps({
      loadSdk: async () => ({
        query: () => {
          throw new Error('sdk boom')
        },
        createSdkMcpServer: () => ({ type: 'sdk', name: 'kun', instance: {} }),
        tool: () => ({})
      })
    })
    const status = await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
    expect(status).toBe('failed')
    expect(events.some((e) => e.kind === 'error')).toBe(true)
    expect(finished[0]).toMatchObject({ status: 'failed' })
  })

  test('forwards image attachments as a structured user message (text + image block)', async () => {
    let prompt: unknown
    const sdk = fakeSdk(STREAM)
    const inner = sdk.query
    sdk.query = (input) => {
      prompt = (input as { prompt?: unknown }).prompt
      return inner(input)
    }
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: '这是什么',
        approvalPolicy: 'auto',
        images: [{ mediaType: 'image/png', base64: 'AAAA' }],
        bridgeableTools: []
      })
    })
    await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)

    expect(typeof prompt).not.toBe('string')
    const messages: Array<{ message: { content: unknown } }> = []
    for await (const m of prompt as AsyncIterable<{ message: { content: unknown } }>) messages.push(m)
    expect(messages).toHaveLength(1)
    expect(messages[0].message.content).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ])
  })

  test('uses a plain string prompt when there are no images', async () => {
    let prompt: unknown
    const sdk = fakeSdk(STREAM)
    const inner = sdk.query
    sdk.query = (input) => {
      prompt = (input as { prompt?: unknown }).prompt
      return inner(input)
    }
    const { deps } = makeDeps({ loadSdk: async () => sdk }) // default ctx: userText 'hello', no images
    await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
    expect(prompt).toBe('hello')
  })

  test('handlesProvider delegates to deps', () => {
    const { deps } = makeDeps()
    const runtime = new AgentSdkRuntime(deps)
    expect(runtime.handlesProvider('claude-sub')).toBe(true)
    expect(runtime.handlesProvider('deepseek')).toBe(false)
  })
})
