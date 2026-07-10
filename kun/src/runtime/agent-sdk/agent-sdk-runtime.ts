/**
 * The subscription engine. When a thread's provider is the `agent-sdk` kind,
 * the agent loop delegates the whole turn here: we drive the official Claude
 * Agent SDK's `query()` (which bills the user's Claude subscription via the
 * bundled Claude Code binary) while injecting kun's brain — persona, exclusive
 * tools, permissions — and re-projecting the SDK's stream onto kun's events.
 *
 * The orchestration depends only on the injected `SdkRuntimeDeps` seam, so it is
 * fully unit-testable with a fake SDK + fake deps. The concrete binding to kun's
 * real services lives in the runtime factory (a thin adapter).
 */
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RuntimeEventDraft } from '../../services/runtime-event-recorder.js'
import type { TurnItem } from '../../contracts/items.js'
import type { ApprovalPolicy, SandboxMode } from '../../contracts/policy.js'
import { SdkEventMapper } from './sdk-event-mapper.js'
import {
  assembleSdkOptions,
  buildCanUseTool,
  type ToolApprovalDecision
} from './sdk-options-builder.js'
import {
  bridgedToolModelNames,
  buildBridgedToolSpecs,
  selectBridgeableTools,
  toSdkMcpServer,
  type BridgeableTool,
  type KunToolResult
} from './sdk-tool-bridge.js'
import { composeSdkPromptText } from './sdk-context-assembler.js'
import type { SdkApi } from './sdk-protocol.js'

export type TurnStatus = 'completed' | 'failed' | 'aborted'

export interface SdkTurnContext {
  /** Workspace root the SDK runs in (cwd). */
  workspace: string
  /** The user's prompt for this turn. */
  userText: string
  /** Thread-level persona appended to the system prompt. */
  threadPersona?: string
  approvalPolicy: ApprovalPolicy
  sandboxMode?: SandboxMode
  planMode?: boolean
  model?: string
  /** Prior SDK session id for multi-turn continuity. */
  resumeSessionId?: string
  /** Subscription OAuth token; absent => rely on the host's Claude Code login. */
  oauthToken?: string
  /** Image attachments to forward to the model (base64 + media type). */
  images?: Array<{ mediaType: string; base64: string }>
  /** kun tool catalog to consider bridging (overlap/excluded are filtered here). */
  bridgeableTools: BridgeableTool[]
  /**
   * Prior-conversation transcript replayed each turn so the model has kun's
   * canonical history (the SDK doesn't see it otherwise). '' / absent => none.
   */
  historyTranscript?: string
  /**
   * Per-turn instruction blocks injected after the history (skill catalog,
   * activated skills, memories, goal/todo continuation, plan instruction).
   * Mirrors the native loop's `contextInstructions`.
   */
  contextInstructions?: string[]
}

/**
 * When the turn has images, the prompt must be a structured user message (text +
 * image content blocks) rather than a plain string. We yield a single message in
 * the SDK's streaming-input form; the generator ending runs exactly one turn.
 */
function userMessageStream(
  text: string,
  images: ReadonlyArray<{ mediaType: string; base64: string }>
): AsyncIterable<unknown> {
  const content: Array<Record<string, unknown>> = []
  if (text.trim()) content.push({ type: 'text', text })
  for (const image of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 }
    })
  }
  const message = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
  return {
    [Symbol.asyncIterator]: async function* () {
      yield message
    }
  }
}

export interface SdkRuntimeDeps {
  /** True when this runtime owns the given provider (kind: 'agent-sdk'). */
  handlesProvider(providerId: string | undefined): boolean
  /** Resolve the turn's inputs; null aborts the turn early (e.g. no user text). */
  loadTurnContext(threadId: string, turnId: string): Promise<SdkTurnContext | null>
  /** Execute a kun tool in-process (raw — permission/hooks handled by the SDK seam).
   *  `signal` aborts in-flight interactive work (e.g. a pending user_input). */
  executeKunTool(
    threadId: string,
    turnId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<KunToolResult>
  /** kun's per-call permission decision (routes to the GUI approval panel). */
  decideToolApproval(
    threadId: string,
    turnId: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolApprovalDecision>
  /** Persist + publish a runtime event (recorder.record). */
  recordEvent(draft: RuntimeEventDraft): Promise<void>
  /** Upsert a turn item into the item store (turns.applyItem). */
  applyItem(threadId: string, item: TurnItem): Promise<void>
  /** Finish the turn lifecycle (turns.finishTurn). */
  finishTurn(threadId: string, turnId: string, status: TurnStatus, error?: string): Promise<void>
  /** Persist the SDK session id on the thread for next-turn resume. */
  saveSessionId(threadId: string, sessionId: string): Promise<void>
  /** Lazy-load the real `@anthropic-ai/claude-agent-sdk`. */
  loadSdk(): Promise<SdkApi>
  /** Base process env to scope for the Claude Code subprocess. */
  baseEnv(): Record<string, string | undefined>
  /** The stable kun system prompt (persona) appended to the claude_code preset. */
  kunSystemPrompt(): string
  /** Monotonic id allocator for assistant items. */
  nextId(prefix: string): string
  /** Runtime turn limits, resolved at the start of each delegated SDK turn. */
  getTurnLimits?(): { maxWallTimeMs?: number } | undefined
  /** Optional explicit path to the bundled Claude Code binary (packaging). */
  pathToClaudeCodeExecutable?: string
}

/** Persist an item only at milestones, not on every streaming delta. */
function shouldPersist(item: TurnItem): boolean {
  return item.status === 'completed' || item.status === 'failed' || item.kind === 'tool_call'
}

function itemOf(draft: RuntimeEventDraft): TurnItem | undefined {
  return 'item' in draft ? (draft.item as TurnItem) : undefined
}

export class AgentSdkRuntime {
  constructor(private readonly deps: SdkRuntimeDeps) {}

  handlesProvider(providerId: string | undefined): boolean {
    return this.deps.handlesProvider(providerId)
  }

  async runTurn(threadId: string, turnId: string, signal: AbortSignal): Promise<TurnStatus> {
    const ctx = await this.deps.loadTurnContext(threadId, turnId)
    if (!ctx) {
      await this.deps.finishTurn(threadId, turnId, 'failed', 'no input for subscription turn')
      return 'failed'
    }

    const mapper = new SdkEventMapper({ threadId, turnId, nextId: (p) => this.deps.nextId(p) })
    const abort = new AbortController()
    const onAbort = (): void => abort.abort()
    const maxWallTimeMs = Math.max(1, Math.floor(this.deps.getTurnLimits?.()?.maxWallTimeMs ?? 15 * 60_000))
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, maxWallTimeMs)
    if (signal.aborted) abort.abort()
    else signal.addEventListener('abort', onAbort, { once: true })

    try {
      const sdk = await this.deps.loadSdk()

      // Bridge kun-exclusive tools into an in-process MCP server.
      const bridged = buildBridgedToolSpecs(selectBridgeableTools(ctx.bridgeableTools), (name, args) =>
        this.deps.executeKunTool(threadId, turnId, name, args, abort.signal)
      )
      const mcpServers = bridged.length ? { kun: toSdkMcpServer(sdk, bridged) } : undefined

      const options = assembleSdkOptions({
        cwd: ctx.workspace,
        kunSystemPrompt: this.deps.kunSystemPrompt(),
        threadPersona: ctx.threadPersona,
        approvalPolicy: ctx.approvalPolicy,
        ...(ctx.sandboxMode ? { sandboxMode: ctx.sandboxMode } : {}),
        // Deliberately NOT mapping kun's plan turn to the SDK's 'plan' permission
        // mode: that mode blocks tool execution, which would also block kun's
        // bridged create_plan tool (the whole point of a plan turn). kun's plan
        // behavior comes from advertising create_plan + the injected plan
        // instruction instead (see resolveTurnPlanContext + contextInstructions).
        bridgedToolModelNames: bridgedToolModelNames(bridged),
        mcpServers,
        canUseTool: buildCanUseTool((name, input) => {
          const sandboxDecision = decideSdkBuiltinSandbox(name, input, ctx)
          if (sandboxDecision) return sandboxDecision
          return this.deps.decideToolApproval(threadId, turnId, name, input, abort.signal)
        }),
        baseEnv: this.deps.baseEnv(),
        oauthToken: ctx.oauthToken,
        abortController: abort,
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
        ...(this.deps.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.deps.pathToClaudeCodeExecutable }
          : {})
      })

      // kun owns canonical history, so each SDK turn is stateless: replay the
      // prior conversation + per-turn instructions as text and end with the live
      // request. (Deliberately NOT using the SDK's `resume` — it's lost on a
      // provider switch or runtime restart; the transcript survives both.)
      const composedText = composeSdkPromptText({
        ...(ctx.historyTranscript ? { historyTranscript: ctx.historyTranscript } : {}),
        userText: ctx.userText,
        ...(ctx.contextInstructions?.length ? { instructionBlocks: ctx.contextInstructions } : {})
      })
      const prompt =
        ctx.images && ctx.images.length > 0
          ? userMessageStream(composedText, ctx.images)
          : composedText
      const stream = sdk.query({ prompt, options })
      for await (const message of stream) {
        if (signal.aborted || abort.signal.aborted) {
          await stream.interrupt?.()
          break
        }
        for (const draft of mapper.map(message)) {
          const item = itemOf(draft)
          if (item && shouldPersist(item)) {
            // applyItem persists the item AND records its own item_created event,
            // so only ALSO record non-item_created signal events (tool_call_ready,
            // tool_call_finished) — never the item_created draft itself, or the
            // item would be published twice.
            await this.deps.applyItem(threadId, item)
            if (draft.kind !== 'item_created') await this.deps.recordEvent(draft)
          } else {
            await this.deps.recordEvent(draft)
          }
        }
      }

      if (timedOut) await stream.interrupt?.()

      const sessionId = mapper.getSessionId()
      if (sessionId) await this.deps.saveSessionId(threadId, sessionId)

      if (signal.aborted) {
        await this.deps.finishTurn(threadId, turnId, 'aborted')
        return 'aborted'
      }
      if (timedOut) {
        const message = `turn exceeded ${maxWallTimeMs}ms wall time`
        await this.deps.recordEvent({
          kind: 'error', threadId, turnId, message, code: 'turn_wall_time_limit', severity: 'warning'
        })
        await this.deps.finishTurn(threadId, turnId, 'failed', message)
        return 'failed'
      }

      const final = mapper.getFinal()
      const status: TurnStatus = final?.status ?? 'completed'
      await this.deps.finishTurn(threadId, turnId, status, final?.message)
      return status
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.deps.recordEvent({ kind: 'error', threadId, turnId, message })
      await this.deps.finishTurn(threadId, turnId, 'failed', message)
      return 'failed'
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

const SDK_COMMAND_TOOLS = new Set(['Bash'])
const SDK_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SDK_READ_PATH_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead'])
const SDK_NON_PATH_TOOLS = new Set(['WebSearch', 'WebFetch', 'TodoWrite'])
const KUN_BRIDGED_TOOL_PREFIX = 'mcp__kun__'

export function decideSdkBuiltinSandbox(
  toolName: string,
  input: Record<string, unknown>,
  context: Pick<SdkTurnContext, 'workspace' | 'sandboxMode'>
): ToolApprovalDecision | null {
  const mode = context.sandboxMode ?? 'danger-full-access'
  if (!isKnownSdkTool(toolName)) {
    return denySandbox(`tool ${toolName} is blocked because it is not in kun's SDK tool allowlist`)
  }
  if (mode === 'danger-full-access') return null

  if (SDK_COMMAND_TOOLS.has(toolName)) {
    return denySandbox(`tool ${toolName} is blocked because the "${mode}" sandbox mode does not run host shell commands`)
  }

  if (SDK_WRITE_TOOLS.has(toolName)) {
    if (mode === 'read-only') return denySandbox(`tool ${toolName} is blocked by the read-only sandbox`)
    if (mode === 'external-sandbox') {
      return denySandbox(`tool ${toolName} is blocked because external-sandbox does not allow SDK file mutation`)
    }
    const path = sdkInputPath(input)
    if (!path) return denySandbox(`tool ${toolName} is blocked because no workspace path was provided`)
    if (!isPathInsideWorkspace(path, context.workspace)) {
      return denySandbox(`tool ${toolName} is limited to the workspace sandbox: ${path}`)
    }
  }

  if (SDK_READ_PATH_TOOLS.has(toolName)) {
    // Glob defaults `path` to the SDK cwd, but its required `pattern` can
    // itself carry an absolute path or `..` traversal. Treat it as a path
    // selector before accepting the otherwise cwd-scoped request.
    if (toolName === 'Glob' && !isWorkspaceGlobPattern(input.pattern)) {
      return denySandbox(`tool ${toolName} is limited to workspace glob patterns`)
    }
    const path = sdkInputPath(input)
    if (!path && toolName === 'Read') {
      return denySandbox(`tool ${toolName} is blocked because no workspace path was provided`)
    }
    if (path && !isPathInsideWorkspace(path, context.workspace)) {
      return denySandbox(`tool ${toolName} is limited to workspace paths: ${path}`)
    }
  }

  return null
}

function denySandbox(message: string): ToolApprovalDecision {
  return { allow: false, message }
}

function isKnownSdkTool(toolName: string): boolean {
  return SDK_COMMAND_TOOLS.has(toolName) ||
    SDK_WRITE_TOOLS.has(toolName) ||
    SDK_READ_PATH_TOOLS.has(toolName) ||
    SDK_NON_PATH_TOOLS.has(toolName) ||
    toolName.startsWith(KUN_BRIDGED_TOOL_PREFIX)
}

function sdkInputPath(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function isWorkspaceGlobPattern(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  const pattern = value.trim()
  // Check both host-native and Windows/UNC absolute forms. A persisted SDK
  // transcript can be replayed on another platform, so native isAbsolute()
  // alone is not sufficient for rejecting a dangerous path selector.
  if (isAbsolute(pattern) || /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(pattern)) return false
  // Glob supports braces, so reject traversal segments both as path components
  // and as alternatives such as `{src,..}`. A literal `foo..bar` remains valid.
  return !/(^|[\\/{,])\.\.(?=$|[\\/},])/.test(pattern)
}

function isPathInsideWorkspace(inputPath: string, workspace: string): boolean {
  const configuredRoot = workspace.trim()
  if (!configuredRoot) return false

  try {
    const lexicalRoot = isAbsolute(configuredRoot)
      ? resolve(configuredRoot)
      : resolve(process.cwd(), configuredRoot)
    const lexicalCandidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(lexicalRoot, inputPath)
    if (!isDescendantOrSame(lexicalRoot, lexicalCandidate)) return false

    // A missing cwd will be rejected by the SDK before any tool executes. Keep
    // the lexical check for that invalid configuration, while requiring real
    // filesystem containment whenever the workspace exists.
    if (!existsSync(lexicalRoot)) return true

    const root = realpathSync(lexicalRoot)
    const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath)
    if (!isDescendantOrSame(root, candidate)) return false

    // `resolve` only proves lexical containment. Resolve the deepest existing
    // parent too, so `/workspace/link/outside.txt` cannot escape through a
    // symlink when the final file does not exist yet.
    const existingParent = deepestExistingParent(candidate)
    return existingParent !== null && isDescendantOrSame(root, existingParent)
  } catch {
    return false
  }
}

function deepestExistingParent(path: string): string | null {
  let probe = path
  const missing: string[] = []
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return null
    missing.unshift(basename(probe))
    probe = parent
  }
  const realParent = realpathSync(probe)
  return missing.length > 0 ? join(realParent, ...missing) : realParent
}

function isDescendantOrSame(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
