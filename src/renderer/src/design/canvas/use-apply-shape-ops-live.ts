import { useEffect, useRef } from 'react'
import { useChatStore } from '../../store/chat-store'
import { collectAssistantTextForTurn } from '../../store/chat-store-runtime-helpers'
import { applyCanvasOpsSince, setLastCanvasOpErrors } from './apply-shape-ops'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { takeScreenBrief } from './screen-artifact-bridge'
import type { OpError } from './shape-ops'
import { isHtmlFrame } from './canvas-types'
import { useDesignAssistantStore } from '../design-assistant-store'

/** Coalesce per-token `liveAssistant` deltas so we re-parse at most this often. */
const STREAM_THROTTLE_MS = 120

/**
 * Apply the `design_canvas` / legacy ```shapeops``` blocks the chat agent emits
 * — IN REAL TIME, as they stream — so the design draft builds up live on the
 * canvas instead of appearing all at once when the turn ends.
 *
 * Each completed fenced block is executed the moment its closing ``` arrives in
 * `liveAssistant`; a per-turn cursor (`appliedCount`) guarantees every block runs
 * exactly once across the streaming passes and the final turn-complete flush.
 * Because the agent is encouraged to emit many small batches (one per logical
 * group — a frame, then its children, then the next section), the user watches
 * the layout materialize piece by piece, and add_screen frames pop in instantly
 * while their HTML generation is kicked off at turn end.
 *
 * Used in both design mode (DesignCanvas) and code mode (CodeCanvasPanel) —
 * wherever a CanvasViewport is rendered alongside a chat thread that may emit
 * canvas operations.
 */
export function useApplyShapeOpsLive(
  enabled: boolean,
  onScreenCreated?: (shapeId: string, userPrompt: string, brief?: string) => void
): void {
  const onScreenCreatedRef = useRef(onScreenCreated)
  onScreenCreatedRef.current = onScreenCreated

  useEffect(() => {
    if (!enabled) return

    // Per-turn streaming state. Lives in the subscription closure so it survives
    // across deltas without triggering React re-renders on every token.
    let appliedCount = 0
    const affectedThisTurn = new Set<string>()
    const errorsThisTurn: OpError[] = []
    let framedThisTurn = false
    let lastRunAt = 0
    let trailingTimer: ReturnType<typeof setTimeout> | null = null

    const resetTurn = (): void => {
      appliedCount = 0
      affectedThisTurn.clear()
      errorsThisTurn.length = 0
      framedThisTurn = false
    }

    // The in-progress (or just-completed) turn's full assistant text. Using the
    // ASSEMBLED text — not raw `liveAssistant` — keeps the block cursor stable
    // even when a mid-turn tool call (e.g. generate_image) flushes a segment to a
    // block and resets `liveAssistant`; otherwise post-tool-call canvas ops would
    // never stream and the cursor would drift from the turn-complete flush.
    const assembledTurnText = (): string => {
      const s = useChatStore.getState()
      let userId: string | null = null
      for (let i = s.blocks.length - 1; i >= 0; i -= 1) {
        if (s.blocks[i].kind === 'user') {
          userId = s.blocks[i].id
          break
        }
      }
      return userId ? collectAssistantTextForTurn(s.blocks, userId, s.liveAssistant) : s.liveAssistant
    }

    // Apply every not-yet-applied complete block in `text`, advancing the cursor.
    // `frameOnFirst` gently brings the build area into view exactly once per turn
    // (the first batch), then leaves the camera alone so the live build is smooth.
    const applyFrom = (text: string, frameOnFirst: boolean): void => {
      const { affectedIds, errors, totalBlocks } = applyCanvasOpsSince(text, appliedCount)
      if (totalBlocks <= appliedCount) return
      appliedCount = totalBlocks
      // Capture errors even when nothing applied — an all-failed block has errors
      // but no affected ids, and that's exactly what the agent must learn about.
      if (errors.length > 0) errorsThisTurn.push(...errors)
      if (affectedIds.length === 0) return
      for (const id of affectedIds) affectedThisTurn.add(id)
      useCanvasSelectionStore.getState().select([...affectedThisTurn])
      if (frameOnFirst && !framedThisTurn) {
        framedThisTurn = true
        // markAiAffected = glow + camera focus; do it once at the start so the
        // build area is in view, then stay put for the rest of the stream.
        useDesignAssistantStore.getState().markAiAffected(affectedIds)
      } else {
        // Glow the freshly-touched shapes without yanking the camera mid-build.
        useDesignAssistantStore.setState({
          lastAiAffectedIds: affectedIds,
          lastAiActionAt: Date.now()
        })
      }
    }

    const processStreaming = (): void => {
      lastRunAt = Date.now()
      if (!useChatStore.getState().currentTurnId) return
      applyFrom(assembledTurnText(), true)
    }

    const scheduleStreaming = (): void => {
      const elapsed = Date.now() - lastRunAt
      if (elapsed >= STREAM_THROTTLE_MS) {
        processStreaming()
      } else if (!trailingTimer) {
        trailingTimer = setTimeout(() => {
          trailingTimer = null
          processStreaming()
        }, STREAM_THROTTLE_MS - elapsed)
      }
    }

    // Final pass once the turn completes: apply any block that finished exactly at
    // the end, then do a single camera fit + kick off screen-HTML generation.
    const finalizeTurn = (): void => {
      if (trailingTimer) {
        clearTimeout(trailingTimer)
        trailingTimer = null
      }
      const s = useChatStore.getState()
      let userId: string | null = null
      for (let i = s.blocks.length - 1; i >= 0; i -= 1) {
        if (s.blocks[i].kind === 'user') {
          userId = s.blocks[i].id
          break
        }
      }
      if (userId) {
        const text = collectAssistantTextForTurn(s.blocks, userId, s.liveAssistant)
        applyFrom(text, false)
      }
      const all = [...affectedThisTurn]
      if (all.length > 0) {
        useCanvasSelectionStore.getState().select(all)
        useDesignAssistantStore.getState().markAiAffected(all)
        if (onScreenCreatedRef.current) {
          const doc = useCanvasShapeStore.getState().document
          const userBlock = userId ? s.blocks.find((b) => b.id === userId) : null
          const userPrompt = userBlock?.kind === 'user' ? (userBlock.text ?? '') : ''
          for (const id of all) {
            const shape = doc.objects[id]
            if (shape && isHtmlFrame(shape)) {
              onScreenCreatedRef.current(id, userPrompt, takeScreenBrief(id) ?? undefined)
              break
            }
          }
        }
      }
      // Hand this turn's op errors to the next canvas turn so the agent can fix
      // them. Always set (even []) so a clean turn clears stale errors.
      setLastCanvasOpErrors([...errorsThisTurn])
      resetTurn()
    }

    const unsubscribe = useChatStore.subscribe((state, prev) => {
      const turnStarted = !prev.currentTurnId && Boolean(state.currentTurnId)
      const turnEnded = Boolean(prev.currentTurnId) && !state.currentTurnId
      if (turnStarted) resetTurn()
      if (state.currentTurnId && state.liveAssistant !== prev.liveAssistant) {
        scheduleStreaming()
      }
      if (turnEnded) finalizeTurn()
    })

    return () => {
      if (trailingTimer) clearTimeout(trailingTimer)
      unsubscribe()
    }
  }, [enabled])
}
