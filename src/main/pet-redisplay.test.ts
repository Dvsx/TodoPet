import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayRecoverReason } from '../shared/overlay-recover'
import type { ReminderOccurrence, PetEvent } from '../shared/types'

const mocks = vi.hoisted(() => {
  type Rect = { x: number; y: number; width: number; height: number }
  type Listener = (...args: unknown[]) => void
  class Events {
    private listeners = new Map<string, { listener: Listener; once: boolean }[]>()
    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { listener, once: false }])
      return this
    }
    once(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { listener, once: true }])
      return this
    }
    emit(event: string, ...args: unknown[]) {
      const pending = this.listeners.get(event) ?? []
      this.listeners.set(event, pending.filter((entry) => !entry.once))
      for (const { listener } of pending) listener(...args)
    }
  }
  const state = { displaysReady: true, idleSeconds: 0, windows: [] as BrowserWindow[] }
  class WebContents extends Events {
    id = state.windows.length + 1
    isCrashed = vi.fn(() => false)
    invalidate = vi.fn()
    send = vi.fn()
  }
  class BrowserWindow extends Events {
    private destroyed = false
    private visible: boolean
    private bounds: Rect
    webContents = new WebContents()
    constructor(options: { width: number; height: number; show: boolean }) {
      super()
      this.visible = options.show
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
      state.windows.push(this)
    }
    isDestroyed = vi.fn(() => this.destroyed)
    isVisible = vi.fn(() => this.visible)
    getBounds = vi.fn(() => ({ ...this.bounds }))
    setBounds = vi.fn((bounds: Rect) => { this.bounds = { ...bounds }; this.emit('resized') })
    setPosition = vi.fn((x: number, y: number) => { this.bounds = { ...this.bounds, x, y }; this.emit('moved') })
    hide = vi.fn(() => { this.visible = false })
    showInactive = vi.fn(() => { this.visible = true; this.emit('show') })
    destroy = vi.fn(() => { this.destroyed = true; this.visible = false; this.emit('closed') })
    setClosable = vi.fn()
    setMenu = vi.fn()
    setAlwaysOnTop = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setShape = vi.fn()
    moveTop = vi.fn()
    loadFile = vi.fn()
    loadURL = vi.fn()
  }
  const display = () => ({ id: 1, scaleFactor: 2, workArea: {
    x: 0, y: 0, width: state.displaysReady ? 1920 : 0, height: state.displaysReady ? 1080 : 0
  } })
  return { BrowserWindow, state, display }
})

vi.mock('electron-store', () => ({ default: class {
  values = new Map<string, unknown>()
  get(key: string) { return this.values.get(key) }
  set(key: string, value: unknown) { this.values.set(key, value) }
} }))
vi.mock('electron', () => ({
  BrowserWindow: mocks.BrowserWindow, Menu: {}, Tray: class {}, app: {}, nativeImage: {},
  powerMonitor: { getSystemIdleTime: () => mocks.state.idleSeconds },
  screen: { getAllDisplays: () => [mocks.display()], getDisplayMatching: mocks.display, getPrimaryDisplay: mocks.display }
}))

import { WindowManager } from './window-manager'
import { hangOverlayBounds } from '../shared/hang-pet'

type MockWindow = InstanceType<typeof mocks.BrowserWindow>
type Internals = {
  petWindow: MockWindow
  dragging: boolean
  frozen: boolean
  screenLocked: boolean
  suspended: boolean
  petListenerReady: boolean
  pendingRecover: OverlayRecoverReason | null
  recoverAttempts: number
  lastIdleSeconds: number
  lastActivityCheck: number
  createPetWindow(): void
  recreateTray(): void
  freezePetInteraction(): void
  checkActivityReturn(): void
  runRecover(reason: OverlayRecoverReason): void
}
const spriteRegion = [{ x: 194, y: 0, width: 108, height: 217 }]

function healthReminder(id: string, sourceId = 'water'): ReminderOccurrence {
  const now = new Date().toISOString()
  return { id, sourceType: 'health', sourceId, title: sourceId, scheduledAt: now, firedAt: now, status: 'fired', acknowledgedAt: null, snoozedFromId: null }
}

function setup(ready = true) {
  const manager = new WindowManager(), internal = manager as unknown as Internals
  // Exercise pet lifecycle callbacks without starting an unrelated native tray.
  vi.spyOn(internal, 'recreateTray').mockImplementation(() => {})
  manager.updatePetSettings({ x: 500, y: 100, displayId: '1' })
  internal.createPetWindow()
  const window = internal.petWindow
  if (ready) window.emit('ready-to-show')
  return { manager, internal, window, bounds: window.getBounds() }
}
function showReady(internal: Internals): MockWindow {
  const window = internal.petWindow
  window.emit('ready-to-show')
  vi.advanceTimersByTime(0)
  return window
}
beforeEach(() => {
  vi.useFakeTimers()
  mocks.state.displaysReady = true
  mocks.state.idleSeconds = 0
  mocks.state.windows = []
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('unavailable-screen reminder presentation', () => {
  it('clears already-delivered health animations and both main-process queues', () => {
    const { manager, window, internal } = setup()
    manager.showReminder(healthReminder('water-1'))
    manager.showReminder(healthReminder('water-2'))
    manager.showReminder(healthReminder('stand-1', 'stand'))
    manager.setReminderDeliveryPaused(true)
    const queue = internal as unknown as { reminderQueue: ReminderOccurrence[]; pendingPetEvents: PetEvent[]; activeReminder: ReminderOccurrence | null }
    expect(queue.reminderQueue).toEqual([])
    expect(queue.pendingPetEvents).toEqual([])
    expect(queue.activeReminder).toBeNull()
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:reset-interaction')
    manager.showReminder(healthReminder('blocked'))
    expect(queue.activeReminder).toBeNull()
    manager.setReminderDeliveryPaused(false)
    expect(queue.activeReminder).toBeNull()
  })

  it('coalesces pending health occurrences instead of building a replay backlog', () => {
    const { manager, internal } = setup()
    manager.showReminder(healthReminder('active'))
    for (let i = 0; i < 20; i++) {
      manager.showReminder(healthReminder(`water-${i}`))
      manager.showReminder(healthReminder(`stand-${i}`, 'stand'))
    }
    const queue = (internal as unknown as { reminderQueue: ReminderOccurrence[] }).reminderQueue
    expect(queue.map(item => item.id)).toEqual(['water-19', 'stand-19'])
  })

  it('stopping a session cancels the current renderer animation, not just its bubble', () => {
    const { manager, window, internal } = setup()
    manager.showReminder(healthReminder('active'))
    manager.setHangMode('drop')
    manager.dismissHealthReminders()
    expect(manager.getHangMode()).toBe('perch')
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:reset-interaction')
    expect((internal as unknown as { activeReminder: ReminderOccurrence | null }).activeReminder).toBeNull()
  })

  it('display power off freezes the overlay until an actual display-on transition', () => {
    const { manager, window, internal } = setup()
    manager.setDisplayPower(true)
    internal.runRecover('manual')
    expect(internal.petWindow).toBe(window)
    expect(internal.frozen).toBe(true)
    manager.setDisplayPower(false)
    vi.advanceTimersByTime(600)
    expect(internal.petWindow).not.toBe(window)
  })
})

describe('manual pet redisplay', () => {
  it('replaces even a visible native window and keeps its last live position', () => {
    const { manager, window, internal } = setup()
    manager.nudgePet(80, 30)
    const before = window.getBounds()
    manager.showPet()
    const replacement = internal.petWindow
    expect(replacement).not.toBe(window)
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(window.setClosable).toHaveBeenCalledWith(true)
    expect(replacement.getBounds()).toEqual(before)
    expect(replacement.isVisible()).toBe(false)
    expect(internal.dragging).toBe(false)
    showReady(internal)
    expect(replacement.setShape).toHaveBeenLastCalledWith(spriteRegion)
    manager.nudgePet(20, 10); manager.endPetDrag()
    expect(replacement.getBounds()).toEqual({ ...before, x: before.x + 20, y: before.y + 10 })
  })
  it('resets both processes and replaces the pet after hiding during a reminder', () => {
    const { manager, window, internal } = setup()
    manager.setHangMode('drop'); manager.setToastVisible(true); internal.dragging = true
    manager.hidePet()
    expect(manager.getHangMode()).toBe('perch')
    expect(internal.dragging).toBe(false)
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:reset-interaction')
    expect(window.isVisible()).toBe(false)
    manager.showPet()
    const replacement = showReady(internal)
    expect(window.isDestroyed()).toBe(true)
    expect(replacement.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(replacement.setShape).toHaveBeenLastCalledWith(spriteRegion)
    expect(manager.getPetSettings().paused).toBe(false)
  })
  it('never makes replacements click-through after repeated redisplay or stale hover', () => {
    const { manager, internal } = setup()
    for (let i = 0; i < 5; i++) {
      manager.showPet()
      const replacement = showReady(internal)
      manager.setPointerInside(false); manager.setPointerInside(true)
      expect(replacement.setIgnoreMouseEvents.mock.calls.every((call) => call[0] === false)).toBe(true)
      expect(replacement.setShape).toHaveBeenLastCalledWith(spriteRegion)
    }
    expect(mocks.state.windows).toHaveLength(6)
  })
  it('restores the compact region after toast and animation', () => {
    const { manager, window, bounds } = setup()
    manager.setToastVisible(true)
    expect(window.setShape).toHaveBeenLastCalledWith([{ x: 0, y: 0, width: 302, height: 217 }])
    manager.setHangMode('drop')
    expect(window.setShape).toHaveBeenLastCalledWith([{ x: 0, y: 0, width: bounds.width, height: bounds.height }])
    manager.setHangMode('perch')
    expect(window.setShape).toHaveBeenLastCalledWith(spriteRegion)
  })
  it('does not rewrite the native region while the HWND is hidden', () => {
    const { manager, window } = setup()
    window.setShape.mockClear(); manager.hidePet(); vi.advanceTimersByTime(1)
    expect(window.isVisible()).toBe(false)
    expect(window.setShape).not.toHaveBeenCalled()
  })
  it('installs a non-empty hit region only after the replacement is shown', () => {
    const { manager, internal } = setup()
    manager.hidePet(); manager.showPet()
    const replacement = internal.petWindow
    expect(replacement.setShape).not.toHaveBeenCalled()
    showReady(internal)
    expect(replacement.setShape.mock.calls.every((call) => Array.isArray(call[0]) && call[0].length > 0 &&
      call[0].every((rect: { width: number; height: number }) => rect.width > 0 && rect.height > 0))).toBe(true)
    expect(replacement.setShape.mock.calls.some((call) => call[0][0]?.width === spriteRegion[0].width - 1)).toBe(true)
    expect(replacement.setShape).toHaveBeenLastCalledWith(spriteRegion)
    expect(replacement.setShape.mock.invocationCallOrder.at(-1)).toBeGreaterThan(replacement.showInactive.mock.invocationCallOrder[0])
  })
  it('uses saved coordinates when the old HWND reports collapsed bounds', () => {
    const { manager, window, internal } = setup()
    window.getBounds.mockReturnValue({ x: 0, y: 0, width: 0, height: 0 })
    manager.showPet()
    const replacement = showReady(internal)
    expect(replacement.getBounds()).toEqual(hangOverlayBounds(mocks.display().workArea, 'medium', { x: 500, y: 100 }))
    expect(replacement.setShape).toHaveBeenLastCalledWith(spriteRegion)
  })
  it('ignores late readiness and renderer callbacks from the replaced window', () => {
    const { manager, window, internal } = setup(false)
    manager.showPet()
    const replacement = internal.petWindow
    manager.markPetReady()
    window.emit('ready-to-show')
    window.webContents.emit('did-start-loading')
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(replacement.showInactive).not.toHaveBeenCalled()
    expect(internal.petListenerReady).toBe(true)
    expect(internal.pendingRecover).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(internal.petWindow).toBe(replacement)
    expect(showReady(internal).isVisible()).toBe(true)
  })
  it('rejects stale pet IPC senders after the old renderer has been replaced', () => {
    const { manager, window, internal } = setup()
    const oldId = window.webContents.id
    expect(manager.isCurrentPetSender(oldId)).toBe(true)
    manager.showPet()
    expect(manager.isCurrentPetSender(oldId)).toBe(false)
    expect(manager.isCurrentPetSender(internal.petWindow.webContents.id)).toBe(true)
    expect(manager.isCurrentPetSender(987654)).toBe(false)
  })
})

describe('pet recovery after power transitions', () => {
  it.each([['screenLocked', 'unlock'], ['suspended', 'resume']] as const)(
    'keeps %s frozen until its matching return, despite display changes', (gate, reason) => {
      const { manager, window, internal } = setup()
      manager.nudgePet(15, 10)
      internal[gate] = true; internal.freezePetInteraction()
      expect(internal.frozen).toBe(true)
      expect(internal.dragging).toBe(false)
      expect(window.webContents.send).toHaveBeenCalledWith('pet:reset-interaction')
      const before = window.getBounds()
      manager.nudgePet(60, 40); internal.runRecover('display-metrics'); manager.showPet()
      expect(internal.petWindow).toBe(window)
      expect(internal.frozen).toBe(true)
      expect(window.getBounds()).toEqual(before)
      internal[gate] = false; internal.runRecover(reason)
      const replacement = showReady(internal)
      expect(replacement).not.toBe(window)
      expect(internal.frozen).toBe(false)
      expect(replacement.getBounds()).toEqual(before)
    }
  )
  it('does not show a newly loaded pet while the screen is locked', () => {
    const { window, internal } = setup(false)
    internal.screenLocked = true; internal.freezePetInteraction(); window.emit('ready-to-show')
    expect(window.showInactive).not.toHaveBeenCalled()
    internal.screenLocked = false; internal.runRecover('unlock')
    expect(showReady(internal).isVisible()).toBe(true)
  })
  it('does not let a stale frozen drag prevent wake recovery', () => {
    const { window, internal } = setup()
    internal.dragging = true; internal.frozen = true; internal.runRecover('resume')
    expect(internal.petWindow).not.toBe(window)
    expect(internal.dragging).toBe(false)
    expect(internal.frozen).toBe(false)
  })
  it('leaves an active drag alone for an ordinary display metric change', () => {
    const { manager, window, internal } = setup()
    manager.nudgePet(15, 10); internal.runRecover('display-metrics')
    expect(internal.petWindow).toBe(window)
    expect(internal.dragging).toBe(true)
  })
  it('keeps a deliberately hidden pet hidden across wake', () => {
    const { manager, window, internal } = setup()
    manager.hidePet(); internal.frozen = true; internal.runRecover('resume')
    expect(internal.petWindow).toBe(window)
    expect(window.isVisible()).toBe(false)
    expect(mocks.state.windows).toHaveLength(1)
  })
  it('retries a display that is not ready without requiring another OS event', () => {
    const { window, internal } = setup()
    mocks.state.displaysReady = false; internal.runRecover('unlock')
    expect(internal.petWindow).toBe(window)
    expect(internal.frozen).toBe(true)
    expect(internal.pendingRecover).toBe('unlock')
    mocks.state.displaysReady = true; vi.advanceTimersByTime(500)
    expect(internal.petWindow).not.toBe(window)
    expect(internal.frozen).toBe(false)
    expect(internal.recoverAttempts).toBe(0)
    expect(internal.pendingRecover).toBeNull()
    expect(showReady(internal).isVisible()).toBe(true)
  })
  it('stops retrying an unavailable display after the bounded recovery budget', () => {
    const { window, internal } = setup()
    mocks.state.displaysReady = false; internal.runRecover('resume'); vi.runAllTimers()
    expect(internal.petWindow).toBe(window)
    expect(internal.recoverAttempts).toBe(8)
    expect(internal.pendingRecover).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('renews the pet once when input returns after sustained idle', () => {
    const { window, internal } = setup()
    internal.lastIdleSeconds = 120; mocks.state.idleSeconds = 0; internal.checkActivityReturn()
    expect(internal.pendingRecover).toBe('resume')
    vi.advanceTimersByTime(300)
    expect(internal.petWindow).not.toBe(window)
    const replacement = internal.petWindow
    internal.checkActivityReturn(); vi.advanceTimersByTime(1000)
    expect(internal.petWindow).toBe(replacement)
    expect(mocks.state.windows).toHaveLength(2)
  })
  it('also renews after an event-loop sleep gap when no power event arrived', () => {
    const { window, internal } = setup()
    internal.lastActivityCheck = Date.now() - 15000; internal.checkActivityReturn(); vi.advanceTimersByTime(300)
    expect(internal.petWindow).not.toBe(window)
  })
  it('does not duplicate a successful unlock recovery on the next idle sample', () => {
    const { internal } = setup()
    internal.lastIdleSeconds = 120; internal.runRecover('unlock')
    const replacement = internal.petWindow
    internal.checkActivityReturn(); vi.advanceTimersByTime(2000)
    expect(internal.petWindow).toBe(replacement)
    expect(mocks.state.windows).toHaveLength(2)
  })
  it('does not use idle-return recovery while locked or manually hidden', () => {
    const { manager, window, internal } = setup()
    internal.lastIdleSeconds = 120; internal.screenLocked = true; internal.checkActivityReturn()
    expect(internal.pendingRecover).toBeNull()
    internal.screenLocked = false; manager.hidePet(); internal.lastIdleSeconds = 120
    internal.checkActivityReturn(); vi.advanceTimersByTime(1000)
    expect(internal.petWindow).toBe(window)
    expect(window.isVisible()).toBe(false)
    expect(internal.pendingRecover).toBeNull()
  })
})
