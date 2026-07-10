import { describe, expect, it } from 'vitest'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'
import { modelClientDiagnostics } from './model-client-diagnostics.js'

class DiagnosticModel implements ModelClient {
  readonly provider = 'compat-multi'
  readonly model = 'default-model'
  readonly config = {
    baseUrl: 'https://default.example/v1',
    endpointFormat: 'chat_completions',
    model: 'default-model'
  }

  configFor(providerId?: string) {
    if (providerId === 'missing') throw new Error('unknown model provider: missing')
    return this.config
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

describe('modelClientDiagnostics', () => {
  it('does not throw or substitute default endpoint details for an unknown explicit provider', () => {
    expect(modelClientDiagnostics(new DiagnosticModel(), 'missing')).toEqual({
      provider: 'compat-multi'
    })
  })
})
