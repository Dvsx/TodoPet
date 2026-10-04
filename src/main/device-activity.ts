/** Coordinates recording and reminder delivery across independent OS signals. */
export interface DeviceActivityActions {
  pauseDelivery(paused: boolean): void
  clearPresentation(): void
  pauseRecording(): void
  recordLock(): void
  resumeRecording(fromLock: boolean): void
  displayChanged(off: boolean): void
}

const DISPLAY_INPUT_REPLAY_MS = 5_000

export class DeviceActivity {
  private locked = false
  private suspended = false
  private displayOff = false
  private returnedFromLock = false
  private waitingForInput = false
  private pendingDisplayInputAt: number | null = null

  constructor(private readonly actions: DeviceActivityActions) {}

  private stopDelivery(): void {
    this.pendingDisplayInputAt = null
    this.waitingForInput = true
    this.actions.pauseDelivery(true)
    this.actions.clearPresentation()
  }

  lock(): void {
    if (this.locked) return
    this.locked = true
    this.returnedFromLock = true
    this.stopDelivery()
    this.actions.recordLock()
  }

  unlock(): void {
    this.locked = false
    // An unlock is user activity; display-on by itself is not.
    this.input()
  }

  suspend(): void {
    if (this.suspended) return
    this.suspended = true
    this.stopDelivery()
    this.actions.pauseRecording()
  }

  resume(): void {
    this.suspended = false
  }

  display(state: 'off' | 'on' | 'dim'): void {
    const off = state === 'off'
    if (off === this.displayOff) return
    this.displayOff = off
    if (off) {
      this.stopDelivery()
      this.actions.pauseRecording()
    }
    this.actions.displayChanged(off)
    if (!off && this.pendingDisplayInputAt !== null) {
      const age = Date.now() - this.pendingDisplayInputAt
      this.pendingDisplayInputAt = null
      // The idle poll may observe the wake input before the helper delivers
      // display-on. Consume that recent input once, without treating on as input.
      if (age >= 0 && age <= DISPLAY_INPUT_REPLAY_MS) this.input()
    }
  }

  input(): void {
    if (this.locked || this.suspended) return
    if (this.displayOff) {
      this.pendingDisplayInputAt = Date.now()
      return
    }
    this.pendingDisplayInputAt = null
    // Also permits existing automatic resume/correction behavior when there
    // was no OS transition. The record service owns manual-pause preferences.
    this.actions.resumeRecording(this.returnedFromLock)
    this.returnedFromLock = false
    if (this.waitingForInput) {
      this.waitingForInput = false
      this.actions.pauseDelivery(false)
    }
  }
}
