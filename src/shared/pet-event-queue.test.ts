import { describe, expect, it, vi } from 'vitest'
import {
  canContinueHealthPlayback,
  HEALTH_REMINDER_MAX_AGE_MS,
  isExpiredHealthEvent,
  queuePetEvent,
  takeNextPetEvent
} from './pet-event-queue'
import type { PetEvent } from './types'

const start = Date.parse('2026-10-04T02:00:00.000Z')
function health(id: string, kind: 'water' | 'stand' = 'water', at = start): PetEvent {
  return {
    animation: 'waiting', action: `health-${kind}`, hold: true,
    reminder: {
      id, sourceType: 'health', sourceId: kind, scheduledAt: new Date(at).toISOString(),
      status: 'fired', firedAt: new Date(at).toISOString(), acknowledgedAt: null,
      snoozedFromId: null, title: kind
    }
  }
}

describe('health reminder lifetime', () => {
  it('allows normal delivery but rejects an IPC event delivered after a long display-off', () => {
    const event = health('water-1')
    expect(isExpiredHealthEvent(event, start + HEALTH_REMINDER_MAX_AGE_MS)).toBe(false)
    expect(isExpiredHealthEvent(event, start + HEALTH_REMINDER_MAX_AGE_MS + 1)).toBe(true)
    expect(isExpiredHealthEvent(event, start + 8 * 60 * 60_000)).toBe(true)
  })

  it('uses scheduledAt when firedAt is absent', () => {
    const event = health('water-1')
    event.reminder!.firedAt = null
    expect(isExpiredHealthEvent(event, start + 31_000)).toBe(true)
  })

  it('keeps preview events and task notifications independent of health expiration', () => {
    const preview: PetEvent = { animation: 'waiting', action: 'health-stand' }
    const task: PetEvent = { ...health('task-1'), action: 'task-due' }
    expect(isExpiredHealthEvent(preview, start + 8 * 60 * 60_000)).toBe(false)
    expect(isExpiredHealthEvent(task, start + 8 * 60 * 60_000)).toBe(false)
  })

  it('does not play malformed reminder timestamps', () => {
    const event = health('water-1')
    event.reminder!.firedAt = 'invalid'
    expect(isExpiredHealthEvent(event, start)).toBe(true)
  })

  it('resets the current animation after its awaited timer resumes hours later', () => {
    const reset = vi.fn()
    const event = health('water-1')
    expect(canContinueHealthPlayback(event, 1, 1, reset, start + 700)).toBe(true)
    expect(reset).not.toHaveBeenCalled()
    expect(canContinueHealthPlayback(event, 1, 1, reset, start + 8 * 60 * 60_000)).toBe(false)
    expect(reset).toHaveBeenCalledOnce()
  })

  it('never lets an old animation reset a replacement animation', () => {
    const reset = vi.fn()
    expect(canContinueHealthPlayback(health('water-1'), 1, 2, reset, start + 8 * 60 * 60_000)).toBe(false)
    expect(reset).not.toHaveBeenCalled()
  })
})

describe('queued pet events', () => {
  it('retains only the newest water and stand events', () => {
    const queue: PetEvent[] = []
    queuePetEvent(queue, health('water-1'), start)
    queuePetEvent(queue, health('stand-1', 'stand'), start)
    queuePetEvent(queue, health('water-2', 'water', start + 1000), start + 1000)
    queuePetEvent(queue, health('stand-2', 'stand', start + 2000), start + 2000)
    expect(queue.map((event) => event.reminder!.id)).toEqual(['water-2', 'stand-2'])
  })

  it('does not replay duplicate occurrence IDs or replace a newer occurrence with delayed delivery', () => {
    const queue: PetEvent[] = []
    const latest = health('water-2', 'water', start + 1000)
    queuePetEvent(queue, latest, start + 1000)
    queuePetEvent(queue, { ...latest }, start + 2000)
    queuePetEvent(queue, health('water-1'), start + 2000)
    expect(queue).toEqual([latest])
  })

  it('drops old events both at arrival and when taking from a queue after suspension', () => {
    const queue: PetEvent[] = []
    queuePetEvent(queue, health('old-arrival'), start + 31_000)
    expect(queue).toEqual([])
    queuePetEvent(queue, health('water-1'), start)
    queuePetEvent(queue, health('stand-1', 'stand'), start)
    expect(takeNextPetEvent(queue, start + 8 * 60 * 60_000)).toBeUndefined()
    expect(queue).toEqual([])
  })

  it('skips expired health events without losing a following ordinary task event', () => {
    const task: PetEvent = { animation: 'jumping', action: 'task-completed', message: 'done' }
    const queue: PetEvent[] = [health('water-1'), health('stand-1', 'stand'), task]
    expect(takeNextPetEvent(queue, start + 31_000)).toBe(task)
    expect(queue).toEqual([])
  })

  it('preserves the order and multiplicity of ordinary events during health coalescing', () => {
    const task: PetEvent = { animation: 'waving', action: 'task-created', message: 'created' }
    const queue: PetEvent[] = []
    queuePetEvent(queue, task, start)
    queuePetEvent(queue, health('water-1'), start)
    queuePetEvent(queue, task, start + 1000)
    queuePetEvent(queue, health('water-2', 'water', start + 2000), start + 2000)
    expect(queue).toEqual([task, task, health('water-2', 'water', start + 2000)])
  })
})
