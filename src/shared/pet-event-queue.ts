import { isHealthDrop } from './pet-reactions.js'
import type { PetEvent } from './types.js'

/** Health reminders are useful now; do not replay them after a suspended renderer resumes. */
export const HEALTH_REMINDER_MAX_AGE_MS = 30_000

function reminderTime(event: PetEvent): number | null {
  if (!event.reminder) return null
  return Date.parse(event.reminder.firedAt ?? event.reminder.scheduledAt)
}

export function isExpiredHealthEvent(event: PetEvent, now = Date.now()): boolean {
  if (!isHealthDrop(event.action)) return false
  const at = reminderTime(event)
  // Preview events have no occurrence and should remain usable.
  return at !== null && (!Number.isFinite(at) || now - at > HEALTH_REMINDER_MAX_AGE_MS)
}

/** Keep ordinary events in order, but only the newest occurrence of each health action. */
export function queuePetEvent(queue: PetEvent[], event: PetEvent, now = Date.now()): void {
  if (isExpiredHealthEvent(event, now)) return
  if (isHealthDrop(event.action)) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (isExpiredHealthEvent(queue[index], now)) queue.splice(index, 1)
    }
    if (event.reminder && queue.some((item) => item.reminder?.id === event.reminder?.id)) return
    const previous = queue.findIndex((item) => item.action === event.action)
    if (previous >= 0) {
      if ((reminderTime(queue[previous]) ?? now) > (reminderTime(event) ?? now)) return
      queue.splice(previous, 1)
    }
  }
  queue.push(event)
}

export function takeNextPetEvent(queue: PetEvent[], now = Date.now()): PetEvent | undefined {
  let event: PetEvent | undefined
  while ((event = queue.shift())) {
    if (!isExpiredHealthEvent(event, now)) return event
  }
  return undefined
}

/** A superseded animation must never reset the animation that replaced it. */
export function canContinueHealthPlayback(
  event: PetEvent,
  token: number,
  currentToken: number,
  onExpired: () => void,
  now = Date.now()
): boolean {
  if (token !== currentToken) return false
  if (isExpiredHealthEvent(event, now)) {
    onExpired()
    return false
  }
  return true
}
