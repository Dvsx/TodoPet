import { describe, expect, it } from 'vitest'
import { ATLAS_COLUMNS, ATLAS_ROWS, CELL_HEIGHT, CELL_WIDTH, CODEX_ANIMATION_ROWS, atlasPosition, cycleDuration, parsePetManifest, petWindowSize } from './codex-pet.js'
import { BUBBLE_WINDOW_WIDTH, HANG_EDGE_MARGIN, MIN_DROP_TRAVEL, PIXEL_TOAST_GAP, PIXEL_TOAST_WIDTH, SHAKE_PAD, hangOverlayBounds, hangPetBounds, petSpriteSize, reminderBubblePosition, roundPixelDelta } from './hang-pet.js'
import { clipTitle, reactionFor } from './pet-reactions.js'

describe('Codex pet contract', () => {
  it('matches hatch-pet atlas geometry', () => {
    expect(CELL_WIDTH * ATLAS_COLUMNS).toBe(1536)
    expect(CELL_HEIGHT * ATLAS_ROWS).toBe(1872)
    expect(CODEX_ANIMATION_ROWS.map((row) => row.state)).toEqual([
      'idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'
    ])
  })

  it('uses per-frame durations from animation-rows.md', () => {
    expect(CODEX_ANIMATION_ROWS[0]?.durations).toEqual([280, 110, 110, 140, 140, 320])
    expect(cycleDuration('waving')).toBe(700)
    expect(cycleDuration('jumping')).toBe(840)
  })

  it('sizes an atlas cell at 192×208', () => {
    expect(petWindowSize('large')).toEqual({ width: 192, height: 208 })
    expect(petWindowSize('medium')).toEqual({ width: 144, height: 156 })
    expect(atlasPosition('idle', 0)).toEqual({ x: '0%', y: '0%' })
    expect(atlasPosition('review', 0).y).toBe('100%')
  })

  it('accepts a hatch-pet pet.json', () => {
    expect(parsePetManifest({ id: 'spidey', spritesheetPath: 'spidey-hanging-cutout.png', displayName: 'Spidey' })?.id).toBe('spidey')
    expect(parsePetManifest({ spritesheetPath: 'spidey-hanging-cutout.png' })).toBeNull()
  })
})

describe('pet reactions', () => {
  it('maps todo matters onto hanging Spider-Man copy', () => {
    expect(reactionFor('boot').animation).toBe('waving')
    expect(reactionFor('task-created').animation).toBe('waving')
    expect(reactionFor('task-completed').animation).toBe('jumping')
    expect(reactionFor('task-updated').animation).toBe('review')
    expect(reactionFor('health-stand').animation).toBe('waiting')
    expect(reactionFor('health-stand').hold).toBe(true)
    expect(reactionFor('task-due', '写周报').hold).toBe(true)
    expect(reactionFor('task-due', '写周报').animation).toBe('waiting')
    expect(reactionFor('health-water').animation).toBe('waiting')
    expect(reactionFor('snoozed').animation).toBe('review')
    expect(reactionFor('task-created', '巡逻').message).toBe('已记录：巡逻')
    expect(reactionFor('task-completed', '巡逻').message).toBe('已完成：巡逻')
    expect(reactionFor('health-duty-start').animation).toBe('waving')
    expect(reactionFor('health-duty-start').hold).toBe(false)
    expect(reactionFor('health-water').message).toBe('喝水时间到了')
    expect(reactionFor('health-stand').message).toBe('站立时间到了')
    expect(clipTitle('这是一条很长的任务标题啊啊')).toBe('这是一条很长的任务标题啊…')
  })
})

describe('hang overlay', () => {
  it('perches the cutout at the top-right of the work area', () => {
    const perch = hangPetBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 'medium', 'perch')
    expect(perch.y).toBe(0)
    expect(perch.x + perch.width).toBe(1920 - HANG_EDGE_MARGIN)
    expect(perch.height).toBe(petSpriteSize('medium').height)
    expect(perch.width).toBe(petSpriteSize('medium').width)
  })

  it('drops the overlay from the current perch instead of snapping back to the screen top', () => {
    const drop = hangPetBounds({ x: 100, y: 40, width: 1600, height: 900 }, 'large', 'drop')
    const sprite = petSpriteSize('large')
    expect(drop.y).toBe(40)
    expect(drop.height).toBe(Math.min(900, Math.max(sprite.height + MIN_DROP_TRAVEL, 450)))
    expect(drop.x + drop.width).toBe(100 + 1600 - HANG_EDGE_MARGIN)
    expect(drop.width).toBe(sprite.width)
  })

  it('keeps a dragged sprite x when dropping from the screen top', () => {
    const drop = hangPetBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 'medium', 'drop', { x: 400, y: 180 })
    expect(drop.x).toBe(400)
    expect(drop.y).toBe(180)
  })

  it('uses a saved perch instead of the default top-right', () => {
    const perch = hangPetBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 'medium', 'perch', { x: 240, y: 80 })
    expect(perch.x).toBe(240)
    expect(perch.y).toBe(80)
  })

  it('insets the live overlay so shake can swing without clipping the screen edge', () => {
    const overlay = hangOverlayBounds({ x: 100, y: 40, width: 1600, height: 900 }, 'large')
    const sprite = petSpriteSize('large')
    expect(overlay.height).toBe(sprite.height + MIN_DROP_TRAVEL)
    expect(overlay.width).toBe(sprite.width + PIXEL_TOAST_WIDTH + PIXEL_TOAST_GAP + SHAKE_PAD)
    expect(overlay.x + overlay.width).toBe(100 + 1600 - HANG_EDGE_MARGIN)
  })

  it('reserves toast space without resizing the native window', () => {
    const overlay = hangOverlayBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 'medium')
    const sprite = petSpriteSize('medium')
    expect(overlay.width).toBe(sprite.width + PIXEL_TOAST_WIDTH + PIXEL_TOAST_GAP + SHAKE_PAD)
  })

  it('keeps drop travel when the sprite sits near the screen midline', () => {
    const sprite = petSpriteSize('medium')
    const work = { x: 0, y: 0, width: 1920, height: 1080 }
    const overlay = hangOverlayBounds(work, 'medium', { x: 400, y: 540 - sprite.height })
    expect(overlay.y).toBe(540 - sprite.height)
    expect(overlay.height).toBe(sprite.height + MIN_DROP_TRAVEL)
  })

  it('lets the sprite be dragged below the midline instead of snapping back to the top', () => {
    const sprite = petSpriteSize('medium')
    const work = { x: 0, y: 0, width: 1920, height: 1080 }
    const overlay = hangOverlayBounds(work, 'medium', { x: 400, y: 820 })
    expect(overlay.y).toBe(Math.min(820, work.height - sprite.height))
    expect(overlay.y).toBeGreaterThan(work.height / 2)
    expect(overlay.height).toBe(sprite.height + MIN_DROP_TRAVEL)
  })

  it('rounds fractional drag coordinates before calling Electron window APIs', () => {
    expect(roundPixelDelta(1.49, -2.51)).toEqual({ dx: 1, dy: -3 })
  })

  it('keeps the reminder bubble off the pet HWND so overlay click-through cannot swallow 喝了', () => {
    const work = { x: 0, y: 0, width: 1920, height: 1080 }
    const overlay = hangOverlayBounds(work, 'medium')
    const bubble = reminderBubblePosition(overlay, work)
    expect(bubble.x + BUBBLE_WINDOW_WIDTH).toBeLessThanOrEqual(overlay.x)
  })
})
