import { BrowserWindow, Menu, Tray, app, nativeImage, powerMonitor, screen } from 'electron'
import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BUBBLE_WINDOW_HEIGHT, BUBBLE_WINDOW_WIDTH, hangOverlayBounds, isUsablePetShapeBounds, petWindowShape, reminderBubblePosition, roundPixelDelta, toastExtra } from '../shared/hang-pet.js'
import {
  isUsableWorkArea,
  overlayRecoverPlan,
  strongerRecoverReason,
  type OverlayRecoverReason
} from '../shared/overlay-recover.js'
import { reactionFor } from '../shared/pet-reactions.js'
import type { HangMode, PetEvent, PetSettings, ReminderOccurrence } from '../shared/types.js'
import { coversWorkArea } from '../shared/window-state.js'

type Settings = { pet?: PetSettings }
const initialSettings: PetSettings = { displayId: null, x: null, y: null, size: 'medium', reducedMotion: false, paused: false }

export class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private petWindow: BrowserWindow | null = null
  private bubbleWindow: BrowserWindow | null = null
  private tray: Tray | null = null
  private store = new Store<Settings>({ name: 'window-settings' })
  private quitting = false
  private hangMode: HangMode = 'perch'
  private pendingHealthId: string | null = null
  private reminderQueue: ReminderOccurrence[] = []
  private showingReminder = false
  private activeReminder: ReminderOccurrence | null = null
  private toastOpen = false
  private dragging = false
  private petListenerReady = false
  private pendingPetEvents: PetEvent[] = []
  private frozen = false
  private screenLocked = false
  private suspended = false
  private displayOff = false
  private reminderDeliveryPaused = false
  private recovering = false
  private recoverTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRecover: OverlayRecoverReason | null = null
  private recoverAttempts = 0
  private activityTimer: ReturnType<typeof setInterval> | null = null
  private lastIdleSeconds = 0
  private lastActivityCheck = Date.now()
  private hitRegionTimer: ReturnType<typeof setTimeout> | null = null
  private dutyActive = false
  private dutyPaused = false
  private dutyHandlers: { start: () => void; stop: () => void; clockOut: () => void } = {
    start: () => {},
    stop: () => {},
    clockOut: () => this.quit()
  }

  async create(): Promise<void> {
    this.screenLocked = powerMonitor.getSystemIdleState(60) === 'locked'
    this.createMainWindow(); this.createPetWindow(); this.createBubbleWindow(); this.createTray()
    const recover = (reason: OverlayRecoverReason, delay = 800) => this.scheduleRecover(reason, delay)
    screen.on('display-added', () => recover('display-added'))
    screen.on('display-removed', () => recover('display-removed'))
    screen.on('display-metrics-changed', () => recover('display-metrics'))
    powerMonitor.on('suspend', () => { this.suspended = true; this.freezePetInteraction() })
    powerMonitor.on('lock-screen', () => { this.screenLocked = true; this.freezePetInteraction() })
    powerMonitor.on('resume', () => { this.suspended = false; recover('resume', 1000) })
    powerMonitor.on('unlock-screen', () => { this.screenLocked = false; recover('unlock', 600) })
    // Display-only power saving need not emit suspend/resume. On return from
    // sustained idle (or a stopped event loop), renew the overlay once.
    this.lastIdleSeconds = powerMonitor.getSystemIdleTime()
    this.activityTimer = setInterval(() => this.checkActivityReturn(), 2000)
    this.activityTimer.unref()
    app.once('before-quit', () => {
      this.quitting = true
      if (this.activityTimer) clearInterval(this.activityTimer)
      if (this.recoverTimer) clearTimeout(this.recoverTimer)
      if (this.hitRegionTimer) clearTimeout(this.hitRegionTimer)
    })
    app.on('child-process-gone', (_event, details) => {
      if (details.type === 'GPU') recover('gpu', 400)
    })
  }

  private rendererPath(view?: 'pet' | 'bubble'): string {
    const query = view ? `?view=${view}` : ''
    return process.env.ELECTRON_RENDERER_URL ? `${process.env.ELECTRON_RENDERER_URL}${query}` : ''
  }

  private load(window: BrowserWindow, view?: 'pet' | 'bubble'): void {
    const devUrl = this.rendererPath(view)
    if (devUrl) window.loadURL(devUrl)
    else window.loadFile(join(__dirname, '../renderer/index.html'), { query: view ? { view } : {} })
  }

  private preferences(overlay = false) {
    return {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !overlay
    }
  }

  // 图标在 dev 下读项目 resources/，打包后由 extraResources 放到 resourcesPath/icon/。
  private iconFile(name: string): string {
    return app.isPackaged ? join(process.resourcesPath, 'icon', name) : join(__dirname, '../../resources/icon', name)
  }

  // Electron 43.4.0 includes the upstream frameless DWM fix (#47957).
  // Let Electron own native frame insets; external DWM writes race its updates.
  // Keep the native bounds stable while animating perch/drop in the renderer.
  private overlayOptions(width: number, height: number, show = true) {
    return {
      title: '', width, height, show, frame: false, transparent: true, roundedCorners: false,
      backgroundColor: '#00000000',
      backgroundMaterial: 'none' as const,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      closable: false, focusable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: this.preferences(true),
      ...(process.platform === 'win32' ? { type: 'toolbar' as const, thickFrame: false } : {})
    }
  }

  private createMainWindow(): void {
    this.mainWindow = new BrowserWindow({ title: 'TodoPet', width: 1160, height: 760, minWidth: 940, minHeight: 620, frame: false, backgroundColor: '#fdf8ec', icon: this.iconFile('icon.png'), show: true, webPreferences: this.preferences() })
    // Keep the main window opaque; the pet uses a separate transparent surface.
    this.mainWindow.on('close', (event) => { if (!this.quitting) { event.preventDefault(); this.mainWindow?.hide() } })
    this.bindMainWindowState()
    this.load(this.mainWindow)
  }

  private maximizedTimer: ReturnType<typeof setTimeout> | null = null

  private bindMainWindowState(): void {
    const win = this.mainWindow
    if (!win) return
    win.on('maximize', () => this.emitMaximized(true))
    win.on('enter-full-screen', () => this.emitMaximized(true))
    win.on('unmaximize', () => this.emitMaximized(false))
    win.on('leave-full-screen', () => this.emitMaximized(false))
    win.on('restore', () => this.sendMaximizedState())
    win.on('resized', () => this.queueMaximizedState())
    win.webContents.on('did-finish-load', () => this.sendMaximizedState())
  }

  private emitMaximized(maximized: boolean): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.send('window:maximized', maximized)
  }

  private queueMaximizedState(): void {
    if (this.maximizedTimer) clearTimeout(this.maximizedTimer)
    this.maximizedTimer = setTimeout(() => this.sendMaximizedState(), 80)
  }

  private sendMaximizedState(): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.send('window:maximized', this.isMainMaximized())
  }

  isMainMaximized(): boolean {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return false
    if (win.isMaximized() || win.isFullScreen()) return true
    return coversWorkArea(win.getBounds(), screen.getDisplayMatching(win.getBounds()).workArea)
  }

  toggleMainMaximize(): boolean {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return false
    if (this.isMainMaximized()) {
      if (win.isFullScreen()) win.setFullScreen(false)
      if (win.isMaximized()) win.unmaximize()
      else {
        win.setSize(1160, 760, false)
        win.center()
      }
      this.emitMaximized(false)
      return false
    }
    win.maximize()
    this.emitMaximized(true)
    return true
  }

  private createPetWindow(): void {
    const bounds = this.hangBounds()
    const window = new BrowserWindow(this.overlayOptions(bounds.width, bounds.height, false))
    this.petWindow = window
    this.petWindow.setAlwaysOnTop(true, 'floating')
    this.applyHangBounds(false)
    this.petWindow.setMenu(null)
    this.petWindow.on('close', (event) => { if (!this.quitting) event.preventDefault() })
    this.petWindow.on('moved', () => { if (this.petWindow === window) this.persistPosition() })
    this.petWindow.on('show', () => {
      if (this.petWindow !== window) return
      this.restoreOverlayPaint()
      this.applyMouseIgnore(true)
      this.scheduleHitRegionRefresh()
    })
    this.petWindow.on('resized', () => this.applyMouseIgnore())
    this.petWindow.webContents.on('did-start-loading', () => { if (this.petWindow === window) this.petListenerReady = false })
    this.petWindow.webContents.on('render-process-gone', (_event, details) => {
      if (this.petWindow !== window || details.reason === 'clean-exit') return
      this.scheduleRecover('renderer', 200)
    })
    this.petWindow.once('ready-to-show', () => {
      if (this.petWindow !== window || this.getPetSettings().paused || this.screenLocked || this.suspended || this.displayOff || window.isDestroyed()) return
      window.showInactive()
      this.applyMouseIgnore(true)
    })
    this.load(this.petWindow, 'pet')
  }

  private createBubbleWindow(): void {
    this.bubbleWindow = new BrowserWindow(this.overlayOptions(BUBBLE_WINDOW_WIDTH, BUBBLE_WINDOW_HEIGHT, false))
    this.bubbleWindow.setAlwaysOnTop(true, 'pop-up-menu')
    this.bubbleWindow.setFocusable(true)
    this.bubbleWindow.setMenu(null)
    this.bubbleWindow.on('close', (event) => { if (!this.quitting) event.preventDefault() })
    this.bubbleWindow.webContents.on('did-finish-load', () => {
      if (this.activeReminder && this.bubbleWindow && !this.bubbleWindow.isDestroyed()) {
        this.bubbleWindow.webContents.send('reminder:raised', this.activeReminder)
      }
    })
    this.load(this.bubbleWindow, 'bubble')
  }

  private createTray(): void {
    const trayIcon = nativeImage.createFromPath(this.iconFile('icon-tray.png'))
    // 兜底：图标文件缺失时退回内置 1x1 透明图，避免托盘创建失败
    const icon = trayIcon.isEmpty() ? nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gJ/7SROVwAAAABJRU5ErkJggg==') : trayIcon
    this.tray = new Tray(icon)
    this.refreshTray()
    this.tray.on('double-click', () => this.showMain())
  }

  private refreshTray(): void {
    if (!this.tray) return
    const hidden = this.getPetSettings().paused
    const tooltip = hidden ? 'TodoPet · 蜘蛛侠休息中' : this.dutyActive ? 'TodoPet · 正在记录' : this.dutyPaused ? 'TodoPet · 记录已暂停' : 'TodoPet · 待命'
    this.tray.setToolTip(tooltip)
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 TodoPet', click: () => this.showMain() },
      { label: this.dutyActive ? '停止记录' : this.dutyPaused ? '继续记录' : '开始记录', click: () => this.dutyActive ? this.dutyHandlers.stop() : this.dutyHandlers.start() },
      { label: hidden ? '显示桌宠' : '重新显示桌宠', click: () => this.showPet() },
      { label: '关闭桌宠', enabled: !hidden, click: () => this.hidePet() },
      { label: '预览喝水提醒', click: () => this.showReminder({
        id: randomUUID(), sourceType: 'health', sourceId: 'water',
        scheduledAt: new Date().toISOString(), status: 'fired', firedAt: new Date().toISOString(),
        acknowledgedAt: null, snoozedFromId: null, title: '喝水时间到了'
      }) },
      { label: '预览站立提醒', click: () => this.showReminder({
        id: randomUUID(), sourceType: 'health', sourceId: 'stand',
        scheduledAt: new Date().toISOString(), status: 'fired', firedAt: new Date().toISOString(),
        acknowledgedAt: null, snoozedFromId: null, title: '站立时间到了'
      }) },
      { type: 'separator' },
      { label: '下班', click: () => this.dutyHandlers.clockOut() }
    ]))
  }

  quit(): void {
    this.quitting = true
    this.petWindow?.setClosable(true)
    this.bubbleWindow?.setClosable(true)
    app.quit()
  }

  bindHealthDuty(handlers: { start: () => void; stop: () => void; clockOut: () => void }): void {
    this.dutyHandlers = handlers
    this.refreshTray()
  }

  setHealthDutyActive(active: boolean, paused = false): void {
    this.dutyPaused = paused
    this.dutyActive = active
    this.refreshTray()
  }

  dismissHealthReminders(kind?: string): void {
    this.reminderQueue = this.reminderQueue.filter((item) => item.sourceType !== 'health' || (kind != null && item.sourceId !== kind))
    const activeMatches = this.activeReminder?.sourceType === 'health' && (kind == null || this.activeReminder.sourceId === kind)
    // Cancelling DB/bubble reminders must also cancel the renderer's current
    // animation and queued events. It cannot infer recording state from hide().
    if (kind == null || activeMatches) this.resetPetInteraction()
    if (activeMatches) this.dismissBubble()
  }

  setReminderDeliveryPaused(paused: boolean): void {
    if (this.reminderDeliveryPaused === paused) return
    this.reminderDeliveryPaused = paused
    if (paused) {
      this.resetPetInteraction()
      this.reminderQueue = this.reminderQueue.filter(item => item.sourceType !== 'health')
      if (this.activeReminder?.sourceType === 'health') {
        this.activeReminder = null
        this.showingReminder = false
        this.pendingHealthId = null
      }
      this.bubbleWindow?.hide()
    } else if (this.activeReminder) {
      this.raiseBubble()
    } else {
      const next = this.reminderQueue.shift()
      if (next) this.presentReminder(next)
    }
  }

  setDisplayPower(off: boolean): void {
    if (this.displayOff === off) return
    this.displayOff = off
    if (off) this.freezePetInteraction()
    else this.scheduleRecover('resume', 600)
  }

  showMain(): void { this.mainWindow?.show(); this.mainWindow?.focus() }
  private freezePetInteraction(): void {
    this.persistPosition()
    this.frozen = true
    if (this.recoverTimer) clearTimeout(this.recoverTimer)
    if (this.hitRegionTimer) clearTimeout(this.hitRegionTimer)
    this.recoverTimer = null
    this.hitRegionTimer = null
    this.pendingRecover = null
    this.resetPetInteraction()
  }

  private checkActivityReturn(): void {
    const now = Date.now()
    const idle = powerMonitor.getSystemIdleTime()
    const returned = idle < 2 && (this.lastIdleSeconds >= 60 || now - this.lastActivityCheck > 10000)
    this.lastIdleSeconds = idle
    this.lastActivityCheck = now
    if (returned && !this.screenLocked && !this.suspended && !this.displayOff && !this.pendingRecover && !this.getPetSettings().paused) {
      this.scheduleRecover('resume', 300)
    }
  }

  private resetPetInteraction(): void {
    this.dragging = false
    this.toastOpen = false
    this.hangMode = 'perch'
    this.pendingPetEvents = []
    // With backgroundThrottling disabled Chromium may stay "visible" while
    // the HWND is hidden. Cancel renderer interaction explicitly over IPC.
    const window = this.petWindow
    if (window && !window.isDestroyed() && !window.webContents.isCrashed()) window.webContents.send('pet:reset-interaction')
  }

  showPet(): void {
    this.resetPetInteraction()
    if (this.getPetSettings().paused) this.store.set('pet', { ...this.getPetSettings(), paused: false })
    this.refreshTray()
    this.scheduleRecover('manual', 0)
  }
  hidePet(): void {
    this.resetPetInteraction()
    if (this.hitRegionTimer) {
      clearTimeout(this.hitRegionTimer)
      this.hitRegionTimer = null
    }
    if (!this.getPetSettings().paused) this.store.set('pet', { ...this.getPetSettings(), paused: true })
    this.petWindow?.hide()
    this.hideBubble()
    this.refreshTray()
  }
  getMainWindow(): BrowserWindow | null { return this.mainWindow }
  isCurrentPetSender(senderId: number): boolean {
    return Boolean(this.petWindow && !this.petWindow.isDestroyed() && this.petWindow.webContents.id === senderId)
  }

  getPetSettings(): PetSettings { return { ...initialSettings, ...(this.store.get('pet') ?? {}) } }
  updatePetSettings(update: Partial<PetSettings>): PetSettings {
    const settings = { ...this.getPetSettings(), ...update }; this.store.set('pet', settings)
    if (update.size) this.applyHangBounds()
    if (settings.paused) this.hidePet()
    else if (update.paused === false) this.showPet()
    else {
      this.refreshTray()
      this.petWindow?.showInactive()
    }
    return settings
  }
  movePet(position: Partial<Pick<PetSettings, 'displayId' | 'x' | 'y'>>): void { this.updatePetSettings(position); this.scheduleRecover('display-metrics', 0) }

  setHangMode(mode: HangMode): void {
    if (mode === 'drop' && this.hangMode === 'perch') {
      this.dragging = false
      this.persistPosition()
    }
    this.hangMode = mode
    if (mode === 'perch') this.toastOpen = false
    this.applyMouseIgnore()
  }

  setToastVisible(visible: boolean): void {
    if (this.toastOpen === visible) return
    this.toastOpen = visible
    this.applyMouseIgnore()
  }

  // Kept for older renderer clients. The native window region owns input;
  // forwarded DOM hover events must never toggle the whole HWND transparent.
  setPointerInside(_inside: boolean): void {}

  nudgePet(dx: number, dy: number): void {
    const window = this.petWindow
    if (!window || window.isDestroyed() || this.frozen || this.getPetSettings().paused || this.hangMode === 'drop') return
    this.dragging = true
    const delta = roundPixelDelta(dx, dy)
    if (!delta.dx && !delta.dy) return
    const extra = this.overlayLeftPad()
    const cur = window.getBounds()
    const next = hangOverlayBounds(this.workArea(), this.getPetSettings().size, {
      x: cur.x + extra + delta.dx,
      y: cur.y + delta.dy
    })
    window.setPosition(Math.round(next.x), Math.round(next.y), false)
  }

  endPetDrag(): void {
    this.dragging = false
    this.persistPosition()
    this.applyMouseIgnore()
  }

  takePendingHealthId(): string | null {
    const id = this.pendingHealthId
    this.pendingHealthId = null
    return id
  }

  getHangMode(): HangMode { return this.hangMode }

  markPetReady(): void {
    this.petListenerReady = true
    const queued = this.pendingPetEvents.splice(0)
    for (const event of queued) this.sendToPet(event)
  }

  emitPet(event: PetEvent): void {
    if (this.reminderDeliveryPaused && (event.action === 'health-water' || event.action === 'health-stand')) return
    console.log('[pet-event]', new Date().toISOString(), event.animation, event.title ?? '', event.message ?? '')
    if (!this.getPetSettings().paused) {
      if (!this.petListenerReady) {
        if (event.reminder?.id) {
          this.pendingPetEvents = this.pendingPetEvents.filter((item) => item.reminder?.id !== event.reminder?.id)
        }
        this.pendingPetEvents.push(event)
      } else {
        this.sendToPet(event)
      }
    }
    this.mainWindow?.webContents.send('pet:event', event)
  }

  private sendToPet(event: PetEvent): void {
    const pet = this.petWindow
    if (!pet || pet.isDestroyed() || this.screenLocked || this.suspended || this.displayOff) return
    if (!pet.isVisible()) pet.showInactive()
    pet.webContents.send('pet:event', event)
  }

  showReminder(reminder: ReminderOccurrence): void {
    if (reminder.sourceType === 'health' && this.reminderDeliveryPaused) return
    if (this.showingReminder) {
      // Health reminders describe the current need, not a backlog to replay.
      if (reminder.sourceType === 'health') {
        this.reminderQueue = this.reminderQueue.filter(item => item.sourceType !== 'health' || item.sourceId !== reminder.sourceId)
      }
      this.reminderQueue.push(reminder)
      return
    }
    this.presentReminder(reminder)
  }

  private presentReminder(reminder: ReminderOccurrence): void {
    const isHealth = reminder.sourceType === 'health'
    const matter = isHealth ? (reminder.sourceId === 'water' ? 'health-water' : 'health-stand') : 'task-due'
    if (isHealth) this.pendingHealthId = reminder.id
    this.showingReminder = true
    this.activeReminder = reminder
    this.emitPet({ ...reactionFor(matter, reminder.title), reminder })
    if (this.getPetSettings().paused) return
    this.unstickMouseIgnore()
    this.raiseBubble(reminder)
  }

  hideBubble(): void {
    this.reminderQueue = []
    this.showingReminder = false
    this.activeReminder = null
    this.bubbleWindow?.hide()
    this.applyMouseIgnore()
  }

  dismissBubble(): void {
    this.showingReminder = false
    this.activeReminder = null
    this.bubbleWindow?.hide()
    this.applyMouseIgnore()
    const next = this.reminderQueue.shift()
    if (next) this.presentReminder(next)
  }

  private raiseBubble(reminder = this.activeReminder): void {
    const window = this.bubbleWindow
    if (!window || window.isDestroyed() || this.getPetSettings().paused || this.reminderDeliveryPaused) return
    this.positionBubble()
    window.setFocusable(true)
    window.setIgnoreMouseEvents(false)
    window.setAlwaysOnTop(true, 'pop-up-menu')
    window.showInactive()
    window.moveTop()
    if (reminder) window.webContents.send('reminder:raised', reminder)
  }

  private workArea() {
    const window = this.petWindow
    if (window && !window.isDestroyed()) return screen.getDisplayMatching(window.getBounds()).workArea
    const settings = this.getPetSettings()
    const display = settings.displayId
      ? screen.getAllDisplays().find((item) => item.id.toString() === settings.displayId)
      : screen.getPrimaryDisplay()
    return (display ?? screen.getPrimaryDisplay()).workArea
  }

  private overlayLeftPad(): number {
    return toastExtra()
  }

  private hangBounds(fromLive = false) {
    const settings = this.getPetSettings()
    const current = fromLive && this.petWindow && !this.petWindow.isDestroyed() ? this.petWindow.getBounds() : null
    const extra = this.overlayLeftPad()
    return hangOverlayBounds(this.workArea(), settings.size, {
      x: current ? current.x + extra : settings.x,
      y: current ? current.y : settings.y
    })
  }

  private applyHangBounds(fromLive = true): void {
    const window = this.petWindow
    if (!window || window.isDestroyed()) return
    const next = this.hangBounds(fromLive)
    const cur = window.getBounds()
    if (cur.x !== next.x || cur.y !== next.y || cur.width !== next.width || cur.height !== next.height) {
      window.setBounds(next)
    }
    this.applyMouseIgnore()
  }

  private restoreOverlayPaint(): void {
    const window = this.petWindow
    if (!window || window.isDestroyed() || !window.isVisible()) return
    // Keep Chromium in control of per-pixel transparency. On Windows,
    // setOpacity calls SetLayeredWindowAttributes; setting it back to 1 does
    // not undo that native compositing-mode change.
    window.webContents.invalidate()
  }

  private applyMouseIgnore(force = false): void {
    const window = this.petWindow
    if (!window || window.isDestroyed() || !window.isVisible() || this.screenLocked || this.suspended || this.displayOff) return
    const bounds = window.getBounds()
    if (!isUsablePetShapeBounds(bounds)) return
    // Whole-window transparency loses the first click before hover IPC can run.
    // A native region admits the sprite immediately and excludes reserved padding.
    window.setIgnoreMouseEvents(false)
    if (process.platform === 'win32' || process.platform === 'linux') {
      const shape = petWindowShape(bounds, this.getPetSettings().size, this.hangMode, this.toastOpen)
      // Empty setShape([]) is an empty HRGN: input can return, but DWM keeps a
      // blank layered bitmap. Nudge a non-empty rect so Chromium must rebuild.
      if (force) {
        window.setShape(shape.map((rect) => ({ ...rect, width: Math.max(1, rect.width - 1) })))
      }
      window.setShape(shape)
      window.webContents.invalidate()
    }
  }

  private unstickMouseIgnore(): void { this.applyMouseIgnore() }

  private scheduleHitRegionRefresh(): void {
    if (this.hitRegionTimer) clearTimeout(this.hitRegionTimer)
    this.hitRegionTimer = setTimeout(() => {
      this.hitRegionTimer = null
      this.applyMouseIgnore(true)
    }, 0)
  }

  private displaysReady(): boolean {
    return screen.getAllDisplays().some((display) => isUsableWorkArea(display.workArea))
  }

  private scheduleRecover(reason: OverlayRecoverReason, delay = 800, retry = false): void {
    if (this.quitting) return
    if (!retry) this.recoverAttempts = 0
    this.pendingRecover = strongerRecoverReason(this.pendingRecover, reason)
    if (this.recoverTimer) clearTimeout(this.recoverTimer)
    if (delay <= 0) {
      this.flushRecover()
      return
    }
    this.recoverTimer = setTimeout(() => this.flushRecover(), delay)
  }

  private flushRecover(): void {
    if (this.recoverTimer) {
      clearTimeout(this.recoverTimer)
      this.recoverTimer = null
    }
    const reason = this.pendingRecover
    this.pendingRecover = null
    if (reason) this.runRecover(reason)
  }

  private runRecover(reason: OverlayRecoverReason): void {
    if (this.quitting || this.screenLocked || this.suspended || this.displayOff) return
    if (!this.displaysReady()) {
      this.frozen = true
      this.retryRecover(reason)
      return
    }
    const plan = overlayRecoverPlan({
      paused: this.getPetSettings().paused,
      displaysReady: this.displaysReady(),
      frozen: this.frozen,
      dragging: this.dragging,
      reason
    })
    this.frozen = plan.freeze
    if (plan.action === 'skip') return
    this.recovering = true
    try {
      if (plan.action === 'rebuild') this.rebuildPetWindow()
      else if (plan.action === 'reassert') this.reassertPetWindow(reason === 'manual')
      else this.softRecoverPet()
      if (plan.action === 'rebuild') this.recreateTray()
      this.unstickMouseIgnore()
      this.restoreBubbleAfterRecover()
      this.recoverAttempts = 0
      this.lastIdleSeconds = powerMonitor.getSystemIdleTime()
      this.lastActivityCheck = Date.now()
    } catch (error) {
      this.frozen = true
      console.warn('[pet-recover]', new Date().toISOString(), reason, error)
      this.retryRecover(reason)
    } finally {
      this.recovering = false
    }
  }

  private retryRecover(reason: OverlayRecoverReason): void {
    // Display enumeration can lag unlock. Retain the intent without requiring
    // another OS event, but do not loop forever on a disconnected desktop.
    if (this.getPetSettings().paused || this.recoverAttempts >= 8) return
    this.recoverAttempts += 1
    this.scheduleRecover(reason, Math.min(500 * this.recoverAttempts, 2000), true)
  }

  private rebuildPetWindow(): void {
    const current = this.petWindow
    if (current && !current.isDestroyed() && isUsablePetShapeBounds(current.getBounds())) {
      const bounds = this.hangBounds(true)
      this.store.set('pet', { ...this.getPetSettings(), x: bounds.x + this.overlayLeftPad(), y: bounds.y })
    }
    this.resetPetInteraction()
    this.petListenerReady = false
    if (this.hitRegionTimer) clearTimeout(this.hitRegionTimer)
    this.hitRegionTimer = null
    // Detach first: late lifecycle events from the old renderer must not
    // reset readiness or trigger recovery of its replacement.
    this.petWindow = null
    if (current && !current.isDestroyed()) {
      current.setClosable(true)
      current.destroy()
    }
    this.createPetWindow()
  }

  private reassertPetWindow(forceShow = false): void {
    const window = this.petWindow
    if (!window || window.isDestroyed() || window.webContents.isCrashed()) {
      this.rebuildPetWindow()
      return
    }
    const wasHidden = !window.isVisible()
    if (!this.getPetSettings().paused && wasHidden) window.showInactive()
    this.ensurePetOnScreen()
    window.setAlwaysOnTop(true, 'floating')
    this.restoreOverlayPaint()
    if (forceShow) window.moveTop()
    this.applyMouseIgnore(wasHidden)
  }

  private softRecoverPet(): void {
    const window = this.petWindow
    if (!window || window.isDestroyed()) {
      this.rebuildPetWindow()
      return
    }
    if (this.hangMode === 'drop' || this.dragging) {
      window.setAlwaysOnTop(true, 'floating')
      return
    }
    window.setAlwaysOnTop(true, 'floating')
    if (!this.getPetSettings().paused && !window.isVisible()) window.showInactive()
    this.ensurePetOnScreen()
    this.restoreOverlayPaint()
    this.applyMouseIgnore()
  }

  private ensurePetOnScreen(): void {
    const window = this.petWindow
    if (!window || window.isDestroyed() || this.hangMode === 'drop' || this.dragging) return
    const bounds = window.getBounds()
    if (!isUsablePetShapeBounds(bounds)) return
    const work = screen.getDisplayMatching(bounds).workArea
    if (!isUsableWorkArea(work)) {
      this.frozen = true
      return
    }
    const extra = this.overlayLeftPad()
    const next = hangOverlayBounds(work, this.getPetSettings().size, { x: bounds.x + extra, y: bounds.y })
    if (bounds.x !== next.x || bounds.y !== next.y || bounds.width !== next.width || bounds.height !== next.height) {
      window.setBounds(next)
    }
  }

  private recreateTray(): void {
    const old = this.tray
    this.tray = null
    if (old) {
      try { old.destroy() } catch { /* already gone */ }
    }
    this.createTray()
  }

  private restoreBubbleAfterRecover(): void {
    if (!this.showingReminder || this.getPetSettings().paused || this.reminderDeliveryPaused) return
    const window = this.bubbleWindow
    if (!window || window.isDestroyed()) {
      this.createBubbleWindow()
    } else if (window.isVisible()) {
      this.positionBubble()
      window.setAlwaysOnTop(true, 'pop-up-menu')
      return
    }
    this.raiseBubble()
  }

  private persistPosition(): void {
    if (this.hangMode === 'drop' || this.dragging || this.recovering || this.frozen) return
    const window = this.petWindow
    if (!window || window.isDestroyed()) return
    const bounds = window.getBounds()
    const extra = this.overlayLeftPad()
    const display = screen.getDisplayMatching(bounds)
    this.store.set('pet', { ...this.getPetSettings(), displayId: display.id.toString(), x: bounds.x + extra, y: bounds.y })
  }

  private positionBubble(): void {
    const pet = this.petWindow?.getBounds(); if (!pet || !this.bubbleWindow) return
    const work = screen.getDisplayMatching(pet).workArea
    const next = reminderBubblePosition(pet, work)
    this.bubbleWindow.setPosition(next.x, next.y)
  }
}
