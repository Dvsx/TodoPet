import type { PetAnimation, PetSettings } from './types.js'

/** hatch-pet / Codex atlas: 8×9 cells of 192×208, 1536×1872 total. */
export const CELL_WIDTH = 192
export const CELL_HEIGHT = 208
export const ATLAS_COLUMNS = 8
export const ATLAS_ROWS = 9

export interface CodexAnimationRow {
  state: PetAnimation
  durations: number[]
}

export const CODEX_ANIMATION_ROWS: readonly CodexAnimationRow[] = [
  { state: 'idle', durations: [280, 110, 110, 140, 140, 320] },
  { state: 'running-right', durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { state: 'running-left', durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { state: 'waving', durations: [140, 140, 140, 280] },
  { state: 'jumping', durations: [140, 140, 140, 140, 280] },
  { state: 'failed', durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { state: 'waiting', durations: [150, 150, 150, 150, 150, 260] },
  { state: 'running', durations: [120, 120, 120, 120, 120, 220] },
  { state: 'review', durations: [150, 150, 150, 150, 150, 280] }
]

export const SIZE_SCALE: Record<PetSettings['size'], number> = { small: 0.5, medium: 0.75, large: 1 }

export interface PetManifest {
  id: string
  displayName?: string
  description?: string
  spritesheetPath: string
}

export function animationRowFor(state: PetAnimation): CodexAnimationRow {
  const row = CODEX_ANIMATION_ROWS.find((item) => item.state === state)
  if (!row) throw new Error(`Unknown Codex pet state: ${state}`)
  return row
}

export function cycleDuration(state: PetAnimation): number {
  return animationRowFor(state).durations.reduce((sum, ms) => sum + ms, 0)
}

/** Flash gestures play two full cycles, matching Codex's short return-to-idle. */
export function flashDuration(state: PetAnimation): number {
  return cycleDuration(state) * 2
}

export function petWindowSize(size: PetSettings['size']): { width: number; height: number } {
  const scale = SIZE_SCALE[size]
  return { width: Math.round(CELL_WIDTH * scale), height: Math.round(CELL_HEIGHT * scale) }
}

/** CSS background-position for an 8×9 atlas shown one cell at a time. */
export function atlasPosition(state: PetAnimation, frame: number): { x: string; y: string } {
  const row = CODEX_ANIMATION_ROWS.findIndex((item) => item.state === state)
  const frames = animationRowFor(state).durations.length
  const column = ((frame % frames) + frames) % frames
  return {
    x: `${(column / (ATLAS_COLUMNS - 1)) * 100}%`,
    y: `${(row / (ATLAS_ROWS - 1)) * 100}%`
  }
}

export function parsePetManifest(value: unknown): PetManifest | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return null
  if (typeof record.spritesheetPath !== 'string' || record.spritesheetPath.length === 0) return null
  return {
    id: record.id,
    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    spritesheetPath: record.spritesheetPath
  }
}
