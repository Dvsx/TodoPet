import { describe, expect, it } from 'vitest'
import {
  isBrokenPipeError,
  isUsableWorkArea,
  overlayRecoverPlan,
  strongerRecoverReason
} from './overlay-recover.js'

const ready = {
  paused: false,
  displaysReady: true,
  frozen: false,
  dragging: false
} as const

describe('overlay recover plan', () => {
  it('treats a 0×0 or stub display as unusable', () => {
    expect(isUsableWorkArea({ width: 0, height: 0 })).toBe(false)
    expect(isUsableWorkArea({ width: 1920, height: 1080 })).toBe(true)
  })

  it('freezes and does not move the HWND while the display pipeline is down', () => {
    expect(overlayRecoverPlan({ ...ready, displaysReady: false, reason: 'display-metrics' })).toEqual({
      action: 'skip', freeze: true
    })
    expect(overlayRecoverPlan({ ...ready, reason: 'suspend' })).toEqual({ action: 'skip', freeze: true })
    expect(overlayRecoverPlan({ ...ready, reason: 'lock' })).toEqual({ action: 'skip', freeze: true })
  })

  it('rebuilds when the GPU or renderer is actually gone', () => {
    expect(overlayRecoverPlan({ ...ready, reason: 'gpu' }).action).toBe('rebuild')
    expect(overlayRecoverPlan({ ...ready, reason: 'renderer' }).action).toBe('rebuild')
  })

  it('recreates the native surface and input region after wake or manual recovery', () => {
    expect(overlayRecoverPlan({ ...ready, reason: 'resume' }).action).toBe('rebuild')
    expect(overlayRecoverPlan({ ...ready, reason: 'unlock' }).action).toBe('rebuild')
    expect(overlayRecoverPlan({ ...ready, frozen: true, reason: 'display-added' }).action).toBe('rebuild')
    expect(overlayRecoverPlan({ ...ready, reason: 'manual' }).action).toBe('rebuild')
  })

  it.each(['resume', 'unlock', 'manual', 'gpu', 'renderer'] as const)(
    'does not let a stale drag block %s recovery', (reason) => {
      expect(overlayRecoverPlan({ ...ready, dragging: true, reason })).toEqual({
        action: 'rebuild', freeze: false
      })
    }
  )

  it('recovers a frozen display even when the pre-freeze drag never ended', () => {
    expect(overlayRecoverPlan({ ...ready, frozen: true, dragging: true, reason: 'display-metrics' })).toEqual({
      action: 'rebuild', freeze: false
    })
  })

  it.each(['resume', 'unlock', 'manual', 'gpu', 'renderer'] as const)(
    'waits for a usable display before %s recovery', (reason) => {
      expect(overlayRecoverPlan({ ...ready, displaysReady: false, dragging: true, reason })).toEqual({
        action: 'skip', freeze: true
      })
    }
  )

  it('keeps a hidden pet hidden across resume, but still lets a manual show recover it', () => {
    expect(overlayRecoverPlan({ ...ready, paused: true, reason: 'resume' })).toEqual({
      action: 'skip', freeze: false
    })
    expect(overlayRecoverPlan({ ...ready, paused: true, reason: 'manual' }).action).toBe('rebuild')
  })

  it('does not persist-move the pet mid-drag, and coalesces wake events toward rebuild', () => {
    expect(overlayRecoverPlan({ ...ready, dragging: true, reason: 'display-metrics' }).action).toBe('skip')
    expect(overlayRecoverPlan({ ...ready, reason: 'display-metrics' }).action).toBe('soft')
    expect(strongerRecoverReason('display-metrics', 'resume')).toBe('resume')
    expect(strongerRecoverReason('resume', 'display-metrics')).toBe('resume')
  })

  it('treats a broken helper pipe as a recoverable wake failure, not a crash', () => {
    expect(isBrokenPipeError({ code: 'EPIPE' })).toBe(true)
    expect(isBrokenPipeError({ code: 'ECONNRESET' })).toBe(true)
    expect(isBrokenPipeError({ code: 'ENOENT' })).toBe(false)
    expect(isBrokenPipeError(new Error('write EPIPE'))).toBe(false)
  })
})
