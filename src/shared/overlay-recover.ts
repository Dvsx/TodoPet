/** Smallest work area that can host the hanging pet without collapsing it off-screen. */
export const MIN_WORK_AREA = 200

export type OverlayRecoverReason =
  | 'resume'
  | 'unlock'
  | 'lock'
  | 'suspend'
  | 'display-added'
  | 'display-removed'
  | 'display-metrics'
  | 'gpu'
  | 'renderer'
  | 'manual'

export type OverlayRecoverAction = 'skip' | 'soft' | 'reassert' | 'rebuild'

export function isUsableWorkArea(work: { width: number; height: number }): boolean {
  return work.width >= MIN_WORK_AREA && work.height >= MIN_WORK_AREA
}

export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  const code = (error as { code?: string }).code
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED' || code === 'EOF'
}

/**
 * A live HWND and renderer do not prove that a transparent window's native
 * surface and input region survived a power transition. Recreate the pet
 * after wake or explicit recovery, including when a drag was interrupted.
 * Ordinary display changes remain soft so they do not interrupt an active drag.
 */
export function overlayRecoverPlan(input: {
  paused: boolean
  displaysReady: boolean
  frozen: boolean
  dragging: boolean
  reason: OverlayRecoverReason
}): { action: OverlayRecoverAction; freeze: boolean } {
  if (input.reason === 'suspend' || input.reason === 'lock') {
    return { action: 'skip', freeze: true }
  }
  if (!input.displaysReady) return { action: 'skip', freeze: true }
  if (input.paused && input.reason !== 'manual') {
    return { action: 'skip', freeze: false }
  }
  if (
    input.frozen || input.reason === 'resume' || input.reason === 'unlock' ||
    input.reason === 'manual' || input.reason === 'gpu' || input.reason === 'renderer'
  ) {
    return { action: 'rebuild', freeze: false }
  }
  if (input.dragging) return { action: 'skip', freeze: input.frozen }
  return { action: 'soft', freeze: false }
}

const REASON_RANK: Record<OverlayRecoverReason, number> = {
  suspend: 0,
  lock: 0,
  'display-metrics': 1,
  'display-removed': 1,
  'display-added': 2,
  unlock: 3,
  manual: 3,
  resume: 4,
  gpu: 5,
  renderer: 5
}

export function strongerRecoverReason(
  current: OverlayRecoverReason | null,
  incoming: OverlayRecoverReason
): OverlayRecoverReason {
  if (!current) return incoming
  return REASON_RANK[incoming] >= REASON_RANK[current] ? incoming : current
}
