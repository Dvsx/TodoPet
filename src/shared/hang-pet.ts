import { SIZE_SCALE } from './codex-pet.js'
import type { HangMode, PetSettings } from './types.js'

export type { HangMode }

export const CUTOUT_NATIVE_WIDTH = 259
export const CUTOUT_NATIVE_HEIGHT = 520
export const CUTOUT_WIDTH = 144
export const CUTOUT_HEIGHT = Math.round((CUTOUT_WIDTH * CUTOUT_NATIVE_HEIGHT) / CUTOUT_NATIVE_WIDTH)

export const PIXEL_TOAST_WIDTH = 184
export const PIXEL_TOAST_GAP = 10
export const HANG_EDGE_MARGIN = 8
export const SHAKE_PAD = 56
/** Silk the sprite can travel even when perched near the screen midline. */
export const MIN_DROP_TRAVEL = 240

export const SHAKE_MS = 700
export const DROP_MS = 1200
export const HEALTH_TOAST_MS = 3500
export const CLIMB_MS = 1200
export const HINT_FADE_MS = 180

export interface HangRect {
  x: number
  y: number
  width: number
  height: number
}

export function petSpriteSize(size: PetSettings['size']): { width: number; height: number } {
  const scale = SIZE_SCALE[size]
  return {
    width: Math.round(CUTOUT_WIDTH * scale),
    height: Math.round(CUTOUT_HEIGHT * scale)
  }
}

export function hangWindowSize(size: PetSettings['size'], withToast = false): { width: number; height: number } {
  const sprite = petSpriteSize(size)
  return {
    width: sprite.width + (withToast ? PIXEL_TOAST_WIDTH + PIXEL_TOAST_GAP : 0),
    height: sprite.height
  }
}

export function toastExtra(): number {
  return PIXEL_TOAST_WIDTH + PIXEL_TOAST_GAP
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function hangOverlayBounds(
  work: HangRect,
  size: PetSettings['size'],
  anchor: { x?: number | null; y?: number | null } = {}
): HangRect {
  const sprite = hangWindowSize(size, false)
  // Keep the native window at one stable size. Resizing a transparent,
  // frameless HWND when the toast opens can briefly make Windows paint a
  // caption strip and forces Chromium to redraw the whole pet.
  const left = toastExtra()
  const right = SHAKE_PAD
  // Clamp the sprite, not its transparent animation padding. Like the toast
  // canvas on the left, the shake canvas may extend beyond the work area.
  const maxSpriteX = work.x + Math.max(0, work.width - sprite.width)
  const defaultSpriteX = work.x + work.width - sprite.width - right - HANG_EDGE_MARGIN
  const spriteX = clamp(anchor.x ?? defaultSpriteX, work.x, maxSpriteX)
  const maxSpriteY = work.y + Math.max(0, work.height - sprite.height)
  const y = clamp(anchor.y ?? work.y, work.y, maxSpriteY)
  const height = sprite.height + MIN_DROP_TRAVEL
  return { x: spriteX - left, y, width: sprite.width + left + right, height }
}

export const BUBBLE_WINDOW_WIDTH = 300
export const BUBBLE_WINDOW_HEIGHT = 174
const BUBBLE_GAP = 8

export function reminderBubblePosition(pet: HangRect, work: HangRect): { x: number; y: number } {
  return {
    x: Math.max(work.x + BUBBLE_GAP, pet.x - BUBBLE_WINDOW_WIDTH - BUBBLE_GAP),
    y: Math.max(work.y + BUBBLE_GAP, pet.y + 24)
  }
}

export function roundPixelDelta(dx: number, dy: number): { dx: number; dy: number } {
  return { dx: Math.round(dx), dy: Math.round(dy) }
}

export function hangPetBounds(
  work: HangRect,
  size: PetSettings['size'],
  mode: HangMode,
  anchor: { x?: number | null; y?: number | null } = {}
): HangRect {
  const sprite = hangWindowSize(size, false)
  const box = hangWindowSize(size, false)
  const mid = work.y + Math.round(work.height / 2)
  const maxSpriteX = work.x + Math.max(0, work.width - sprite.width)
  const defaultSpriteX = work.x + work.width - sprite.width - HANG_EDGE_MARGIN
  const spriteX = clamp(anchor.x ?? defaultSpriteX, work.x, maxSpriteX)
  const maxSpriteY = work.y + Math.max(0, work.height - sprite.height)
  const y = clamp(anchor.y ?? work.y, work.y, maxSpriteY)
  const height = mode === 'drop'
    ? Math.min(work.y + work.height - y, Math.max(sprite.height + MIN_DROP_TRAVEL, mid - y))
    : sprite.height
  return { x: spriteX, y, width: box.width, height }
}

/** Native input/drawing region; never depends on asynchronous cursor/hover state. */
export function petWindowShape(window: HangRect, size: PetSettings['size'], mode: HangMode, toast: boolean): HangRect[] {
  const sprite = petSpriteSize(size)
  // Keep the complete animation canvas while shaking/dropping/climbing.
  if (mode === 'drop') return [{x: 0, y: 0, width: window.width, height: window.height}]
  const left = toast ? 0 : window.width - SHAKE_PAD - sprite.width
  return [{x: left, y: 0, width: window.width - SHAKE_PAD - left, height: sprite.height}]
}

/** A hidden HWND can report 0×0; that region would hit-test as empty after show. */
export function isUsablePetShapeBounds(window: Pick<HangRect, 'width' | 'height'>): boolean {
  return window.width >= 32 && window.height >= 32
}
