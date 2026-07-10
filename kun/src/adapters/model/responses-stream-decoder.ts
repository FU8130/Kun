import type { UsageSnapshot } from '../../contracts/usage.js'
import type { ModelStreamChunk } from '../../ports/model-client.js'
import {
  ModelStreamResourceBudget,
  type PendingToolCall
} from './model-stream-resource-budget.js'

type MaterializedResponses = {
  chunks: ModelStreamChunk[]
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  usage: UsageSnapshot | null
}

export function decodeResponsesStreamPayload(input: {
  payload: Record<string, unknown>
  pendingArguments: Map<string, PendingToolCall>
  pendingByIndex: Map<number, string>
  completedToolCalls: Set<string>
  sawTextDelta: boolean
  budget: ModelStreamResourceBudget
  parseToolArguments: (raw: string) => Record<string, unknown>
  materializeCompleted: (
    payload: Record<string, unknown>,
    options: {
      skipText: boolean
      pendingArguments: Map<string, PendingToolCall>
      completedToolCalls: Set<string>
      budget: ModelStreamResourceBudget
    }
  ) => MaterializedResponses
}): {
  chunks: ModelStreamChunk[]
  sawTextDelta: boolean
  finishReason: string | null
  usage: UsageSnapshot | null
} {
  const chunks: ModelStreamChunk[] = []
  let sawText = input.sawTextDelta
  let finishReason: string | null = null
  let usage: UsageSnapshot | null = null
  const type = recordString(input.payload, 'type')
  const outputIndex = numericIndex(input.payload.output_index)
  const item = recordValue(input.payload, 'item') ?? recordValue(input.payload, 'output_item')
  if (item) {
    const itemType = recordString(item, 'type')
    if (itemType === 'image_generation_call' && type === 'response.output_item.done') {
      const result = recordString(item, 'result')
      if (result) chunks.push({ kind: 'image_generation_complete', imageBase64: result, mimeType: 'image/png' })
    } else if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const callId = recordString(item, 'call_id') || recordString(item, 'id') ||
        indexFallbackCallId(outputIndex, input.pendingArguments)
      const pending = input.budget.pendingCall(input.pendingArguments, callId, outputIndex)
      if (outputIndex !== undefined) input.budget.bindPendingIndex(input.pendingByIndex, outputIndex, callId)
      const name = recordString(item, 'name')
      if (name) pending.name = name
      const initialArguments = recordString(item, 'arguments') || recordString(item, 'input')
      if (initialArguments && pending.argumentBytes === 0) {
        input.budget.replaceArguments(pending, initialArguments)
      }
      if (type === 'response.output_item.done' && pending.name) {
        const raw = input.budget.pendingArguments(pending)
        input.budget.completeToolCall(raw)
        chunks.push({
          kind: 'tool_call_complete', callId, toolName: pending.name,
          arguments: input.parseToolArguments(raw || '{}')
        })
        input.completedToolCalls.add(callId)
        input.budget.removePendingCall(input.pendingArguments, callId)
        if (pending.index !== undefined) input.pendingByIndex.delete(pending.index)
      }
    }
  }
  if (type === 'response.output_text.delta') {
    const delta = recordString(input.payload, 'delta')
    if (delta) {
      sawText = true
      chunks.push({ kind: 'assistant_text_delta', text: delta })
    }
  } else if (
    type === 'response.reasoning_text.delta' ||
    type === 'response.reasoning_summary_text.delta' ||
    type === 'response.reasoning.delta'
  ) {
    const delta = recordString(input.payload, 'delta')
    if (delta) chunks.push({ kind: 'assistant_reasoning_delta', text: delta })
  } else if (type === 'response.function_call_arguments.delta') {
    const callId = responseStreamCallId(input.payload, input.pendingArguments, input.pendingByIndex)
    const pending = input.budget.pendingCall(input.pendingArguments, callId, outputIndex)
    const delta = recordString(input.payload, 'delta')
    if (outputIndex !== undefined) input.budget.bindPendingIndex(input.pendingByIndex, outputIndex, callId)
    if (delta) {
      input.budget.appendArguments(pending, delta)
      chunks.push({ kind: 'tool_call_delta', callId, toolName: pending.name, argumentsDelta: delta })
    }
  } else if (type === 'response.function_call_arguments.done') {
    const callId = responseStreamCallId(input.payload, input.pendingArguments, input.pendingByIndex)
    const pending = input.budget.pendingCall(input.pendingArguments, callId, outputIndex)
    const args = recordString(input.payload, 'arguments')
    if (args) input.budget.replaceArguments(pending, args)
  } else if (type === 'response.completed') {
    const response = recordValue(input.payload, 'response') ?? input.payload
    const materialized = input.materializeCompleted(response, {
      skipText: sawText,
      pendingArguments: input.pendingArguments,
      completedToolCalls: input.completedToolCalls,
      budget: input.budget
    })
    chunks.push(...materialized.chunks)
    if (materialized.chunks.some((chunk) => chunk.kind === 'assistant_text_delta')) sawText = true
    usage = materialized.usage
    finishReason = materialized.finishReason
  } else if (type === 'response.failed' || type === 'error') {
    chunks.push({ kind: 'error', message: responseErrorMessage(input.payload), code: 'response_stream_error' })
    finishReason = 'error'
  }
  return { chunks, sawTextDelta: sawText, finishReason, usage }
}

function responseStreamCallId(
  payload: Record<string, unknown>,
  pending: Map<string, PendingToolCall>,
  byIndex: Map<number, string>
): string {
  const explicit = recordString(payload, 'call_id')
  if (explicit) return explicit
  const itemId = recordString(payload, 'item_id')
  if (itemId && pending.has(itemId)) return itemId
  const index = numericIndex(payload.output_index)
  if (index !== undefined) return byIndex.get(index) ?? indexFallbackCallId(index, pending)
  if (pending.size === 1) return [...pending.keys()][0]
  return indexFallbackCallId(undefined, pending)
}

function indexFallbackCallId(index: number | undefined, pending: Map<string, PendingToolCall>): string {
  return index === undefined ? `call_${pending.size + 1}` : `call_${index + 1}`
}

function responseErrorMessage(payload: Record<string, unknown>): string {
  const error = recordValue(payload, 'error') ?? recordValue(recordValue(payload, 'response') ?? {}, 'error')
  return (error ? recordString(error, 'message') : '') || recordString(payload, 'message') ||
    'model stream reported an error'
}

function recordString(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key] : ''
}

function recordValue(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function numericIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}
