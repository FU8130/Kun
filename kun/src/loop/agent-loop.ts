import { dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type { ModelClient, ModelRequest, ModelToolSpec } from '../ports/model-client.js'
import type { AgentSdkRuntime } from '../runtime/agent-sdk/agent-sdk-runtime.js'
import type {
  ToolHost,
  ToolCallLike,
  ToolHostContext,
  GuiPlanContext,
  GuiDesignArtifactContext
} from '../ports/tool-host.js'
import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ApprovalGate } from '../ports/approval-gate.js'
import type { UserInputGate } from '../ports/user-input-gate.js'
import type { UsageService } from '../services/usage-service.js'
import { TurnCapacityError, type TurnService, type TurnSettlement } from '../services/turn-service.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { rewriteItemHistoryWithRetry } from '../services/history-commit-coordinator.js'
import { withThreadStoreMutation } from '../services/thread-mutation-coordinator.js'
import type { PipelineStage } from '../contracts/events.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { ImmutablePrefix } from '../cache/immutable-prefix.js'
import type { CacheRequestSignature } from '../cache/cache-diagnostics.js'
import type {
  ModelRoundOutcome,
  ToolDispatchInput,
  ToolDispatchOutcome,
  TurnExecutionFailure,
  TurnExecutionStatus
} from './turn-execution-types.js'
import { ContextCompactor } from './context-compactor.js'
import {
  DESIGN_MODE_INSTRUCTION,
  SVG_ARTIFACT_MODE_INSTRUCTION
} from './design-mode.js'
import {
  effectiveHistoryAfterLatestCompaction,
  placeCompactionsAtTurnEnd
} from './compaction-history.js'
import { generateThreadTitle, resolveRoleModel } from './title-generator.js'
import type { RolesConfig } from '../config/kun-config.js'
import { InflightTracker } from './inflight-tracker.js'
import { SteeringQueue } from './steering-queue.js'
import {
  createImmutablePrefix,
  shouldVerifyImmutablePrefix,
  verifyImmutablePrefix
} from '../cache/immutable-prefix.js'
import {
  detectVolatilePrefixContent,
  type PrefixVolatilityFinding
} from '../cache/prefix-volatility.js'
import { buildToolCatalogFingerprint } from '../cache/tool-catalog-fingerprint.js'
import {
  makeUserItem,
  makeAssistantTextItem,
  makeAssistantReasoningItem,
  makeToolCallItem,
  makeErrorItem
} from '../domain/item.js'
import { touchThread } from '../domain/thread.js'
import { memoryPreview } from '../shared/memory-preview.js'
import { repairModelHistoryItems } from '../domain/model-history-repair.js'
import type { TurnItem } from '../contracts/items.js'
import type { ThreadGoal, ThreadRecord } from '../contracts/threads.js'
import { modelCapabilitiesForModel, type ContextCompactionConfig } from './model-context-profile.js'
import type { SkillRuntime } from '../skills/skill-runtime.js'
import type { InstructionRuntime } from '../instructions/instruction-runtime.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { MemoryStore } from '../memory/memory-store.js'
import type { ArtifactStore } from '../artifacts/artifact-store.js'
import type { ResolvedHook } from '../hooks/hook-engine.js'
import {
  applyTokenEconomyToRequest,
  normalizeTokenEconomyConfig,
  type TokenEconomyConfig
} from './token-economy.js'
import { applyRequestHistoryHygiene } from './request-history-hygiene.js'
import {
  capToolResultImages,
  rehydrateGeneratedImagesForForward,
  MAX_FORWARDED_GENERATED_IMAGES
} from './tool-result-image.js'
import { estimateModelRequestInputTokens } from './model-request-estimator.js'
import { ModelRoutingService } from './model-routing-service.js'
import { HistoryCompactionService } from './history-compaction-service.js'
import { ToolStormBreaker, type ToolStormBreakerOptions } from './tool-storm-breaker.js'
import { healLoadedHistoryItems } from './history-healing.js'
import { LoopTelemetry } from './loop-telemetry.js'
import { ModelRoundEngine } from './model-round-engine.js'
import { modelClientDiagnostics, sanitizeProviderBaseUrl } from './model-client-diagnostics.js'
import { memoryInstructions } from './memory-instructions.js'
import { InteractiveToolBridge } from './interactive-tool-bridge.js'
import { TurnContextResolver, resolveTurnModeContext } from './turn-context-resolver.js'
import { TurnFinalizer, type TurnFinalizationRequest } from './turn-finalizer.js'
import { canUpgradeThreadTitle } from './thread-title-policy.js'
import { normalizeTurnLimits, type TurnLimitsConfig } from './turn-limits.js'
import {
  svgArtifactCompletionState,
  type SvgArtifactCompletionState
} from './svg-artifact-completion.js'
import {
  TurnAttachmentService,
  attachmentRequestPipelineDetails,
  imageGenerationReferenceInstructions
} from './turn-attachment-service.js'
import { createToolExecutionContext } from './tool-context-factory.js'
import { ToolExecutionService } from './tool-execution-service.js'
import { ToolCallDispatcher } from './tool-call-dispatcher.js'
import { CREATE_PLAN_TOOL_NAME } from '../adapters/tool/create-plan-tool.js'
import {
  DESIGN_SVG_ANIMATE_TOOL_NAME,
  DESIGN_SVG_EDIT_TOOL_NAME,
  DESIGN_SVG_VALIDATE_TOOL_NAME
} from '../adapters/tool/design-svg-tool.js'
import { GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME } from '../adapters/tool/goal-tools.js'
import { TODO_LIST_TOOL_NAME, TODO_WRITE_TOOL_NAME } from '../adapters/tool/todo-tools.js'
import { resolveWorkspacePath, shellRuntimeInstruction } from '../adapters/tool/builtin-tool-utils.js'
import { VERIFY_CHANGES_TOOL_NAME } from '../adapters/tool/builtin-verify-tool.js'
import { buildToolPreferenceInstruction } from '../prompt/kun-system-prompt.js'
import {
  GoalResumeCoordinator,
  DEFAULT_MAX_GOAL_RESUME_NO_PROGRESS_ATTEMPTS,
  type GoalResumeCoordinatorDeps
} from './goal-resume-coordinator.js'
import {
  PLAN_MODE_INSTRUCTION,
  isPlanClarifyingQuestion,
  resolvePlanModeToolSpecs,
  turnHasUnverifiedSourceChanges,
  verificationSuggestionInstruction
} from './plan-mode.js'
import {
  runTurnEndLifecycleHooks,
  runTurnStartLifecycleHooks,
  type TurnLifecycleHookDeps
} from './turn-lifecycle-hooks.js'
import {
  buildRuntimeContextInstruction,
  shouldInjectInitialRuntimeContext
} from './runtime-context.js'
import {
  EMPTY_POST_TOOL_MAX_RECOVERY_STEPS,
  GOAL_NO_TOOL_REPEAT_MAX_RECOVERY_STEPS,
  emptyPostToolRecoveryInstruction,
  hasSuccessfulCreatePlanResult,
  isRepeatedNoToolAssistantText,
  latestUserMessageText,
  userInputUnavailableInstruction
} from './continuation-instructions.js'
export {
  PLAN_MODE_INSTRUCTION,
  isPlanClarifyingQuestion,
  isStalePlanContext,
  resolvePlanModeToolSpecs,
  turnHasUnverifiedSourceChanges
} from './plan-mode.js'
export {
  buildRuntimeContextInstruction,
  shouldInjectInitialRuntimeContext
} from './runtime-context.js'
export {
  svgArtifactCompletionState,
  type SvgArtifactCompletionState
} from './svg-artifact-completion.js'
export { canUpgradeThreadTitle } from './thread-title-policy.js'
export { memoryInstructions } from './memory-instructions.js'
export {
  goalContinuationInstruction,
  todoContinuationInstruction
} from './continuation-instructions.js'

// Number of most-recent tool-result screenshots/images kept inline in a
// request. Older ones collapse to a text note (Anthropic-style "keep last
// N images"), bounding context growth for long computer-use sessions.
const MAX_FORWARDED_TOOL_IMAGES = 3
const MAX_SVG_COMPLETION_RECOVERY_STEPS = 3

/**
 * Tools that, on their own, do not count as "progress" toward a goal when
 * deciding whether to keep auto-resuming after a failed goal turn. A turn
 * that only inspects/updates goal state (and then fails) made no real
 * advancement, so it should burn the no-progress budget; a turn that edits
 * files, runs commands, advances todos, etc. resets it.
 */
const GOAL_NON_PROGRESS_TOOL_NAMES = new Set<string>([
  GET_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME
])

/**
 * Prompt seeded into an auto-resumed goal continuation turn. The active-goal
 * continuation instruction is injected separately (the goal is still
 * `active`); this user message just nudges the model to pick the work back up
 * where the interrupted turn left off.
 */
const GOAL_RESUME_PROMPT = [
  'Continue working toward the active goal.',
  'The previous attempt stopped before the goal was complete (it was interrupted, truncated, or the runtime restarted, or it simply stopped early).',
  'Review the current state, pick up where the work left off, and keep going until the goal is genuinely achieved or blocked.'
].join(' ')

/**
 * Stable identity for the resume coordinator. Changing the objective (or
 * starting a brand-new goal) yields a new key, so a pending backoff resume
 * for an old goal is discarded rather than relaunched against the new one.
 */
function goalResumeKey(threadId: string, goal: ThreadGoal): string {
  return `${threadId}::${goal.createdAt}::${goal.objective}`
}

const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  setup: 'Setup',
  pre_start: 'Pre-Start',
  post_start: 'Post-Start',
  input_received: 'Input Received',
  input_cached: 'Input Cached',
  input_routed: 'Input Routed',
  input_compressed: 'Input Compressed',
  input_remembered: 'Input Remembered',
  pre_send: 'Pre-Send',
  post_send: 'Post-Send',
  response_received: 'Response Received'
}

type GoalElapsedTimer = {
  startedAtMs: number
  createdAt: string
  objective: string
}

export type AgentLoopOptions = {
  threadStore: ThreadStore
  sessionStore: SessionStore
  approvalGate: ApprovalGate
  userInputGate: UserInputGate
  model: ModelClient
  toolHost: ToolHost
  usage: UsageService
  events: RuntimeEventRecorder
  turns: TurnService
  inflight: InflightTracker
  steering: SteeringQueue
  compactor: ContextCompactor
  prefix: ImmutablePrefix
  ids: IdGenerator
  nowIso: () => string
  nowMs?: () => number
  modelCapabilities?: (model: string) => ModelCapabilityMetadata
  skillRuntime?: SkillRuntime
  instructionRuntime?: InstructionRuntime
  attachmentStore?: AttachmentStore
  memoryStore?: MemoryStore
  artifactStore?: ArtifactStore
  /** Kun runtime data root for sandbox-safe background shell output reads. */
  runtimeDataDir?: string
  tokenEconomy?: TokenEconomyConfig
  contextCompaction?: ContextCompactionConfig
  /** Internal-LLM role model routing (smallModel slot + title/summary/codeReview overrides). */
  roles?: RolesConfig
  toolStorm?: ToolStormBreakerOptions & { enabled?: boolean }
  turnLimits?: TurnLimitsConfig
  toolArgumentRepair?: {
    maxStringBytes?: number
  }
  /**
   * Tuning + test seams for goal auto-resume (KunAgent/Kun#370). Defaults
   * back off exponentially and bound consecutive no-progress retries; tests
   * inject a synchronous timer and small caps for determinism.
   */
  goalResume?: Pick<
    GoalResumeCoordinatorDeps,
    'setTimer' | 'maxNoProgressAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'log'
  >
  /**
   * Hard allow-list intersected into every tool context for this loop. Used
   * by read-only subagents to clamp the inherited tool host to investigation
   * tools — enforced at both the schema (listTools) and execute layers.
   */
  forcedAllowedToolNames?: readonly string[]
  /**
   * Provider ids hard-blocked for this loop (e.g. a subagent profile's blocked
   * MCP servers, as `mcp:<serverId>`). Deny-list layered on top of inherit and
   * enforced at both the schema and execute layers.
   */
  blockedProviderIds?: readonly string[]
  /**
   * Tool names hard-blocked for this loop (e.g. a subagent profile's blocked
   * built-in tools). Deny-list layered on top of inherit; enforced at both layers.
   */
  blockedToolNames?: readonly string[]
  /**
   * Skill ids hard-blocked for this loop's turns (e.g. a subagent profile's
   * blockedSkills). Hidden from the catalog + auto-activation and rejected by
   * `load_skill`, without mutating the shared skill runtime.
   */
  blockedSkillIds?: readonly string[]
  /**
   * Lifecycle hooks (UserPromptSubmit, TurnStart, TurnEnd, PreCompact).
   * Tool phases are handled by the tool host; the loop ignores them.
   */
  hooks?: readonly ResolvedHook[]
  /**
   * Optional fallback GUI plan context for embedders that run the loop
   * without persisted turn metadata. Normal serve mode reads GUI plan
   * context from the active turn record.
   */
  activePlanContext?: GuiPlanContext
  /**
   * Optional callback to mutate the active plan context (e.g. when the
   * loop records a successful `create_plan` result). The default is a
   * no-op for callers that don't track plan state.
   */
  onActivePlanContextChange?: (context: GuiPlanContext | undefined) => void
  onPlanWritten?: (input: {
    threadId: string
    turnId: string
    planId: string
    relativePath: string
    markdown: string
  }) => Promise<void>
  /**
   * Subscription engine. When set and it owns the active thread's provider
   * (kind: 'agent-sdk'), the entire turn is delegated to the embedded Claude
   * Agent SDK instead of kun's own model loop, billing the user's Claude
   * subscription. kun's tools/persona/permissions are injected into the SDK.
   */
  sdkRuntime?: AgentSdkRuntime
}

/**
 * Cache-first agent loop. The loop:
 * 1. Drains pending steering text and injects it as user messages.
 * 2. Calls the model client with the immutable prefix + compacted history.
 * 3. Streams text, reasoning, and tool-call deltas; emits runtime events.
 * 4. Executes tool calls through the tool host with approval gating.
 * 5. Folds usage/cache telemetry into the per-thread snapshot.
 * 6. Triggers compaction when the history exceeds the soft threshold.
 *
 * The loop is driven by `runTurn(threadId, turnId)` and is fully
 * cancellable through the AbortSignal returned by `getAbortController`.
 */
export class AgentLoop {
  private readonly opts: AgentLoopOptions
  private readonly modelRouting: ModelRoutingService
  private readonly toolStormBreakers = new Map<string, ToolStormBreaker>()
  private readonly telemetry: LoopTelemetry
  private readonly historyCompaction: HistoryCompactionService
  private readonly modelRoundEngine: ModelRoundEngine
  private readonly turnAttachments: TurnAttachmentService
  private readonly turnContextResolver: TurnContextResolver
  private readonly interactiveToolBridge: InteractiveToolBridge
  private readonly toolExecution: ToolExecutionService
  private readonly toolCallDispatcher: ToolCallDispatcher
  private readonly lastNoToolTextByTurn = new Map<string, string>()
  private readonly goalNoToolRecoveryStepsByTurn = new Map<string, number>()
  private readonly emptyPostToolRecoveryStepsByTurn = new Map<string, number>()
  private readonly svgCompletionRecoveryStepsByTurn = new Map<string, number>()
  private readonly turnFailures = new Map<string, TurnExecutionFailure>()
  /** One owned runner per turn; duplicate callers share its terminal result. */
  private readonly activeTurnRuns = new Map<string, Promise<TurnExecutionStatus>>()
  /** Turns that executed at least one real (non-goal-status) tool call. */
  private readonly turnMadeProgress = new Set<string>()
  /**
   * Turns whose stop was a deliberate cap rather than an unfinished-goal
   * interruption (cost-budget exhaustion, or a repetition stall that made no
   * real progress). These must not drive goal auto-resume even though the goal
   * is still `active`.
   */
  private readonly goalResumeSuppressedByTurn = new Set<string>()
  private readonly goalResume: GoalResumeCoordinator

  constructor(opts: AgentLoopOptions) {
    this.opts = opts
    this.telemetry = new LoopTelemetry(opts.sessionStore)
    this.historyCompaction = new HistoryCompactionService({
      sessionStore: opts.sessionStore,
      compactor: opts.compactor,
      prefix: opts.prefix,
      model: opts.model,
      usage: opts.usage,
      events: opts.events,
      ids: opts.ids,
      telemetry: this.telemetry,
      getContextCompaction: () => opts.contextCompaction,
      getHooks: () => opts.hooks,
      clearReadTracker: (threadId?: string) => opts.toolHost.clearReadTracker?.(threadId),
      rewriteThreadItemsFromSession: (threadId) => this.rewriteThreadItemsFromSession(threadId)
    })
    this.turnAttachments = new TurnAttachmentService(opts.attachmentStore)
    this.modelRouting = new ModelRoutingService(opts.model)
    this.modelRoundEngine = new ModelRoundEngine({
      model: opts.model,
      events: opts.events,
      turns: opts.turns,
      usage: opts.usage,
      telemetry: this.telemetry,
      ids: opts.ids,
      recordPipelineStage: (threadId, turnId, stage, details) =>
        this.recordPipelineStage(threadId, turnId, stage, details),
      recordGoalUsage: (threadId, tokens) => this.recordGoalUsage(threadId, tokens),
      rememberFailure: (turnId, failure) => this.rememberTurnFailure(turnId, failure),
      recordToolCallLimit: (threadId, turnId, message) =>
        this.recordTurnLimitExceeded(threadId, turnId, 'tool_call_limit_exceeded', message)
    })
    this.interactiveToolBridge = new InteractiveToolBridge({
      approvalGate: opts.approvalGate,
      userInputGate: opts.userInputGate,
      events: opts.events,
      turns: opts.turns,
      sessionStore: opts.sessionStore,
      nowIso: opts.nowIso
    })
    this.toolExecution = new ToolExecutionService({
      toolHost: opts.toolHost,
      inflight: opts.inflight,
      turns: opts.turns,
      events: opts.events,
      nowIso: opts.nowIso,
      ...(opts.onPlanWritten ? { onPlanWritten: opts.onPlanWritten } : {})
    })
    this.toolCallDispatcher = new ToolCallDispatcher(this.toolExecution)
    this.turnContextResolver = new TurnContextResolver({
      toolHost: opts.toolHost,
      resolveAttachments: (input) => this.turnAttachments.resolveTurnAttachments(input),
      ...(opts.skillRuntime ? { skillRuntime: opts.skillRuntime } : {}),
      ...(opts.instructionRuntime ? { instructionRuntime: opts.instructionRuntime } : {}),
      ...(opts.memoryStore ? { memoryStore: opts.memoryStore } : {}),
      interactiveToolBridge: this.interactiveToolBridge,
      ...(opts.forcedAllowedToolNames ? { forcedAllowedToolNames: opts.forcedAllowedToolNames } : {}),
      ...(opts.blockedProviderIds ? { blockedProviderIds: opts.blockedProviderIds } : {}),
      ...(opts.blockedToolNames ? { blockedToolNames: opts.blockedToolNames } : {}),
      ...(opts.blockedSkillIds ? { blockedSkillIds: opts.blockedSkillIds } : {}),
      ...(opts.runtimeDataDir ? { runtimeDataDir: opts.runtimeDataDir } : {})
    })
    this.goalResume = new GoalResumeCoordinator({
      launch: (threadId) => this.launchGoalResumeTurn(threadId),
      getActiveGoalKey: async (threadId) => {
        const goal = (await this.opts.threadStore.get(threadId))?.goal
        return goal && goal.status === 'active' ? goalResumeKey(threadId, goal) : null
      },
      isThreadBusy: async (threadId) =>
        (await this.opts.threadStore.get(threadId))?.status === 'running',
      ...this.opts.goalResume
    })
  }

  /** Atomically read and update one thread with the services that share this store. */
  private async mutateThread<T>(
    threadId: string,
    operation: (thread: ThreadRecord) => T | Promise<T>
  ): Promise<T | null> {
    return withThreadStoreMutation<T | null>(this.opts.threadStore, threadId, async () => {
      const current = await this.opts.threadStore.get(threadId)
      if (!current) return null
      return operation(current)
    })
  }

  /** Cancel any pending goal auto-resume timers (called on runtime shutdown). */
  shutdownGoalResume(): void {
    this.goalResume.shutdown()
  }

  /**
   * Resume goals stranded by a runtime restart (path A). `threadIds` are the
   * threads whose in-flight turn was just reconciled to `failed`; only those
   * with a still-`active` goal are relaunched, so dormant goals on unrelated
   * threads are never auto-started on boot.
   */
  async resumeInterruptedGoals(threadIds: readonly string[]): Promise<number> {
    let resumed = 0
    for (const threadId of threadIds) {
      if (await this.goalResume.resumeInterrupted(threadId)) resumed += 1
    }
    return resumed
  }

  /**
   * Run a turn end-to-end. The loop returns the final turn status
   * (completed, failed, or aborted). All errors are caught and
   * surfaced through the `error` runtime event.
  */
  runTurn(threadId: string, turnId: string): Promise<TurnExecutionStatus> {
    const key = activeTurnRunKey(threadId, turnId)
    const existing = this.activeTurnRuns.get(key)
    if (existing) return existing
    const run = this.runTurnOwned(threadId, turnId)
    this.activeTurnRuns.set(key, run)
    void run.then(
      () => { if (this.activeTurnRuns.get(key) === run) this.activeTurnRuns.delete(key) },
      () => { if (this.activeTurnRuns.get(key) === run) this.activeTurnRuns.delete(key) }
    )
    return run
  }

  private async runTurnOwned(threadId: string, turnId: string): Promise<TurnExecutionStatus> {
    const finalizer = new TurnFinalizer(this.opts.turns)
    const settle = (input: Omit<TurnFinalizationRequest, 'threadId' | 'turnId'>) =>
      finalizer.settle({ threadId, turnId, ...input })
    const statusFromSettlement = (
      settlement: TurnSettlement,
      fallback: TurnExecutionStatus
    ): TurnExecutionStatus => settlement.kind === 'missing' ? fallback : settlement.status
    const errorFromSettlement = (settlement: TurnSettlement): string | undefined =>
      settlement.kind === 'missing' ? undefined : settlement.error
    const signal = this.opts.turns.getAbortController(turnId)
    if (!signal) {
      const settlement = await settle({ status: 'failed', error: 'no abort controller for turn' })
      return statusFromSettlement(settlement, 'failed')
    }
    if (signal.aborted) {
      const settlement = await settle({ status: 'aborted' })
      return statusFromSettlement(settlement, 'aborted')
    }
    // Subscription engine dispatch: if a Claude Agent SDK runtime owns this
    // thread's provider, delegate the whole turn to it (the SDK runs the loop on
    // the user's subscription; kun's brain is injected). All other providers
    // fall through to kun's native loop below.
    const sdkRuntime = this.opts.sdkRuntime
    let delegatedSdkRuntime: AgentSdkRuntime | undefined
    if (sdkRuntime) {
      const thread = await this.opts.threadStore.get(threadId)
      const turn = thread?.turns.find((candidate) => candidate.id === turnId)
      const providerId = turn?.providerId?.trim() || thread?.providerId?.trim()
      if (sdkRuntime.handlesProvider(providerId)) {
        delegatedSdkRuntime = sdkRuntime
      }
    }
    // The Agent SDK owns its own wall-clock timeout so it can distinguish a
    // runtime deadline from a user cancellation. Starting this native timer
    // for the delegated path races that SDK timer and turns deadline failures
    // into misleading `aborted` turns.
    const maxWallTimeMs = normalizeTurnLimits(this.opts.turnLimits).maxWallTimeMs
    let wallTimeExceeded = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    if (!delegatedSdkRuntime) {
      deadline = setTimeout(() => {
        wallTimeExceeded = true
        this.opts.turns.abortTurnExecution(turnId)
      }, maxWallTimeMs)
      if (typeof (deadline as { unref?: () => void }).unref === 'function') {
        ;(deadline as { unref: () => void }).unref()
      }
    }
    let goalTimer: GoalElapsedTimer | null = null
    let finalStatus: 'completed' | 'failed' | 'aborted' | undefined
    let finalError: string | undefined
    const failWallTimeLimit = async (): Promise<TurnExecutionStatus> => {
      const message = `turn exceeded ${maxWallTimeMs}ms wall time`
      this.rememberTurnFailure(turnId, {
        error: message,
        code: 'turn_wall_time_limit',
        severity: 'warning'
      })
      await this.recordTurnLimitExceeded(threadId, turnId, 'turn_wall_time_limit', message)
      const settlement = await settle({
        status: 'failed',
        error: message,
        code: 'turn_wall_time_limit',
        severity: 'warning'
      })
      finalStatus = statusFromSettlement(settlement, 'failed')
      finalError = errorFromSettlement(settlement)
      return finalStatus
    }
    try {
      goalTimer = await this.startGoalElapsedTimer(threadId)
      await this.recordPipelineStage(threadId, turnId, 'setup')
      if (!delegatedSdkRuntime && this.opts.toolStorm?.enabled !== false) {
        this.toolStormBreakers.set(turnId, new ToolStormBreaker(this.opts.toolStorm))
      }
      await this.recordPipelineStage(threadId, turnId, 'pre_start')
      const denial = await runTurnStartLifecycleHooks(this.lifecycleHookDeps(), { threadId, turnId })
      if (denial) {
        await this.opts.events.record({
          kind: 'error',
          threadId,
          turnId,
          message: denial,
          code: 'hook_denied',
          severity: 'error'
        })
        await this.opts.turns.applyItem(
          threadId,
          makeErrorItem({
            id: this.opts.ids.next('item_error'),
            turnId,
            threadId,
            message: denial,
            code: 'hook_denied',
            severity: 'error'
          })
        )
        const settlement = await settle({ status: 'failed', error: denial })
        finalStatus = statusFromSettlement(settlement, 'failed')
        finalError = errorFromSettlement(settlement)
        return finalStatus
      }
      await this.drainSteering(threadId, turnId, signal)
      await this.recordPipelineStage(threadId, turnId, 'post_start')
      if (delegatedSdkRuntime) {
        const reportedStatus = await delegatedSdkRuntime.runTurn(threadId, turnId, signal)
        const settlement = await finalizer.observeExternal({ threadId, turnId })
        finalStatus = statusFromSettlement(settlement, reportedStatus)
        finalError = errorFromSettlement(settlement)
        if (finalStatus === 'completed') {
          void this.maybeGenerateThreadTitle(threadId, turnId, signal).catch(() => {})
        }
        return finalStatus
      }
      const status = await this.loop(threadId, turnId, signal)
      if (wallTimeExceeded) return failWallTimeLimit()
      const failure = status === 'failed' ? this.turnFailures.get(turnId) : undefined
      const settlement = await settle({
        status,
        ...(failure ?? {})
      })
      finalStatus = statusFromSettlement(settlement, status)
      finalError = errorFromSettlement(settlement)
      if (finalStatus === 'completed') {
        // Fire-and-forget: generate an LLM title after the FIRST assistant
        // reply completes, only when the thread still has a default title.
        void this.maybeGenerateThreadTitle(threadId, turnId, signal).catch(() => {})
      }
      return finalStatus
    } catch (error) {
      if (wallTimeExceeded) return failWallTimeLimit()
      const raw = error instanceof Error ? error.message : String(error)
      // Best-effort enrichment so the renderer can show "what failed where"
      // instead of the bare "Kun turn failed" string. See issue #26.
      const modelInfo = this.opts.model && 'config' in this.opts.model
        ? (this.opts.model as { config: { model?: string; baseUrl?: string } }).config
        : undefined
      const modelName = modelInfo?.model ?? 'unknown'
      const provider = modelInfo?.baseUrl ? sanitizeProviderBaseUrl(modelInfo.baseUrl) : 'unknown'
      const stack = error instanceof Error
        ? (error.stack?.split('\n').slice(0, 3).join(' | ') ?? '')
        : ''
      const message = [
        '[Kun turn failed]',
        `turn=${turnId}`,
        `thread=${threadId}`,
        `model=${modelName}`,
        `provider=${provider}`,
        `error=${raw}`,
        stack ? `stack=${stack}` : ''
      ].filter(Boolean).join(' ')
      const settlement = await settle({ status: 'failed', error: message })
      finalStatus = statusFromSettlement(settlement, 'failed')
      finalError = errorFromSettlement(settlement)
      return finalStatus
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      try {
        // Accounting/resume are post-settlement conveniences. A late store or
        // event failure must not hide an already durable terminal outcome, nor
        // skip the unconditional transient-state cleanup below.
        await this.finishGoalElapsedTimer(threadId, goalTimer).catch(() => undefined)
        // Decide cross-turn goal resume before clearing the per-turn progress
        // marker it reads.
        await this.evaluateGoalResume(threadId, turnId, finalStatus ?? 'failed').catch(() => undefined)
      } finally {
        this.modelRouting.clear(threadId, turnId)
        this.toolStormBreakers.delete(turnId)
        this.lastNoToolTextByTurn.delete(turnId)
        this.goalNoToolRecoveryStepsByTurn.delete(turnId)
        this.turnMadeProgress.delete(turnId)
        this.goalResumeSuppressedByTurn.delete(turnId)
        this.emptyPostToolRecoveryStepsByTurn.delete(turnId)
        this.svgCompletionRecoveryStepsByTurn.delete(turnId)
        this.turnFailures.delete(turnId)
        this.telemetry.clearPromptPressure(threadId)
        await runTurnEndLifecycleHooks(this.lifecycleHookDeps(), {
          threadId,
          turnId,
          status: finalStatus ?? 'failed',
          ...(finalError ? { error: finalError } : {})
        })
      }
    }
  }

  private lifecycleHookDeps(): TurnLifecycleHookDeps {
    return {
      hooks: this.opts.hooks,
      threadStore: this.opts.threadStore,
      turns: this.opts.turns,
      events: this.opts.events,
      ids: this.opts.ids,
      nowIso: this.opts.nowIso
    }
  }

  private async recoverRequiredSvgCompletion(
    threadId: string,
    turnId: string,
    state: SvgArtifactCompletionState
  ): Promise<'continue' | 'failed'> {
    const attempt = (this.svgCompletionRecoveryStepsByTurn.get(turnId) ?? 0) + 1
    this.svgCompletionRecoveryStepsByTurn.set(turnId, attempt)
    const exhausted = attempt >= MAX_SVG_COMPLETION_RECOVERY_STEPS
    const missingCode = state.mutationSucceeded
      ? 'required_svg_validation_missing'
      : 'required_svg_mutation_missing'
    const message = state.mutationSucceeded
      ? `The dedicated SVG artifact turn cannot finish until \`${DESIGN_SVG_VALIDATE_TOOL_NAME}\` succeeds after the last mutation.`
      : [
          'The dedicated SVG artifact turn cannot finish before a structured mutation succeeds.',
          `Call \`${DESIGN_SVG_EDIT_TOOL_NAME}\` or \`${DESIGN_SVG_ANIMATE_TOOL_NAME}\`, then finish with \`${DESIGN_SVG_VALIDATE_TOOL_NAME}\`.`
        ].join(' ')
    const finalMessage = exhausted
      ? `${message} Recovery attempts exhausted.`
      : message
    const code = exhausted ? 'svg_completion_gate_exhausted' : missingCode
    const severity = exhausted ? 'error' as const : 'warning' as const
    if (exhausted) {
      this.rememberTurnFailure(turnId, { error: finalMessage, code, severity })
    }
    await this.opts.events.record({
      kind: 'error', threadId, turnId, message: finalMessage, code, severity
    })
    await this.opts.turns.applyItem(
      threadId,
      makeErrorItem({
        id: this.opts.ids.next('item_error'),
        turnId,
        threadId,
        message: finalMessage,
        code,
        severity
      })
    )
    return exhausted ? 'failed' : 'continue'
  }

  /**
   * After the FIRST assistant reply completes, generate a concise LLM title for
   * the thread — but only when the thread still carries a default/placeholder
   * title (so a user-set or already-generated title is never overwritten) and
   * only on the first completed turn. Model precedence: titleModel -> smallModel
   * -> main conversation model. Persists the title to the thread store and emits
   * a `thread_updated` event so the renderer's list refreshes. Best-effort: any
   * failure is swallowed by the fire-and-forget caller.
   */
  private async maybeGenerateThreadTitle(threadId: string, turnId: string, signal?: AbortSignal): Promise<void> {
    const thread = await this.opts.threadStore.get(threadId)
    if (!thread) return
    // Only on the first completed turn so we don't re-title on every reply.
    const completedTurns = thread.turns.filter((t) => t.status === 'completed').length
    if (completedTurns > 1) return
    if (!canUpgradeThreadTitle(thread)) return

    const items = await this.opts.sessionStore.loadItems(threadId)
    const userText = items.find((item) => item.kind === 'user_message')?.text ?? ''
    if (!userText.trim()) return
    const assistantText = items.find((item) => item.kind === 'assistant_text')?.text

    const resolved = resolveRoleModel({
      roleModel: this.opts.roles?.titleModel,
      roleProviderId: this.opts.roles?.titleProviderId,
      roles: this.opts.roles,
      mainModel: thread.model || this.opts.model.model,
      mainProviderId: thread.providerId
    })
    if (!resolved) return

    const title = await generateThreadTitle({
      threadId,
      turnId,
      modelClient: this.opts.model,
      model: resolved.model,
      ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
      userText,
      ...(assistantText ? { assistantText } : {}),
      ...(this.opts.roles?.titleReasoningEffort
        ? { reasoningEffort: this.opts.roles.titleReasoningEffort }
        : {}),
      ...(signal ? { abortSignal: signal } : {})
    })
    if (!title) return

    // Re-check and persist under the shared mutation lock so a concurrent
    // title/goal/turn update cannot be overwritten by this delayed model call.
    const updated = await this.mutateThread(threadId, async (latest) => {
      if (!canUpgradeThreadTitle(latest)) return null
      // Keep titleAuto:true — the LLM title is still auto-generated, so a later
      // user rename can still lock it, but we won't re-title (gated by turn count).
      const next = touchThread({ ...latest, title, titleAuto: true }, this.opts.nowIso())
      await this.opts.threadStore.upsert(next)
      return next
    })
    if (!updated) return
    await this.opts.events.record({
      kind: 'thread_updated',
      threadId,
      title: updated.title,
      titleAuto: true,
      status: updated.status
    })
  }

  private rememberTurnFailure(turnId: string, failure: TurnExecutionFailure): void {
    if (!failure.error.trim()) return
    this.turnFailures.set(turnId, failure)
  }

  private nowMs(): number {
    return this.opts.nowMs?.() ?? Date.now()
  }

  private async startGoalElapsedTimer(threadId: string): Promise<GoalElapsedTimer | null> {
    const thread = await this.opts.threadStore.get(threadId)
    const goal = thread?.goal
    if (!goal || goal.status !== 'active') return null
    return {
      startedAtMs: this.nowMs(),
      createdAt: goal.createdAt,
      objective: goal.objective
    }
  }

  private async finishGoalElapsedTimer(
    threadId: string,
    timer: GoalElapsedTimer | null
  ): Promise<void> {
    if (!timer) return
    const elapsedSeconds = Math.floor(Math.max(0, this.nowMs() - timer.startedAtMs) / 1000)
    if (elapsedSeconds <= 0) return

    const goal = await this.mutateThread(threadId, async (current) => {
      const currentGoal = current.goal
      if (!currentGoal) return null
      if (currentGoal.createdAt !== timer.createdAt || currentGoal.objective !== timer.objective) {
        return null
      }

      const now = this.opts.nowIso()
      const next: ThreadGoal = {
        ...currentGoal,
        timeUsedSeconds: (currentGoal.timeUsedSeconds ?? 0) + elapsedSeconds,
        updatedAt: now
      }
      await this.opts.threadStore.upsert(touchThread({ ...current, goal: next }, now))
      return next
    })
    if (!goal) return
    await this.opts.events.record({
      kind: 'goal_updated',
      threadId,
      goal
    })
  }

  /**
   * Decide whether to auto-resume the goal after a turn settles (path B).
   *
   * A goal still `active` once the turn ends means the model never marked it
   * complete or blocked, so the objective is unfinished and nothing is running
   * (KunAgent/Kun#370). Mirroring codex's idle-relaunch-while-active policy, we
   * drive a fresh continuation turn — routed through the backoff coordinator —
   * not only after a `failed` turn (error / step-budget) but also after a
   * `completed` turn that left the goal active (e.g. the model stopped early or
   * its output was truncated). Without this, such a clean stop stranded the
   * goal with the banner still showing "in progress" until the user nudged it.
   *
   * Deliberate stops are never relaunched: a plan turn, a user interrupt or
   * shutdown (`aborted`), and the caps that set `goalResumeSuppressedByTurn`
   * (cost-budget exhaustion, or a repetition stall that made no real progress
   * — relaunching those would just re-hit the budget or reproduce the filler).
   * A repetition stall that *did* make progress first (e.g. edited files, then
   * trailed off) is not suppressed: it resumes like any other unfinished turn.
   * When the consecutive no-progress budget is exhausted the goal is moved to
   * `blocked` so the banner reflects reality.
   */
  private async evaluateGoalResume(
    threadId: string,
    turnId: string,
    finalStatus: 'completed' | 'failed' | 'aborted'
  ): Promise<void> {
    const thread = await this.opts.threadStore.get(threadId)
    const goal = thread?.goal
    if (!thread || !goal || goal.status !== 'active') {
      this.goalResume.clear(threadId)
      return
    }
    const turn = thread.turns.find((t) => t.id === turnId)
    const wasPlanTurn = turn?.mode === 'plan' || Boolean(turn?.guiPlan)
    const deliberateStop = this.goalResumeSuppressedByTurn.has(turnId)
    if (finalStatus === 'aborted' || wasPlanTurn || deliberateStop) {
      this.goalResume.clear(threadId)
      return
    }
    const outcome = this.goalResume.noteGoalTurnSettled({
      threadId,
      goalKey: goalResumeKey(threadId, goal),
      madeProgress: this.turnMadeProgress.has(turnId)
    })
    if (outcome === 'exhausted') {
      await this.transitionGoalStatus(
        threadId,
        turnId,
        'blocked',
        `Goal auto-resume stopped: ${DEFAULT_MAX_GOAL_RESUME_NO_PROGRESS_ATTEMPTS} consecutive attempts made no progress. Set the goal active again to retry.`
      )
    }
  }

  /** Start and drive a fresh continuation turn for the thread's active goal. */
  private async launchGoalResumeTurn(threadId: string): Promise<void> {
    const thread = await this.opts.threadStore.get(threadId)
    const goal = thread?.goal
    if (!thread || !goal || goal.status !== 'active') return
    // Inherit headless/IM gating from the most recent turn so a resumed turn
    // doesn't deadlock awaiting user input that will never arrive.
    const lastTurn = thread.turns[thread.turns.length - 1]
    let started
    try {
      started = await this.opts.turns.startTurn({
        threadId,
        request: {
          prompt: GOAL_RESUME_PROMPT,
          mode: 'agent',
          ...(lastTurn?.disableUserInput ? { disableUserInput: true } : {})
        }
      })
    } catch (error) {
      if (error instanceof TurnCapacityError) {
        this.goalResume.defer(threadId)
        return
      }
      throw error
    }
    await this.opts.events.record({
      kind: 'error',
      threadId,
      turnId: started.turnId,
      message: 'Auto-resuming the active goal after an interrupted turn.',
      code: 'goal_auto_resume',
      severity: 'warning'
    })
    // Fire-and-forget: the new turn drives its own lifecycle and re-enters
    // evaluateGoalResume when it settles.
    void this.runTurn(threadId, started.turnId)
  }

  /** Move a goal out of `active` (e.g. to `blocked`) and surface why. */
  private async transitionGoalStatus(
    threadId: string,
    turnId: string,
    status: ThreadGoal['status'],
    message?: string
  ): Promise<void> {
    const next = await this.mutateThread(threadId, async (current) => {
      const goal = current.goal
      if (!goal || goal.status === status) return null
      const now = this.opts.nowIso()
      const updated: ThreadGoal = { ...goal, status, updatedAt: now }
      await this.opts.threadStore.upsert(touchThread({ ...current, goal: updated }, now))
      return updated
    })
    if (!next) return
    await this.opts.events.record({ kind: 'goal_updated', threadId, goal: next })
    if (message) {
      await this.opts.events.record({
        kind: 'error',
        threadId,
        turnId,
        message,
        code: 'goal_auto_resume_exhausted',
        severity: 'warning'
      })
    }
  }

  private async drainSteering(threadId: string, turnId: string, signal: AbortSignal): Promise<void> {
    const pending = this.opts.steering.drain(turnId)
    if (pending.length === 0) return
    for (const entry of pending) {
      const item = makeUserItem({
        id: this.opts.ids.next('item_steered'),
        turnId,
        threadId,
        text: entry.text,
        ...(entry.displayText ? { displayText: entry.displayText } : {}),
        ...(entry.messageSource ? { messageSource: entry.messageSource } : {})
      })
      await this.opts.turns.applyItem(threadId, item)
    }
    void signal
  }

  private async loop(
    threadId: string,
    turnId: string,
    signal: AbortSignal
  ): Promise<TurnExecutionStatus> {
    const limits = normalizeTurnLimits(this.opts.turnLimits)
    const startedAt = this.opts.nowMs?.() ?? Date.now()
    for (let step = 0; ; step += 1) {
      if (signal.aborted) return 'aborted'
      if (step >= limits.maxSteps) {
        await this.recordTurnLimitExceeded(threadId, turnId, 'turn_step_limit', `turn exceeded ${limits.maxSteps} model steps`)
        return 'failed'
      }
      if ((this.opts.nowMs?.() ?? Date.now()) - startedAt >= limits.maxWallTimeMs) {
        await this.recordTurnLimitExceeded(threadId, turnId, 'turn_wall_time_limit', `turn exceeded ${limits.maxWallTimeMs}ms wall time`)
        return 'failed'
      }
      await this.drainSteering(threadId, turnId, signal)
      const stepResult = await this.modelStep(threadId, turnId, signal, step, limits.maxToolCallsPerStep)
      if (stepResult === 'stop') return 'completed'
      if (stepResult === 'failed') return 'failed'
      if (stepResult === 'aborted') return 'aborted'
    }
  }

  private async recordTurnLimitExceeded(
    threadId: string,
    turnId: string,
    code: 'turn_step_limit' | 'turn_wall_time_limit' | 'tool_call_limit_exceeded',
    message: string
  ): Promise<void> {
    await this.opts.events.record({ kind: 'error', threadId, turnId, message, code, severity: 'warning' })
  }

  private async modelStep(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    stepIndex = 0,
    maxToolCallsPerStep = normalizeTurnLimits(this.opts.turnLimits).maxToolCallsPerStep
  ): Promise<ModelRoundOutcome> {
    if (shouldVerifyImmutablePrefix()) {
      verifyImmutablePrefix(this.opts.prefix)
    }
    const [thread, turn] = await Promise.all([
      this.opts.threadStore.get(threadId),
      this.opts.turns.getTurn(threadId, turnId)
    ])
    // A delete/interrupt can win while a model step is waiting for its prior
    // I/O. Do not fall back to empty workspace/default settings: that would
    // let a stale continuation issue a new request or dispatch a tool after
    // its owning thread/turn no longer exists.
    if (signal.aborted || !thread || !turn) return 'aborted'
    const modeContext = resolveTurnModeContext({
      turn,
      workspace: thread.workspace,
      threadMode: thread.mode,
      ...(this.opts.activePlanContext ? { fallbackPlanContext: this.opts.activePlanContext } : {})
    })
    const { dedicatedSvgTurn, activePlanContext } = modeContext
    await this.recordPipelineStage(threadId, turnId, 'input_received', { stepIndex })
    const budgetGate = await this.checkBudgetGate(thread, threadId, turnId)
    if (budgetGate === 'blocked') {
      // A cost-budget stop is a deliberate cap, not an interrupted goal turn:
      // suppress goal auto-resume so it isn't relaunched straight back into
      // the same exhausted budget.
      this.goalResumeSuppressedByTurn.add(turnId)
      if (dedicatedSvgTurn) {
        const persistedCompletion = svgArtifactCompletionState(
          await this.opts.sessionStore.loadItems(threadId),
          turnId
        )
        if (persistedCompletion.validationAfterMutation) return 'stop'
        this.rememberTurnFailure(turnId, {
          error: 'Dedicated SVG artifact turn could not satisfy its completion gate before the budget was exhausted.',
          code: 'svg_completion_budget_blocked',
          severity: 'error'
        })
        return 'failed'
      }
      return 'stop'
    }
    const loadedItems = await this.opts.sessionStore.loadItems(threadId)
    // Heal (and possibly rewrite) on-disk history once per turn: within a
    // turn the loop only appends well-formed items, and healing's deep
    // change detection costs two full-history stringifies per call.
    let historyItems: TurnItem[] = loadedItems
    if (stepIndex === 0) {
      const healing = await rewriteItemHistoryWithRetry({
        sessionStore: this.opts.sessionStore,
        threadId,
        maxAttempts: 2,
        build: (snapshot) => {
          const healed = healLoadedHistoryItems(snapshot.items)
          return { changed: healed.changed, items: healed.items, value: undefined }
        }
      })
      if (healing.status === 'applied') {
        await this.rewriteThreadItemsFromSession(threadId)
        historyItems = healing.items
      } else if (healing.status === 'unchanged') {
        historyItems = healing.items
      } else {
        // A later step will retry persistence. Use a locally healed view now
        // rather than letting one malformed legacy record poison this request.
        historyItems = healLoadedHistoryItems(
          await this.opts.sessionStore.loadItems(threadId)
        ).items
      }
    }
    await this.recordPipelineStage(
      threadId,
      turnId,
      'input_cached',
      prefixVolatilityStageDetails(detectVolatilePrefixContent(this.opts.prefix))
    )
    if (stepIndex > 0) {
      const toolResultCount = historyItems.filter(
        (item) => item.turnId === turnId && item.kind === 'tool_result'
      ).length
      await this.opts.events.record({
        kind: 'tool_result_upload_wait',
        threadId,
        turnId,
        status: 'waiting',
        toolResultCount
      })
    }
    const items = repairModelHistoryItems(
      effectiveHistoryAfterLatestCompaction(historyItems)
    )
    const providerId = turn?.providerId?.trim() || thread?.providerId?.trim()
    const modelRoute = await this.modelRouting.resolve({
      threadId,
      turnId,
      latestRequest: turn?.prompt ?? '',
      items,
      signal,
      ...(providerId ? { providerId } : {}),
      reasoningEffort: turn?.reasoningEffort,
      candidates: [turn?.model, thread?.model, this.opts.model.model]
    })
    await this.recordPipelineStage(threadId, turnId, 'input_routed', {
      model: modelRoute.model,
      ...(modelRoute.reasoningEffort ? { reasoningEffort: modelRoute.reasoningEffort } : {})
    })
    const model = modelRoute.model
    const modelCapabilities = this.opts.modelCapabilities?.(model) ?? modelCapabilitiesForModel(model)
    const prepared = await this.turnContextResolver.resolve({
      threadId,
      turnId,
      thread,
      turn,
      history: historyItems,
      model,
      modelCapabilities,
      signal,
      mode: modeContext,
      goalNoToolRecoverySteps: this.goalNoToolRecoveryStepsByTurn.get(turnId) ?? 0
    })
    const {
      mode: effectiveMode,
      approvalPolicy,
      sandboxMode,
      attachments,
      skillResolution,
      instructionResolution,
      memories,
      activeGoalInstruction,
      goalRecoveryInstruction,
      activeTodoInstruction,
      planTurnActive,
      allowedToolNames,
      userInputDisabled,
      toolDiscoveryContext: toolContext,
      tools
    } = prepared
    if (dedicatedSvgTurn) {
      const toolNames = new Set(tools.map((tool) => tool.name))
      const hasMutationTool = toolNames.has(DESIGN_SVG_EDIT_TOOL_NAME) || toolNames.has(DESIGN_SVG_ANIMATE_TOOL_NAME)
      const hasValidationTool = toolNames.has(DESIGN_SVG_VALIDATE_TOOL_NAME)
      const completionAlreadySatisfied = svgArtifactCompletionState(historyItems, turnId).validationAfterMutation
      if (!completionAlreadySatisfied && (approvalPolicy === 'never' || !hasMutationTool || !hasValidationTool)) {
        const message = approvalPolicy === 'never'
          ? 'Dedicated SVG artifact turns require tool execution, but the current approval policy disables tools.'
          : 'Dedicated SVG artifact tools are unavailable under the current plan, skill, or sandbox policy.'
        this.rememberTurnFailure(turnId, { error: message, code: 'svg_tools_unavailable', severity: 'error' })
        await this.opts.events.record({
          kind: 'error', threadId, turnId, message, code: 'svg_tools_unavailable', severity: 'error'
        })
        await this.opts.turns.applyItem(threadId, makeErrorItem({
          id: this.opts.ids.next('item_error'), turnId, threadId, message,
          code: 'svg_tools_unavailable', severity: 'error'
        }))
        return 'failed'
      }
    }
    const toolSpecs: ModelToolSpec[] = [...tools]
    const toolProviderMetadata = new Map(
      tools.map((tool) => [tool.name, { providerId: tool.providerId, providerKind: tool.providerKind }])
    )
    const streamToolMetadata = new Map(
      tools.map((tool) => [tool.name, { providerId: tool.providerId, toolKind: tool.toolKind }])
    )
    const toolCatalog = buildToolCatalogFingerprint(toolSpecs)
    const toolCatalogDrift = this.telemetry.recordToolCatalogFingerprint({
      threadId,
      workspace: thread?.workspace ?? '',
      mode: effectiveMode ?? 'agent',
      model: modelCapabilities.id,
      activeSkillIds: skillResolution.activeSkillIds,
      allowedToolNames,
      userInputDisabled,
      guiDesignCanvas: turn?.guiDesignCanvas === true,
      guiDesignMode: turn?.guiDesignMode === true,
      guiDesignArtifact: turn?.guiDesignArtifact,
      fingerprint: toolCatalog.fingerprint,
      toolNames: toolCatalog.toolNames,
      toolHashes: toolCatalog.toolHashes
    })
    const toolCatalogDriftMessage = toolCatalogDrift.kind !== 'none'
      ? buildToolCatalogDriftMessage(toolCatalog, toolCatalogDrift.kind)
      : undefined
    if (toolCatalogDrift.kind !== 'none' && toolCatalogDriftMessage) {
      await this.recordToolCatalogDrift({
        threadId,
        turnId,
        fingerprint: toolCatalog.fingerprint,
        toolCount: toolCatalog.toolCount,
        toolNames: toolCatalog.toolNames,
        changeKind: toolCatalogDrift.kind,
        message: toolCatalogDriftMessage
      })
    }
    if (turn) {
      await this.opts.turns.updateTurnMetadata(threadId, turnId, {
        activeSkillIds: skillResolution.activeSkillIds,
        skillInjectionBytes: skillResolution.injectedBytes,
        injectedMemoryIds: memories.map((memory) => memory.id),
        injectedMemorySummaries: memories.map((memory) => ({
          id: memory.id,
          content: memoryPreview(memory.content)
        })),
        injectedInstructionSources: instructionResolution.sources,
        instructionInjectionBytes: instructionResolution.injectedBytes,
        toolCatalogFingerprint: toolCatalog.fingerprint,
        toolCatalogToolCount: toolCatalog.toolCount,
        toolCatalogDrift: toolCatalogDrift.kind !== 'none'
      })
    }
    if (toolCatalogDrift.kind === 'breaking') {
      if (dedicatedSvgTurn && !svgArtifactCompletionState(historyItems, turnId).validationAfterMutation) {
        this.rememberTurnFailure(turnId, {
          error: 'The SVG tool catalog changed before the required mutation and validation completed.',
          code: 'svg_tool_catalog_changed',
          severity: 'error'
        })
        return 'failed'
      }
      return 'stop'
    }
    const toolKinds = new Map(toolSpecs.map((tool) => [tool.name, tool.toolKind]))
    const createPlanSatisfied = planTurnActive
      ? hasSuccessfulCreatePlanResult(historyItems, turnId)
      : false
    const svgCompletion = turn?.guiDesignArtifact?.kind === 'svg'
      ? svgArtifactCompletionState(historyItems, turnId)
      : null
    const requiredToolName =
      planTurnActive &&
      !createPlanSatisfied &&
      toolSpecs.some((tool) => tool.name === CREATE_PLAN_TOOL_NAME)
        ? CREATE_PLAN_TOOL_NAME
        : svgCompletion?.mutationSucceeded &&
            !svgCompletion.validationAfterMutation &&
            toolSpecs.some((tool) => tool.name === DESIGN_SVG_VALIDATE_TOOL_NAME)
          ? DESIGN_SVG_VALIDATE_TOOL_NAME
          : undefined
    const suggestVerification =
      !planTurnActive &&
      toolSpecs.some((tool) => tool.name === VERIFY_CHANGES_TOOL_NAME) &&
      turnHasUnverifiedSourceChanges(historyItems, turnId)
    const effectiveToolSpecs = resolvePlanModeToolSpecs(toolSpecs, {
      planTurnActive,
      createPlanSatisfied,
      stepIndex
    })
    const history = await this.historyCompaction.compactIfNeeded({
      items,
      model,
      signal,
      threadId,
      turnId,
      toolSpecs: effectiveToolSpecs
    })
    if (signal.aborted) return 'aborted'
    await this.recordPipelineStage(threadId, turnId, 'input_compressed', {
      historyItems: history.length
    })
    // Forward the just-generated image(s) back to a vision-capable model so it can
    // self-review and regenerate if the result is off. Bytes come from the
    // already-persisted attachment/file; the persisted tool output keeps NO base64
    // (only this transient request copy carries it).
    const forwardHistory = await rehydrateGeneratedImagesForForward(
      history,
      (output) => this.turnAttachments.resolveGeneratedImageForForward(output, threadId, thread?.workspace),
      MAX_FORWARDED_GENERATED_IMAGES
    )
    const runtimeContextInstruction = shouldInjectInitialRuntimeContext({
      stepIndex,
      turnId,
      historyItems
    })
      ? buildRuntimeContextInstruction({
          workspace: thread?.workspace,
          nowIso: this.opts.nowIso()
        })
      : null
    const toolPreferenceInstruction = buildToolPreferenceInstruction(tools)
    const contextInstructions = [
      ...(runtimeContextInstruction ? [runtimeContextInstruction] : []),
      ...(instructionResolution.instruction ? [instructionResolution.instruction] : []),
      ...(activeGoalInstruction ? [activeGoalInstruction] : []),
      ...(goalRecoveryInstruction && (this.goalNoToolRecoveryStepsByTurn.get(turnId) ?? 0) > 0
        ? [goalRecoveryInstruction]
        : []),
      ...(activeTodoInstruction ? [activeTodoInstruction] : []),
      ...((this.emptyPostToolRecoveryStepsByTurn.get(turnId) ?? 0) > 0
        ? [emptyPostToolRecoveryInstruction()]
        : []),
      ...imageGenerationReferenceInstructions({
        imageAttachments: attachments.imageAttachments,
        textFallbacks: attachments.textFallbacks,
        workspace: thread?.workspace ?? '',
        tools: effectiveToolSpecs
      }),
      ...memoryInstructions(memories),
      ...(skillResolution.catalogInstruction ? [skillResolution.catalogInstruction] : []),
      ...skillResolution.instructions,
      ...(userInputDisabled ? [userInputUnavailableInstruction()] : []),
      ...(toolPreferenceInstruction ? [toolPreferenceInstruction] : []),
      ...(effectiveToolSpecs.some((tool) => tool.name === 'bash') ? [shellRuntimeInstruction()] : []),
      ...(suggestVerification ? [verificationSuggestionInstruction()] : []),
      ...(toolCatalogDriftMessage ? [toolCatalogDriftMessage] : [])
    ]
    await this.recordPipelineStage(threadId, turnId, 'input_remembered', {
      memoryCount: memories.length,
      contextInstructionCount: contextInstructions.length
    })
    const tokenEconomy = normalizeTokenEconomyConfig(this.opts.tokenEconomy)
    const modeInstruction = [
      ...(planTurnActive ? [PLAN_MODE_INSTRUCTION] : []),
      ...(turn?.guiDesignArtifact?.kind === 'svg'
        ? [SVG_ARTIFACT_MODE_INSTRUCTION]
        : turn?.guiDesignMode
          ? [DESIGN_MODE_INSTRUCTION]
          : [])
    ].join('\n\n')
    const baseRequest: ModelRequest = {
      threadId,
      turnId,
      model,
      ...(providerId ? { providerId } : {}),
      // Thread-level systemPrompt (primary-agent persona snapshot) is
      // appended to the runtime base — same augment strategy as child agents
      // (child-agent-executor) — so the agent keeps kun's tool/safety
      // conventions and skill catalog instead of losing them to the persona.
      // Empty/whitespace falls back to the immutable prefix verbatim so
      // unbound threads keep the prompt-cache fingerprint.
      systemPrompt: thread?.systemPrompt?.trim()
        ? `${this.opts.prefix.systemPrompt}\n\n${thread.systemPrompt.trim()}`
        : this.opts.prefix.systemPrompt,
      ...(modeInstruction ? { modeInstruction } : {}),
      ...(contextInstructions.length ? { contextInstructions } : {}),
      prefix: this.opts.prefix.fewShots,
      history: capToolResultImages(forwardHistory, MAX_FORWARDED_TOOL_IMAGES),
      ...(attachments.imageAttachments.length ? { attachments: [...attachments.imageAttachments] } : {}),
      ...(attachments.textFallbacks.length ? { attachmentTextFallbacks: [...attachments.textFallbacks] } : {}),
      ...(attachments.documents.length ? { attachmentDocuments: [...attachments.documents] } : {}),
      tools: effectiveToolSpecs,
      ...(requiredToolName ? { requiredToolName } : {}),
      ...(modelRoute.reasoningEffort ? { reasoningEffort: modelRoute.reasoningEffort } : {}),
      abortSignal: signal
    }
    const rawInputTokens = tokenEconomy.enabled
      ? estimateModelRequestInputTokens(baseRequest)
      : 0
    const economyRequest = applyTokenEconomyToRequest(baseRequest, tokenEconomy)
    const request: ModelRequest = {
      ...economyRequest,
      history: applyRequestHistoryHygiene(economyRequest.history, tokenEconomy.historyHygiene, {
        currentTurnId: turnId
      })
    }
    const inputTokens = estimateModelRequestInputTokens(request)
    const outputTokens = modelCapabilities.maxOutputTokens ?? 0
    // A configured model context window is authoritative. ContextCompactor's
    // test/embedding thresholds can intentionally be much smaller than a real
    // model window to exercise compaction, so use its cap only when capability
    // metadata is unavailable.
    const hardCap = modelCapabilities.contextWindowTokens
      ? Math.floor(modelCapabilities.contextWindowTokens * 0.85)
      : this.opts.compactor.hardCap(model)
    if (inputTokens + outputTokens > hardCap) {
      await this.opts.events.record({
        kind: 'error',
        threadId,
        turnId,
        message: `request exceeds the ${hardCap}-token context cap (${inputTokens} input + ${outputTokens} output budget)`,
        code: 'context_window_exceeded',
        severity: 'warning'
      })
      return 'failed'
    }
    if (tokenEconomy.enabled) {
      await this.recordTokenEconomySavings({
        threadId,
        turnId,
        model,
        rawInputTokens,
        sentInputTokens: estimateModelRequestInputTokens(request)
      })
    }
    const clientDiagnostics = modelClientDiagnostics(this.opts.model, request.providerId)
    const cacheSignature: CacheRequestSignature = {
      model: request.model,
      providerId: request.providerId?.trim() || clientDiagnostics.provider || 'default',
      endpointFormat: clientDiagnostics.endpointFormat || 'unknown',
      prefixFingerprint: this.opts.prefix.fingerprint,
      toolCatalogFingerprint: toolCatalog.fingerprint,
      activeSkillIds: skillResolution.activeSkillIds
    }
    const streamed = await this.modelRoundEngine.run({
      threadId,
      turnId,
      signal,
      request,
      maxToolCallsPerStep,
      streamToolMetadata,
      ...(this.opts.toolArgumentRepair?.maxStringBytes !== undefined
        ? { maxToolArgumentStringBytes: this.opts.toolArgumentRepair.maxStringBytes }
        : {}),
      cacheSignature,
      preSendDetails: {
        model: request.model,
        ...clientDiagnostics,
        historyItems: request.history.length,
        toolCount: request.tools.length,
        ...(request.requiredToolName ? { requiredToolName: request.requiredToolName } : {}),
        ...attachmentRequestPipelineDetails({
          attachmentIds: turn?.attachmentIds ?? [],
          imageAttachments: attachments.imageAttachments,
          textFallbacks: attachments.textFallbacks,
          documents: attachments.documents,
          modelCapabilities
        })
      },
      postSendDetails: {
        model: request.model,
        ...clientDiagnostics
      },
      writeGeneratedImage: async ({ imageBase64 }) => {
        const imgDir = '.deepseekgui-images'
        const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
        const fileName = `img-${stamp}-${randomBytes(2).toString('hex')}.png`
        const relativePath = `${imgDir}/${fileName}`
        const target = await resolveWorkspacePath(relativePath, toolContext, {
          enforceWorkspaceBoundary: true
        })
        await mkdir(dirname(target.absolutePath), { recursive: true })
        const absolutePath = (await resolveWorkspacePath(relativePath, toolContext, {
          enforceWorkspaceBoundary: true
        })).absolutePath
        await writeFile(absolutePath, Buffer.from(imageBase64, 'base64'))
        return { markdown: `\n![generated image](${relativePath})\n` }
      }
    })
    if (streamed.kind === 'aborted') return 'aborted'
    if (streamed.kind === 'failed') return 'failed'
    const streamSnapshot = streamed.snapshot
    const completedToolCalls = [...streamSnapshot.toolCalls]
    if (completedToolCalls.length === 0) {
      if (svgCompletion && !svgCompletion.validationAfterMutation) {
        return this.recoverRequiredSvgCompletion(threadId, turnId, svgCompletion)
      }
      if (request.requiredToolName) {
        if (
          request.requiredToolName === CREATE_PLAN_TOOL_NAME &&
          streamSnapshot.text.trim()
        ) {
          // The model asked the user to decide instead of producing a plan
          // (ambiguous request). Don't materialize a question into a bogus
          // plan — end the turn so the user can answer; the next plan turn
          // produces a real plan once the scope is settled.
          if (isPlanClarifyingQuestion(streamSnapshot.text)) {
            return 'stop'
          }
          const callId = this.opts.ids.next('call_plan')
          const provider = toolProviderMetadata.get(CREATE_PLAN_TOOL_NAME)
          const toolKind = toolKinds.get(CREATE_PLAN_TOOL_NAME)
          const sourceRequest = activePlanContext?.sourceRequest ||
            latestUserMessageText(historyItems, turnId) ||
            turn?.prompt ||
            ''
          const argumentsForFallback: Record<string, unknown> = activePlanContext
            ? {
                markdown: streamSnapshot.text.trim(),
                operation: activePlanContext.operation,
                plan_id: activePlanContext.planId,
                plan_relative_path: activePlanContext.relativePath,
                ...(sourceRequest ? { source_request: sourceRequest } : {}),
                ...(activePlanContext.title ? { title: activePlanContext.title } : {})
              }
            : {
                markdown: streamSnapshot.text.trim(),
                operation: 'draft',
                ...(sourceRequest ? { source_request: sourceRequest } : {})
              }
          const call: ToolCallLike = {
            callId,
            toolName: CREATE_PLAN_TOOL_NAME,
            ...(provider?.providerId ? { providerId: provider.providerId } : {}),
            toolKind,
            arguments: argumentsForFallback
          }
          const itemId = `item_tool_${turnId}_${callId}`
          await this.opts.turns.applyItem(
            threadId,
            makeToolCallItem({
              id: itemId,
              turnId,
              threadId,
              callId,
              toolName: CREATE_PLAN_TOOL_NAME,
              toolKind,
              arguments: argumentsForFallback,
              summary: 'Materialized assistant plan text into the required GUI plan.'
            })
          )
          await this.opts.events.record({
            kind: 'tool_call_ready',
            threadId,
            turnId,
            itemId,
            callId,
            toolName: CREATE_PLAN_TOOL_NAME,
            readyCount: 1
          })
          const dispatched = await this.dispatchToolCalls({
            calls: [call],
            threadId,
            turnId,
            workspace: thread?.workspace ?? '',
            threadMode: effectiveMode,
            activePlanContext,
            guiDesignCanvas: turn?.guiDesignCanvas === true,
            guiDesignMode: turn?.guiDesignMode === true,
            guiDesignArtifact: turn?.guiDesignArtifact,
            modelProviderId: providerId,
            modelCapabilities,
            activeSkillIds: skillResolution.activeSkillIds,
            allowedToolNames,
            toolProviderKinds: new Map(tools.map((tool) => [tool.name, tool.providerKind])),
            approvalPolicy,
            sandboxMode,
            signal
          })
          if (dispatched === 'aborted') return 'aborted'
          if (dispatched === 'all_suppressed') return 'stop'
          return 'continue'
        }
        const message = `Model did not call the required \`${request.requiredToolName}\` tool for this GUI plan turn.`
        await this.opts.events.record({
          kind: 'error',
          threadId,
          turnId,
          message,
          code: 'required_tool_missing'
        })
        await this.opts.turns.applyItem(
          threadId,
          makeErrorItem({
            id: this.opts.ids.next('item_error'),
            turnId,
            threadId,
            message,
            code: 'required_tool_missing'
          })
        )
        return 'failed'
      }
      const hasCurrentTurnFileChange = historyItems.some(
        (item) =>
          item.turnId === turnId &&
          item.kind === 'tool_call' &&
          item.toolKind === 'file_change' &&
          item.toolName !== CREATE_PLAN_TOOL_NAME
      )
      if (
        streamSnapshot.stopReason === 'stop' &&
        !streamSnapshot.text.trim() &&
        hasCurrentTurnFileChange
      ) {
        const recoverySteps = (this.emptyPostToolRecoveryStepsByTurn.get(turnId) ?? 0) + 1
        if (recoverySteps <= EMPTY_POST_TOOL_MAX_RECOVERY_STEPS) {
          this.emptyPostToolRecoveryStepsByTurn.set(turnId, recoverySteps)
          return 'continue'
        }

        const message =
          'Model stopped without a final answer after tool execution, including after a recovery retry.'
        this.rememberTurnFailure(turnId, {
          error: message,
          code: 'empty_post_tool_continuation',
          severity: 'error'
        })
        await this.opts.events.record({
          kind: 'error',
          threadId,
          turnId,
          message,
          code: 'empty_post_tool_continuation',
          severity: 'error'
        })
        await this.opts.turns.applyItem(
          threadId,
          makeErrorItem({
            id: this.opts.ids.next('item_error'),
            turnId,
            threadId,
            message,
            code: 'empty_post_tool_continuation',
            severity: 'error'
          })
        )
        return 'failed'
      }
      if (streamSnapshot.stopReason === 'stop' && activeGoalInstruction) {
        const previousText = this.lastNoToolTextByTurn.get(turnId)
        if (isRepeatedNoToolAssistantText(previousText, streamSnapshot.text)) {
          const recoverySteps = (this.goalNoToolRecoveryStepsByTurn.get(turnId) ?? 0) + 1
          if (recoverySteps <= GOAL_NO_TOOL_REPEAT_MAX_RECOVERY_STEPS) {
            this.goalNoToolRecoveryStepsByTurn.set(turnId, recoverySteps)
            this.lastNoToolTextByTurn.set(turnId, streamSnapshot.text)
            return 'continue'
          }
          const message =
            'Goal continuation stopped: the model kept repeating near-identical replies without calling tools or updating the goal.'
          await this.opts.turns.applyItem(
            threadId,
            makeErrorItem({
              id: this.opts.ids.next('item_error'),
              turnId,
              threadId,
              message,
              code: 'goal_repetition_stop',
              severity: 'warning'
            })
          )
          await this.opts.events.record({
            kind: 'error',
            threadId,
            turnId,
            message,
            code: 'goal_repetition_stop',
            severity: 'warning'
          })
          this.lastNoToolTextByTurn.delete(turnId)
          this.goalNoToolRecoveryStepsByTurn.delete(turnId)
          // A repetition stall on a turn that never made real progress would
          // just be reproduced by a fresh resume turn, so suppress auto-resume.
          // But a turn that edited files (etc.) and only then trailed off into
          // "I'm done" filler IS advancing the goal — the common "stops right
          // after editing files" case — so let the normal resume path carry it
          // forward instead of stranding it.
          if (!this.turnMadeProgress.has(turnId)) {
            this.goalResumeSuppressedByTurn.add(turnId)
          }
          return 'stop'
        }
        this.goalNoToolRecoveryStepsByTurn.delete(turnId)
        this.lastNoToolTextByTurn.set(turnId, streamSnapshot.text)
        return 'continue'
      }
      if (streamSnapshot.stopReason === 'length') {
        // The model hit its output-token ceiling and was cut off without a tool
        // call. Don't report this as a clean completion — surface a warning so
        // the truncation is visible instead of looking like the model "gave up".
        const message =
          'The model reached its maximum output length and the response was truncated. ' +
          'Raise the model’s max output tokens, or ask it to continue or split the work into smaller steps.'
        await this.opts.events.record({
          kind: 'error',
          threadId,
          turnId,
          message,
          code: 'output_truncated',
          severity: 'warning'
        })
        await this.opts.turns.applyItem(
          threadId,
          makeErrorItem({
            id: this.opts.ids.next('item_error'),
            turnId,
            threadId,
            message,
            code: 'output_truncated',
            severity: 'warning'
          })
        )
        return 'stop'
      }
      return 'stop'
    }
    // Tool calls mean the turn is making progress again; reset the no-tool
    // repetition window so unrelated later status texts are not compared.
    this.lastNoToolTextByTurn.delete(turnId)
    this.goalNoToolRecoveryStepsByTurn.delete(turnId)
    this.emptyPostToolRecoveryStepsByTurn.delete(turnId)
    const dispatched = await this.dispatchToolCalls({
      calls: completedToolCalls,
      threadId,
      turnId,
      workspace: thread?.workspace ?? '',
      threadMode: effectiveMode,
      activePlanContext,
      guiDesignCanvas: turn?.guiDesignCanvas === true,
      guiDesignMode: turn?.guiDesignMode === true,
      guiDesignArtifact: turn?.guiDesignArtifact,
      modelProviderId: providerId,
      modelCapabilities,
      activeSkillIds: skillResolution.activeSkillIds,
      allowedToolNames,
      userInputDisabled,
      imContext: turn?.imContext === true,
      toolProviderKinds: new Map(tools.map((tool) => [tool.name, tool.providerKind])),
      approvalPolicy,
      sandboxMode,
      signal
    })
    if (dispatched === 'aborted') return 'aborted'
    if (dispatched === 'all_suppressed') {
      if (dedicatedSvgTurn) {
        const latestItems = await this.opts.sessionStore.loadItems(threadId)
        const latestCompletion = svgArtifactCompletionState(latestItems, turnId)
        if (!latestCompletion.validationAfterMutation) {
          return this.recoverRequiredSvgCompletion(threadId, turnId, latestCompletion)
        }
      }
      return 'stop'
    }
    if (dedicatedSvgTurn && completedToolCalls.some((call) =>
      call.toolName === DESIGN_SVG_EDIT_TOOL_NAME ||
      call.toolName === DESIGN_SVG_ANIMATE_TOOL_NAME ||
      call.toolName === DESIGN_SVG_VALIDATE_TOOL_NAME
    )) {
      const latestItems = await this.opts.sessionStore.loadItems(threadId)
      const latestCompletion = svgArtifactCompletionState(latestItems, turnId)
      const progressed =
        latestCompletion.mutationRevision !== svgCompletion?.mutationRevision ||
        (!svgCompletion?.validationAfterMutation && latestCompletion.validationAfterMutation)
      if (!progressed) {
        return this.recoverRequiredSvgCompletion(threadId, turnId, latestCompletion)
      }
      this.svgCompletionRecoveryStepsByTurn.delete(turnId)
    }
    return 'continue'
  }

  private async dispatchToolCalls(input: ToolDispatchInput): Promise<ToolDispatchOutcome> {
    const context = createToolExecutionContext(input, {
      memoryEnabled: Boolean(this.opts.memoryStore),
      ...(this.opts.blockedProviderIds ? { blockedProviderIds: this.opts.blockedProviderIds } : {}),
      ...(this.opts.blockedToolNames ? { blockedToolNames: this.opts.blockedToolNames } : {}),
      ...(this.opts.blockedSkillIds ? { blockedSkillIds: this.opts.blockedSkillIds } : {}),
      ...(this.opts.runtimeDataDir ? { runtimeDataDir: this.opts.runtimeDataDir } : {}),
      ...(this.opts.artifactStore ? { artifactStore: this.opts.artifactStore } : {}),
      interactiveToolBridge: this.interactiveToolBridge
    })
    return this.toolCallDispatcher.dispatch({
      dispatch: input,
      context,
      stormBreaker: this.toolStormBreakers.get(input.turnId),
      onToolExecuted: (toolName) => {
        if (!GOAL_NON_PROGRESS_TOOL_NAMES.has(toolName)) {
          this.turnMadeProgress.add(input.turnId)
        }
      }
    })
  }

  private async rewriteThreadItemsFromSession(threadId: string): Promise<void> {
    const items = await this.opts.sessionStore.loadItems(threadId)
    if (items.length === 0) return
    const itemsByTurn = new Map<string, TurnItem[]>()
    for (const item of items) {
      const turnItems = itemsByTurn.get(item.turnId) ?? []
      turnItems.push(item)
      itemsByTurn.set(item.turnId, turnItems)
    }
    await this.mutateThread(threadId, async (current) => {
      let changed = false
      const turns = current.turns.map((turn) => {
        const sessionItems = itemsByTurn.get(turn.id)
        if (!sessionItems) return turn
        changed = true
        return { ...turn, items: placeCompactionsAtTurnEnd(sessionItems) }
      })
      if (!changed) return
      await this.opts.threadStore.upsert(touchThread({ ...current, turns }, this.opts.nowIso()))
    })
  }

  private async recordTokenEconomySavings(input: {
    threadId: string
    turnId: string
    model: string
    rawInputTokens: number
    sentInputTokens: number
  }): Promise<void> {
    const savedTokens = Math.max(0, Math.floor(input.rawInputTokens - input.sentInputTokens))
    if (savedTokens <= 0) return
    const usage = this.opts.usage.recordTokenEconomySavings(input.threadId, {
      tokenEconomySavingsTokens: savedTokens
    })
    await this.opts.events.record({
      kind: 'usage',
      threadId: input.threadId,
      turnId: input.turnId,
      model: input.model,
      usage
    })
  }

  private async recordPipelineStage(
    threadId: string,
    turnId: string,
    stage: PipelineStage,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.opts.events.record({
      kind: 'pipeline_stage',
      threadId,
      turnId,
      stage,
      label: PIPELINE_STAGE_LABELS[stage],
      ...(details && Object.keys(details).length > 0 ? { details } : {})
    })
  }

  private async recordToolCatalogDrift(input: {
    threadId: string
    turnId: string
    fingerprint: string
    toolCount: number
    toolNames: string[]
    changeKind: 'additive' | 'breaking'
    message: string
  }): Promise<void> {
    await this.opts.turns.applyItem(input.threadId, makeErrorItem({
      id: `item_${input.turnId}_tool_catalog_changed_${input.fingerprint}`,
      threadId: input.threadId,
      turnId: input.turnId,
      message: input.message,
      code: 'tool_catalog_changed',
      severity: 'info'
    }))
    await this.opts.events.record({
      kind: 'tool_catalog_changed',
      threadId: input.threadId,
      turnId: input.turnId,
      fingerprint: input.fingerprint,
      toolCount: input.toolCount,
      changeKind: input.changeKind,
      toolNames: input.toolNames.slice(0, 50),
      message: input.message
    })
  }

  private async checkBudgetGate(
    thread: Awaited<ReturnType<ThreadStore['get']>>,
    threadId: string,
    turnId: string
  ): Promise<'allow' | 'blocked'> {
    if (!thread) return 'allow'
    if (thread.goal?.status === 'usageLimited') {
      await this.opts.events.record({
        kind: 'error',
        threadId,
        turnId,
        message: `Goal token budget exhausted: ${thread.goal.tokensUsed} used of ${thread.goal.tokenBudget ?? 0}.`,
        code: 'goal_token_budget_limited',
        severity: 'warning'
      })
      return 'blocked'
    }
    const budget = thread.costBudgetUsd
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return 'allow'
    const spent = this.opts.usage.forThread(threadId).costUsd ?? 0
    if (spent >= budget) {
      const message = `Cost budget exhausted for this thread: $${spent.toFixed(4)} used of $${budget.toFixed(4)}.`
      await this.opts.turns.applyItem(threadId, makeErrorItem({
        id: `item_${turnId}_budget_limited`,
        threadId,
        turnId,
        message,
        code: 'budget_limited'
      }))
      await this.opts.events.record({
        kind: 'error',
        threadId,
        turnId,
        message,
        code: 'budget_limited'
      })
      return 'blocked'
    }
    if (spent >= budget * 0.8 && thread.costBudgetWarningSent !== true) {
      const message = `Cost budget warning: $${spent.toFixed(4)} used of $${budget.toFixed(4)}.`
      const warningMarked = await this.mutateThread(threadId, async (current) => {
        const currentBudget = current.costBudgetUsd
        if (
          typeof currentBudget !== 'number' ||
          !Number.isFinite(currentBudget) ||
          currentBudget <= 0 ||
          spent < currentBudget * 0.8 ||
          current.costBudgetWarningSent === true
        ) {
          return false
        }
        await this.opts.threadStore.upsert({
          ...current,
          costBudgetWarningSent: true,
          updatedAt: this.opts.nowIso()
        })
        return true
      })
      if (!warningMarked) return 'allow'
      await this.opts.turns.applyItem(threadId, makeErrorItem({
        id: `item_${turnId}_budget_warning`,
        threadId,
        turnId,
        message,
        code: 'budget_warning',
        severity: 'warning'
      }))
      await this.opts.events.record({
        kind: 'error',
        threadId,
        turnId,
        message,
        code: 'budget_warning',
        severity: 'warning'
      })
    }
    return 'allow'
  }

  private async recordGoalUsage(threadId: string, tokenDelta: number): Promise<void> {
    const delta = Math.max(0, Math.floor(tokenDelta))
    if (delta === 0) return
    const goal = await this.mutateThread(threadId, async (thread) => {
      if (!thread.goal || thread.goal.status !== 'active') return null
      const tokensUsed = thread.goal.tokensUsed + delta
      const next: ThreadGoal = {
        ...thread.goal,
        tokensUsed,
        status: thread.goal.tokenBudget !== undefined && thread.goal.tokenBudget !== null && tokensUsed >= thread.goal.tokenBudget
          ? 'usageLimited'
          : 'active',
        updatedAt: this.opts.nowIso()
      }
      await this.opts.threadStore.upsert(touchThread({ ...thread, goal: next }, next.updatedAt))
      return next
    })
    if (!goal) return
    await this.opts.events.record({ kind: 'goal_updated', threadId, goal })
  }

  /** Convenience factory for tests: builds a loop with sensible defaults. */
  static defaultPrefix(): ImmutablePrefix {
    return createImmutablePrefix({
      systemPrompt: 'You are Kun, a careful and helpful assistant.',
      pinnedConstraints: ['user: preserve recent turns', 'project: keep responses concise']
    })
  }
}

function buildToolCatalogDriftMessage(toolCatalog: {
  fingerprint: string
  toolCount: number
  toolNames: string[]
}, changeKind: 'additive' | 'breaking'): string {
  const sample = toolCatalog.toolNames.slice(0, 12).join(', ')
  const suffix = toolCatalog.toolNames.length > 12 ? `, +${toolCatalog.toolNames.length - 12} more` : ''
  const policy = changeKind === 'additive'
    ? 'Only additive tool changes are allowed in-place; Kun will continue with the refreshed tool list.'
    : 'Non-additive tool changes can invalidate prompt-cache assumptions; Kun stopped this turn. Start a new thread after editing, removing, or reordering tool schemas.'
  return [
    `Tool catalog changed for this thread (${toolCatalog.toolCount} tools, fingerprint ${toolCatalog.fingerprint}).`,
    policy,
    sample ? `Current tools: ${sample}${suffix}.` : ''
  ].filter(Boolean).join(' ')
}

function activeTurnRunKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`
}

function prefixVolatilityStageDetails(
  findings: PrefixVolatilityFinding[]
): Record<string, unknown> | undefined {
  if (findings.length === 0) return undefined
  const kinds = [...new Set(findings.map((finding) => finding.kind))].sort()
  const fields = [...new Set(findings.map((finding) => finding.field))].sort()
  return {
    prefixVolatileTokenCount: findings.length,
    prefixVolatileTokenKinds: kinds,
    prefixVolatileFields: fields,
    noRegexDetector: true
  }
}
