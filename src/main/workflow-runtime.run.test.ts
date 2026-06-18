import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultKunRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWorkflowSettings,
  defaultWriteSettings,
  mergeWorkflowSettings,
  normalizeWorkflow,
  normalizeWorkflowSettings,
  type AppSettingsPatch,
  type AppSettingsV1,
  type WorkflowRunResult,
  type WorkflowV1
} from '../shared/app-settings'
import { createWorkflowRuntime } from './workflow-runtime'

function settingsWithWorkflows(workflows: WorkflowV1[]): AppSettingsV1 {
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: { kun: { ...defaultKunRuntimeSettings(), model: 'test-model', apiKey: 'test-key' } },
    workspaceRoot: '/tmp/workflow-workspace',
    log: { enabled: true, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    workflow: normalizeWorkflowSettings({ enabled: true, workflows }),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: '',
    disabledSkillIds: []
  }
}

function createStore(initial: AppSettingsV1) {
  let current = initial
  return {
    load: async () => current,
    patch: async (partial: AppSettingsPatch) => {
      current = { ...current, workflow: mergeWorkflowSettings(current.workflow, partial.workflow) }
      return current
    },
    read: () => current
  }
}

function buildWorkflow(partial: Partial<WorkflowV1>): WorkflowV1 {
  return normalizeWorkflow(partial, 0, '2026-06-18T00:00:00.000Z')
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('Timed out waiting for workflow run to finish')
}

function requireOk(result: WorkflowRunResult): string {
  if (!result.ok) throw new Error(`runWorkflow failed: ${result.message}`)
  return result.runId
}

describe('WorkflowRuntime end-to-end execution', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs trigger → AI → condition(true) → delay and skips the false branch', async () => {
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, pathAndQuery: string) => {
      if (pathAndQuery === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thread-1' }) }
      }
      if (pathAndQuery.includes('/turns')) {
        return { ok: true, status: 200, body: JSON.stringify({ turn: { id: 'turn-1' } }) }
      }
      if (pathAndQuery.startsWith('/v1/threads/')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'HELLO WORLD', turnId: 'turn-1' }]
              }
            ]
          })
        }
      }
      return { ok: false, status: 404, body: '{}' }
    })

    const workflow = buildWorkflow({
      id: 'wf-1',
      name: 'Demo',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        { id: 'a', type: 'ai-agent', config: { prompt: 'say hi', model: 'test-model' } },
        { id: 'c', type: 'condition', config: { leftExpr: '', operator: 'contains', rightValue: 'HELL' } },
        { id: 'd', type: 'delay', config: { delayMs: 10 } },
        { id: 'h', type: 'http-request', config: { method: 'GET', url: 'https://example.com' } }
      ],
      connections: [
        { id: 'e1', source: 'm', sourceHandle: 'out', target: 'a', targetHandle: 'in' },
        { id: 'e2', source: 'a', sourceHandle: 'out', target: 'c', targetHandle: 'in' },
        { id: 'e3', source: 'c', sourceHandle: 'true', target: 'd', targetHandle: 'in' },
        { id: 'e4', source: 'c', sourceHandle: 'false', target: 'h', targetHandle: 'in' }
      ]
    })

    const store = createStore(settingsWithWorkflows([workflow]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: runtimeRequest as never, logError: vi.fn() })

    const runId = requireOk(await runtime.runWorkflow('wf-1'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 15_000)

    const persisted = store.read().workflow.workflows[0]
    const run = persisted.runs.find((entry) => entry.id === runId)!
    const ranIds = run.nodeResults.map((result) => result.nodeId)

    expect(run.status).toBe('success')
    expect(persisted.lastStatus).toBe('success')
    expect(ranIds).toEqual(expect.arrayContaining(['m', 'a', 'c', 'd']))
    expect(ranIds).not.toContain('h') // false branch must be skipped

    const aiResult = run.nodeResults.find((result) => result.nodeId === 'a')!
    expect(aiResult.status).toBe('success')
    expect(aiResult.message).toContain('HELLO WORLD')
    expect(aiResult.threadId).toBe('thread-1')

    const conditionResult = run.nodeResults.find((result) => result.nodeId === 'c')!
    expect(conditionResult.message).toBe('true')

    runtime.stop()
  }, 20_000)

  it('executes an HTTP request node and captures the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"value":42}', { status: 200, statusText: 'OK' }))
    )

    const workflow = buildWorkflow({
      id: 'wf-http',
      name: 'Http',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        {
          id: 'h',
          type: 'http-request',
          config: { method: 'GET', url: 'https://example.com/data', parseJson: true }
        }
      ],
      connections: [{ id: 'e1', source: 'm', sourceHandle: 'out', target: 'h', targetHandle: 'in' }]
    })

    const store = createStore(settingsWithWorkflows([workflow]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })

    const runId = requireOk(await runtime.runWorkflow('wf-http'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)

    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    const httpResult = run.nodeResults.find((result) => result.nodeId === 'h')!
    expect(run.status).toBe('success')
    expect(httpResult.status).toBe('success')
    expect(httpResult.message).toContain('200')
    expect(httpResult.outputJson).toContain('42')

    runtime.stop()
  }, 15_000)

  it('marks the run as error when a node fails and stops the chain', async () => {
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, pathAndQuery: string) => {
      if (pathAndQuery === '/v1/threads') {
        return { ok: false, status: 500, body: JSON.stringify({ message: 'boom' }) }
      }
      return { ok: false, status: 404, body: '{}' }
    })

    const workflow = buildWorkflow({
      id: 'wf-err',
      name: 'Err',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        { id: 'a', type: 'ai-agent', config: { prompt: 'fail', model: 'test-model' } },
        { id: 'd', type: 'delay', config: { delayMs: 10 } }
      ],
      connections: [
        { id: 'e1', source: 'm', sourceHandle: 'out', target: 'a', targetHandle: 'in' },
        { id: 'e2', source: 'a', sourceHandle: 'out', target: 'd', targetHandle: 'in' }
      ]
    })

    const store = createStore(settingsWithWorkflows([workflow]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: runtimeRequest as never, logError: vi.fn() })

    const runId = requireOk(await runtime.runWorkflow('wf-err'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)

    const persisted = store.read().workflow.workflows[0]
    const run = persisted.runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('error')
    expect(persisted.lastStatus).toBe('error')
    const aiResult = run.nodeResults.find((result) => result.nodeId === 'a')!
    expect(aiResult.status).toBe('error')
    expect(aiResult.error).toContain('boom')
    // The downstream delay node must not have run.
    expect(run.nodeResults.find((result) => result.nodeId === 'd')).toBeUndefined()

    runtime.stop()
  }, 15_000)

  it('set-fields node shapes JSON and interpolates the upstream output', async () => {
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, pathAndQuery: string) => {
      if (pathAndQuery === '/v1/threads') return { ok: true, status: 200, body: JSON.stringify({ id: 'thread-1' }) }
      if (pathAndQuery.includes('/turns')) return { ok: true, status: 200, body: JSON.stringify({ turn: { id: 'turn-1' } }) }
      if (pathAndQuery.startsWith('/v1/threads/')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            turns: [{ id: 'turn-1', status: 'completed', items: [{ kind: 'assistant_text', text: 'WORLD', turnId: 'turn-1' }] }]
          })
        }
      }
      return { ok: false, status: 404, body: '{}' }
    })

    const workflow = buildWorkflow({
      id: 'wf-set',
      name: 'Set',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        { id: 'a', type: 'ai-agent', config: { prompt: 'hi', model: 'test-model' } },
        {
          id: 's',
          type: 'set-fields',
          config: { fields: [{ key: 'greeting', value: 'hello {{text}}' }, { key: 'fixed', value: 'x' }], keepIncoming: false }
        }
      ],
      connections: [
        { id: 'e1', source: 'm', sourceHandle: 'out', target: 'a', targetHandle: 'in' },
        { id: 'e2', source: 'a', sourceHandle: 'out', target: 's', targetHandle: 'in' }
      ]
    })

    const store = createStore(settingsWithWorkflows([workflow]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: runtimeRequest as never, logError: vi.fn() })

    const runId = requireOk(await runtime.runWorkflow('wf-set'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)

    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('success')
    const setResult = run.nodeResults.find((result) => result.nodeId === 's')!
    const output = JSON.parse(setResult.outputJson) as Record<string, unknown>
    expect(output).toEqual({ greeting: 'hello WORLD', fixed: 'x' })

    runtime.stop()
  }, 15_000)

  it('switch routes to the matching case and prunes the others', async () => {
    const store = createStore(
      settingsWithWorkflows([
        buildWorkflow({
          id: 'wf-sw',
          name: 'Sw',
          enabled: true,
          nodes: [
            { id: 'm', type: 'manual-trigger', config: {} },
            { id: 's', type: 'set-fields', config: { fields: [{ key: 'v', value: 'B' }], keepIncoming: false } },
            {
              id: 'sw',
              type: 'switch',
              config: {
                rules: [
                  { leftExpr: 'json.v', operator: 'equals', rightValue: 'A', caseSensitive: false },
                  { leftExpr: 'json.v', operator: 'equals', rightValue: 'B', caseSensitive: false }
                ],
                fallback: false
              }
            },
            { id: 'out0', type: 'set-fields', config: { fields: [{ key: 'hit', value: '0' }], keepIncoming: false } },
            { id: 'out1', type: 'set-fields', config: { fields: [{ key: 'hit', value: '1' }], keepIncoming: false } }
          ],
          connections: [
            { id: 'e1', source: 'm', sourceHandle: 'out', target: 's', targetHandle: 'in' },
            { id: 'e2', source: 's', sourceHandle: 'out', target: 'sw', targetHandle: 'in' },
            { id: 'e3', source: 'sw', sourceHandle: 'case-0', target: 'out0', targetHandle: 'in' },
            { id: 'e4', source: 'sw', sourceHandle: 'case-1', target: 'out1', targetHandle: 'in' }
          ]
        })
      ])
    )
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('wf-sw'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    const ids = run.nodeResults.map((result) => result.nodeId)
    expect(run.status).toBe('success')
    expect(ids).toEqual(expect.arrayContaining(['m', 's', 'sw', 'out1']))
    expect(ids).not.toContain('out0')
    runtime.stop()
  }, 15_000)

  it('merge waits for all branches and combines their outputs', async () => {
    const store = createStore(
      settingsWithWorkflows([
        buildWorkflow({
          id: 'wf-mg',
          name: 'Mg',
          enabled: true,
          nodes: [
            { id: 'm', type: 'manual-trigger', config: {} },
            { id: 'a', type: 'set-fields', config: { fields: [{ key: 'x', value: '1' }], keepIncoming: false } },
            { id: 'b', type: 'set-fields', config: { fields: [{ key: 'y', value: '2' }], keepIncoming: false } },
            { id: 'mg', type: 'merge', config: { mode: 'object' } }
          ],
          connections: [
            { id: 'e1', source: 'm', sourceHandle: 'out', target: 'a', targetHandle: 'in' },
            { id: 'e2', source: 'm', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
            { id: 'e3', source: 'a', sourceHandle: 'out', target: 'mg', targetHandle: 'in' },
            { id: 'e4', source: 'b', sourceHandle: 'out', target: 'mg', targetHandle: 'in' }
          ]
        })
      ])
    )
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('wf-mg'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('success')
    const merge = run.nodeResults.find((result) => result.nodeId === 'mg')!
    expect(JSON.parse(merge.outputJson)).toEqual({ x: '1', y: '2' })
    runtime.stop()
  }, 15_000)

  it('code node evaluates JS against the upstream payload', async () => {
    const store = createStore(
      settingsWithWorkflows([
        buildWorkflow({
          id: 'wf-code',
          name: 'Code',
          enabled: true,
          nodes: [
            { id: 'm', type: 'manual-trigger', config: {} },
            { id: 's', type: 'set-fields', config: { fields: [{ key: 'n', value: '5' }], keepIncoming: false } },
            { id: 'c', type: 'code', config: { code: 'return { doubled: Number($json.n) * 2 }' } }
          ],
          connections: [
            { id: 'e1', source: 'm', sourceHandle: 'out', target: 's', targetHandle: 'in' },
            { id: 'e2', source: 's', sourceHandle: 'out', target: 'c', targetHandle: 'in' }
          ]
        })
      ])
    )
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('wf-code'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('success')
    const code = run.nodeResults.find((result) => result.nodeId === 'c')!
    expect(JSON.parse(code.outputJson)).toEqual({ doubled: 10 })
    runtime.stop()
  }, 15_000)

  it('code node times out on an infinite loop and errors the run', async () => {
    const store = createStore(
      settingsWithWorkflows([
        buildWorkflow({
          id: 'wf-loop',
          name: 'Loop',
          enabled: true,
          nodes: [
            { id: 'm', type: 'manual-trigger', config: {} },
            { id: 'c', type: 'code', config: { code: 'while (true) {}' } }
          ],
          connections: [{ id: 'e1', source: 'm', sourceHandle: 'out', target: 'c', targetHandle: 'in' }]
        })
      ])
    )
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('wf-loop'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('error')
    const code = run.nodeResults.find((result) => result.nodeId === 'c')!
    expect(code.status).toBe('error')
    expect(code.error.toLowerCase()).toContain('code')
    runtime.stop()
  }, 15_000)

  it('subworkflow node runs another workflow and returns its output', async () => {
    const child = buildWorkflow({
      id: 'child',
      name: 'Child',
      enabled: true,
      nodes: [
        { id: 'cm', type: 'manual-trigger', config: {} },
        { id: 'cs', type: 'set-fields', config: { fields: [{ key: 'childOut', value: 'yes' }], keepIncoming: false } }
      ],
      connections: [{ id: 'ce1', source: 'cm', sourceHandle: 'out', target: 'cs', targetHandle: 'in' }]
    })
    const parent = buildWorkflow({
      id: 'parent',
      name: 'Parent',
      enabled: true,
      nodes: [
        { id: 'pm', type: 'manual-trigger', config: {} },
        { id: 'sub', type: 'subworkflow', config: { workflowId: 'child' } }
      ],
      connections: [{ id: 'pe1', source: 'pm', sourceHandle: 'out', target: 'sub', targetHandle: 'in' }]
    })
    const store = createStore(settingsWithWorkflows([child, parent]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('parent'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows
        .find((wf) => wf.id === 'parent')!
        .runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows.find((wf) => wf.id === 'parent')!.runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('success')
    const sub = run.nodeResults.find((result) => result.nodeId === 'sub')!
    expect(JSON.parse(sub.outputJson)).toEqual({ childOut: 'yes' })
    runtime.stop()
  }, 15_000)

  it('subworkflow recursion is bounded by the depth guard', async () => {
    const selfRef = buildWorkflow({
      id: 'self',
      name: 'Self',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        { id: 'sub', type: 'subworkflow', config: { workflowId: 'self' } }
      ],
      connections: [{ id: 'e1', source: 'm', sourceHandle: 'out', target: 'sub', targetHandle: 'in' }]
    })
    const store = createStore(settingsWithWorkflows([selfRef]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('self'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('error')
    expect(run.nodeResults.find((result) => result.nodeId === 'sub')!.error.toLowerCase()).toContain('deep')
    runtime.stop()
  }, 15_000)

  it('webhook trigger fires the workflow with the request body', async () => {
    const port = 18765
    const settings = settingsWithWorkflows([
      buildWorkflow({
        id: 'wf-wh',
        name: 'Wh',
        enabled: true,
        nodes: [
          { id: 'w', type: 'webhook-trigger', config: { path: '/hook', method: 'POST' } },
          {
            id: 's',
            type: 'set-fields',
            config: { fields: [{ key: 'echo', value: '{{json.name}}' }], keepIncoming: false }
          }
        ],
        connections: [{ id: 'e1', source: 'w', sourceHandle: 'out', target: 's', targetHandle: 'in' }]
      })
    ])
    settings.workflow.webhookPort = port
    const store = createStore(settings)
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    runtime.sync(store.read())
    try {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const response = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        body: JSON.stringify({ name: 'kun' })
      })
      const body = (await response.json()) as { ok: boolean; runId: string }
      expect(response.status).toBe(200)
      expect(body.ok).toBe(true)
      await waitFor(async () => {
        const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === body.runId)
        return Boolean(run && run.status !== 'running')
      }, 5_000)
      const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === body.runId)!
      expect(run.status).toBe('success')
      const setResult = run.nodeResults.find((result) => result.nodeId === 's')!
      expect(JSON.parse(setResult.outputJson)).toEqual({ echo: 'kun' })
    } finally {
      runtime.stop()
    }
  }, 15_000)

  it('loop runs the body until the stop condition holds', async () => {
    const body = buildWorkflow({
      id: 'body',
      name: 'Body',
      enabled: true,
      nodes: [
        { id: 'bm', type: 'manual-trigger', config: {} },
        { id: 'bc', type: 'code', config: { code: 'return { n: (Number($json.n) || 0) + 1 }' } }
      ],
      connections: [{ id: 'be1', source: 'bm', sourceHandle: 'out', target: 'bc', targetHandle: 'in' }]
    })
    const parent = buildWorkflow({
      id: 'parent',
      name: 'P',
      enabled: true,
      nodes: [
        { id: 'm', type: 'manual-trigger', config: {} },
        {
          id: 'lp',
          type: 'loop',
          config: {
            workflowId: 'body',
            maxIterations: 10,
            leftExpr: 'json.n',
            operator: 'gte',
            rightValue: '3',
            caseSensitive: false
          }
        }
      ],
      connections: [{ id: 'e1', source: 'm', sourceHandle: 'out', target: 'lp', targetHandle: 'in' }]
    })
    const store = createStore(settingsWithWorkflows([body, parent]))
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('parent'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows
        .find((wf) => wf.id === 'parent')!
        .runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows.find((wf) => wf.id === 'parent')!.runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('success')
    const loop = run.nodeResults.find((result) => result.nodeId === 'lp')!
    const output = JSON.parse(loop.outputJson) as { n: number; _iterations: number; _done: boolean }
    expect(output.n).toBe(3)
    expect(output._iterations).toBe(3)
    expect(output._done).toBe(true)
    runtime.stop()
  }, 15_000)

  it('sort orders the upstream array by a numeric field', async () => {
    const store = createStore(
      settingsWithWorkflows([
        buildWorkflow({
          id: 'wf-sort',
          name: 'Sort',
          enabled: true,
          nodes: [
            { id: 'm', type: 'manual-trigger', config: {} },
            { id: 'c', type: 'code', config: { code: 'return [{v:3},{v:1},{v:2}]' } },
            { id: 'srt', type: 'sort', config: { field: 'v', order: 'asc', numeric: true } }
          ],
          connections: [
            { id: 'e1', source: 'm', sourceHandle: 'out', target: 'c', targetHandle: 'in' },
            { id: 'e2', source: 'c', sourceHandle: 'out', target: 'srt', targetHandle: 'in' }
          ]
        })
      ])
    )
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('wf-sort'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('success')
    const sorted = run.nodeResults.find((result) => result.nodeId === 'srt')!
    expect(JSON.parse(sorted.outputJson)).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }])
    runtime.stop()
  }, 15_000)

  it('limit keeps the last N items of the upstream array', async () => {
    const store = createStore(
      settingsWithWorkflows([
        buildWorkflow({
          id: 'wf-limit',
          name: 'Limit',
          enabled: true,
          nodes: [
            { id: 'm', type: 'manual-trigger', config: {} },
            { id: 'c', type: 'code', config: { code: 'return [1,2,3,4,5]' } },
            { id: 'lim', type: 'limit', config: { count: 2, from: 'last' } }
          ],
          connections: [
            { id: 'e1', source: 'm', sourceHandle: 'out', target: 'c', targetHandle: 'in' },
            { id: 'e2', source: 'c', sourceHandle: 'out', target: 'lim', targetHandle: 'in' }
          ]
        })
      ])
    )
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('wf-limit'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('success')
    const limited = run.nodeResults.find((result) => result.nodeId === 'lim')!
    expect(JSON.parse(limited.outputJson)).toEqual([4, 5])
    runtime.stop()
  }, 15_000)

  it('aggregate sums a field across the upstream array', async () => {
    const store = createStore(
      settingsWithWorkflows([
        buildWorkflow({
          id: 'wf-agg',
          name: 'Agg',
          enabled: true,
          nodes: [
            { id: 'm', type: 'manual-trigger', config: {} },
            { id: 'c', type: 'code', config: { code: 'return [{price:10},{price:5},{price:7}]' } },
            { id: 'ag', type: 'aggregate', config: { mode: 'sum', field: 'price', separator: ', ' } }
          ],
          connections: [
            { id: 'e1', source: 'm', sourceHandle: 'out', target: 'c', targetHandle: 'in' },
            { id: 'e2', source: 'c', sourceHandle: 'out', target: 'ag', targetHandle: 'in' }
          ]
        })
      ])
    )
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })
    const runId = requireOk(await runtime.runWorkflow('wf-agg'))
    await waitFor(async () => {
      const run = (await store.load()).workflow.workflows[0].runs.find((entry) => entry.id === runId)
      return Boolean(run && run.status !== 'running')
    }, 10_000)
    const run = store.read().workflow.workflows[0].runs.find((entry) => entry.id === runId)!
    expect(run.status).toBe('success')
    const agg = run.nodeResults.find((result) => result.nodeId === 'ag')!
    expect(JSON.parse(agg.outputJson)).toEqual({ sum: 22 })
    runtime.stop()
  }, 15_000)

  it('filter passes the branch when the condition holds and prunes it otherwise', async () => {
    const makeFilterWorkflow = (id: string, rightValue: string): WorkflowV1 =>
      buildWorkflow({
        id,
        name: id,
        enabled: true,
        nodes: [
          { id: 'm', type: 'manual-trigger', config: {} },
          { id: 's', type: 'set-fields', config: { fields: [{ key: 'v', value: 'B' }], keepIncoming: false } },
          { id: 'f', type: 'filter', config: { leftExpr: 'json.v', operator: 'equals', rightValue, caseSensitive: false } },
          { id: 'd', type: 'set-fields', config: { fields: [{ key: 'hit', value: '1' }], keepIncoming: false } }
        ],
        connections: [
          { id: 'e1', source: 'm', sourceHandle: 'out', target: 's', targetHandle: 'in' },
          { id: 'e2', source: 's', sourceHandle: 'out', target: 'f', targetHandle: 'in' },
          { id: 'e3', source: 'f', sourceHandle: 'out', target: 'd', targetHandle: 'in' }
        ]
      })

    const store = createStore(
      settingsWithWorkflows([makeFilterWorkflow('wf-pass', 'B'), makeFilterWorkflow('wf-block', 'C')])
    )
    const runtime = createWorkflowRuntime({ store: store as never, runtimeRequest: vi.fn() as never, logError: vi.fn() })

    const passId = requireOk(await runtime.runWorkflow('wf-pass'))
    const blockId = requireOk(await runtime.runWorkflow('wf-block'))
    await waitFor(async () => {
      const settings = await store.load()
      const passRun = settings.workflow.workflows.find((wf) => wf.id === 'wf-pass')!.runs.find((e) => e.id === passId)
      const blockRun = settings.workflow.workflows.find((wf) => wf.id === 'wf-block')!.runs.find((e) => e.id === blockId)
      return Boolean(passRun && passRun.status !== 'running' && blockRun && blockRun.status !== 'running')
    }, 10_000)

    const settings = store.read()
    const passRun = settings.workflow.workflows.find((wf) => wf.id === 'wf-pass')!.runs.find((e) => e.id === passId)!
    const blockRun = settings.workflow.workflows.find((wf) => wf.id === 'wf-block')!.runs.find((e) => e.id === blockId)!
    expect(passRun.status).toBe('success')
    expect(passRun.nodeResults.map((r) => r.nodeId)).toContain('d')
    expect(blockRun.status).toBe('success')
    expect(blockRun.nodeResults.map((r) => r.nodeId)).not.toContain('d')
    runtime.stop()
  }, 15_000)
})
