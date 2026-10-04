import { randomUUID } from 'node:crypto'
import { app, ipcMain, powerMonitor } from 'electron'
import { z } from 'zod'
import { closeDatabase } from './database.js'
import { NoteService } from './note-service.js'
import { ReminderService } from './reminder-service.js'
import { TaskService } from './task-service.js'
import { WindowManager } from './window-manager.js'
import { DeviceActivity } from './device-activity.js'
import { startDisplayPowerMonitor } from './display-power-monitor.js'
import { reactionFor } from '../shared/pet-reactions.js'
import type { HangMode, HealthPreset, HealthSession, NoteInput, NoteKind, PetSettings, TaskInput } from '../shared/types.js'

// Screen-off / modern standby marks the overlay as occluded. Chromium then
// freezes its compositor; after wake the transparent HWND often never paints
// again. Keep the pet's renderer and the occluded-window policy alive.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-background-timer-throttling')

const taskInputSchema = z.object({ title: z.string().trim().min(1).max(240), notes: z.string().max(10000).optional(), priority: z.enum(['none', 'low', 'medium', 'high']).optional(), dueAt: z.string().nullable().optional(), remindAt: z.string().nullable().optional() })
const noteKindSchema = z.enum(['spark', 'wrap'])
const noteInputSchema = z.object({ title: z.string().trim().min(1).max(240), body: z.string().max(10000).optional() })
const clockOrEmpty = z.string().regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/)
const healthSchema = z.object({ kind: z.enum(['water', 'stand']), enabled: z.boolean(), intervalMinutes: z.number().int().min(5).max(360), windowStart: clockOrEmpty, windowEnd: clockOrEmpty, weekdays: z.array(z.number().int().min(1).max(7)).min(1), nextTriggerAt: z.string().nullable(), lastAcknowledgedAt: z.string().nullable() }).refine(p=>!p.windowStart || !p.windowEnd || p.windowStart<p.windowEnd,'提醒结束时间需晚于开始时间')
const settingsSchema = z.object({ displayId: z.string().nullable().optional(), x: z.number().nullable().optional(), y: z.number().nullable().optional(), size: z.enum(['small', 'medium', 'large']).optional(), reducedMotion: z.boolean().optional(), paused: z.boolean().optional() })

const taskService = new TaskService()
const noteService = new NoteService()
const reminderService = new ReminderService()
const windowManager = new WindowManager()

function validateSender(event: { sender: Electron.WebContents; senderFrame: Electron.WebFrameMain | null }): void {
  const url = event.senderFrame?.url || event.sender.getURL()
  const dev = process.env.ELECTRON_RENDERER_URL
  if (!url || (!url.startsWith('file:') && (!dev || !url.startsWith(dev)))) throw new Error('未授权的调用来源')
}

function registerIpc(): void {
  ipcMain.handle('health:auto-resume-setting',event=>{validateSender(event);return reminderService.records.autoResumeEnabled()})
  ipcMain.handle('health:set-auto-resume',(event,enabled)=>{validateSender(event);reminderService.records.setAutoResume(z.boolean().parse(enabled))})
  ipcMain.handle('health:correct-auto-resume',(event,id,choice)=>{
    validateSender(event)
    reminderService.records.correctAutoResume(z.string().uuid().parse(id),z.enum(['standing','pause']).parse(choice))
    reminderService.resetHealth()
  })
  ipcMain.handle('tasks:list', (event, view) => { validateSender(event); return taskService.list(view) })
  ipcMain.handle('tasks:create', (event, input: TaskInput) => { validateSender(event); const task = taskService.create(taskInputSchema.parse(input)); windowManager.emitPet(reactionFor('task-created', task.title)); return task })
  ipcMain.handle('tasks:update', (event, id, input) => { validateSender(event); return taskService.update(z.string().uuid().parse(id), taskInputSchema.partial().parse(input)) })
  ipcMain.handle('tasks:complete', (event, id) => { validateSender(event); const task = taskService.complete(z.string().uuid().parse(id)); windowManager.emitPet(reactionFor('task-completed', task.title)); return task })
  ipcMain.handle('tasks:reopen', (event, id) => { validateSender(event); const task = taskService.reopen(z.string().uuid().parse(id)); windowManager.emitPet(reactionFor('task-updated', task.title)); return task })
  ipcMain.handle('tasks:archive', (event, id) => { validateSender(event); return taskService.archive(z.string().uuid().parse(id)) })
  ipcMain.handle('tasks:restore', (event, id) => { validateSender(event); const task = taskService.restore(z.string().uuid().parse(id)); windowManager.emitPet(reactionFor('task-updated', task.title)); return task })
  ipcMain.handle('tasks:remove', (event, id) => { validateSender(event); taskService.remove(z.string().uuid().parse(id)); return undefined })
  ipcMain.handle('notes:list', (event, kind: NoteKind) => { validateSender(event); return noteService.list(noteKindSchema.parse(kind)) })
  ipcMain.handle('notes:create', (event, kind: NoteKind, input: NoteInput) => { validateSender(event); return noteService.create(noteKindSchema.parse(kind), noteInputSchema.parse(input)) })
  ipcMain.handle('notes:update', (event, id, input) => { validateSender(event); return noteService.update(z.string().uuid().parse(id), noteInputSchema.partial().parse(input)) })
  ipcMain.handle('notes:remove', (event, id) => { validateSender(event); noteService.remove(z.string().uuid().parse(id)); return undefined })
  ipcMain.handle('health:records', (event,start,end) => {
    validateSender(event);const a=z.string().datetime().parse(start),b=z.string().datetime().parse(end)
    if(a>=b || Date.parse(b)-Date.parse(a)>370*86400000)throw new Error('日期范围无效')
    return reminderService.records.records(a,b)
  })
  ipcMain.handle('health:action',(event,action,requestId)=>{validateSender(event);const result=reminderService.action(z.enum(['water','stand','sit','resume-sitting','resume-standing']).parse(action),z.string().uuid().parse(requestId));windowManager.dismissHealthReminders(action==='water'?'water':'stand');return result})
  ipcMain.handle('health:undo',(event,id)=>{validateSender(event);reminderService.records.undo(z.string().uuid().parse(id));reminderService.resetHealth()})
  ipcMain.handle('health:delete-event',(event,id)=>{validateSender(event);reminderService.records.deleteEvent(z.string().uuid().parse(id));reminderService.refresh()})
  ipcMain.handle('health:edit-segment',(event,id,start,end)=>{validateSender(event);reminderService.records.editSegment(z.string().uuid().parse(id),z.string().datetime().parse(start),z.string().datetime().parse(end));reminderService.refresh()})
  ipcMain.handle('health:list', (event) => { validateSender(event); return reminderService.listPresets() })
  ipcMain.handle('health:update', (event, preset: HealthPreset) => { validateSender(event); return reminderService.updatePreset(healthSchema.parse(preset)) })
  ipcMain.handle('health:session', (event) => { validateSender(event); return reminderService.getSession() })
  ipcMain.handle('health:start', (event) => { validateSender(event); return startDuty() })
  ipcMain.handle('health:stop', (event) => { validateSender(event); return stopDuty() })
  ipcMain.handle('health:acknowledge', (event, occurrenceId) => {
    validateSender(event)
    try {
      const occurrence = reminderService.acknowledge(z.string().uuid().parse(occurrenceId))
      if (occurrence.sourceType === 'health') windowManager.emitPet(reactionFor('health-ack'))
    } catch(error) { if(!(error instanceof Error && error.message==='提醒不存在'))throw error }
    windowManager.dismissBubble()
  })
  ipcMain.handle('health:miss', (event, occurrenceId) => {
    validateSender(event)
    try { reminderService.miss(z.string().uuid().parse(occurrenceId)) } catch { /* preview UUID or already gone */ }
    windowManager.dismissBubble()
  })
  ipcMain.handle('health:history', (event) => { validateSender(event); return reminderService.listHealthHistory() })
  ipcMain.handle('health:snooze', (event, occurrenceId, minutes) => {
    validateSender(event)
    try {
      reminderService.snooze(z.string().uuid().parse(occurrenceId), z.number().int().min(1).max(120).optional().parse(minutes))
      windowManager.emitPet(reactionFor('snoozed'))
    } catch { /* preview UUID or already gone */ }
    windowManager.dismissBubble()
  })
  ipcMain.handle('pet:settings', (event) => { validateSender(event); return windowManager.getPetSettings() })
  ipcMain.handle('pet:update-settings', (event, settings: Partial<PetSettings>) => { validateSender(event); return windowManager.updatePetSettings(settingsSchema.parse(settings)) })
  ipcMain.handle('pet:move', (event, position) => { validateSender(event); windowManager.movePet(settingsSchema.pick({ displayId: true, x: true, y: true }).parse(position)); return undefined })
  ipcMain.handle('pet:show', (event) => { validateSender(event); windowManager.showPet() })
  ipcMain.handle('pet:ready', (event) => {
    validateSender(event)
    if (!windowManager.isCurrentPetSender(event.sender.id)) return
    windowManager.markPetReady()
  })
  ipcMain.handle('pet:hang-mode', (event, mode: HangMode) => {
    validateSender(event)
    if (!windowManager.isCurrentPetSender(event.sender.id)) return
    windowManager.setHangMode(z.enum(['perch', 'drop']).parse(mode))
  })
  ipcMain.handle('pet:hang-finished', (event) => {
    validateSender(event)
    if (!windowManager.isCurrentPetSender(event.sender.id)) return
    windowManager.setHangMode('perch')
  })
  ipcMain.handle('pet:toast-visible', (event, visible) => {
    validateSender(event)
    if (!windowManager.isCurrentPetSender(event.sender.id)) return
    windowManager.setToastVisible(z.boolean().parse(visible))
  })
  ipcMain.handle('pet:pointer-inside', (event, inside) => {
    validateSender(event)
    if (!windowManager.isCurrentPetSender(event.sender.id)) return
    windowManager.setPointerInside(z.boolean().parse(inside))
  })
  ipcMain.on('pet:nudge', (event, delta) => {
    validateSender(event)
    if (!windowManager.isCurrentPetSender(event.sender.id)) return
    const parsed = z.object({ dx: z.number().finite(), dy: z.number().finite() }).parse(delta)
    windowManager.nudgePet(parsed.dx, parsed.dy)
  })
  ipcMain.on('pet:end-drag', (event) => {
    validateSender(event)
    if (!windowManager.isCurrentPetSender(event.sender.id)) return
    windowManager.endPetDrag()
  })
  ipcMain.handle('window:minimize', (event) => { validateSender(event); windowManager.getMainWindow()?.minimize() })
  ipcMain.handle('window:is-maximized', (event) => { validateSender(event); return windowManager.isMainMaximized() })
  ipcMain.handle('window:maximize', (event) => { validateSender(event); return windowManager.toggleMainMaximize() })
  ipcMain.handle('window:close', (event) => { validateSender(event); windowManager.getMainWindow()?.hide() })
  ipcMain.handle('window:quit', (event) => { validateSender(event); clockOut() })
}

function startDuty(): HealthSession {
  const before = reminderService.getSession()
  if(before.state==='paused'){windowManager.showMain();return before}
  const session = reminderService.startSession()
  if (!before.active && session.active) windowManager.emitPet(reactionFor('health-duty-start'))
  return session
}

function ensureSittingOnLaunch(): void {
  const session = reminderService.getSession()
  if (session.state === 'sitting' || session.state === 'standing') return
  if (!session.startedAt) {
    reminderService.startSession()
    return
  }
  if (session.state === 'paused') reminderService.action('resume-sitting', randomUUID())
}

function stopDuty(): HealthSession {
  return reminderService.stopSession()
}

function clockOut(): void {
  reminderService.stopSession()
  windowManager.quit()
}

function broadcastSession(session: HealthSession): void {
  windowManager.setHealthDutyActive(session.active,session.state==='paused')
  windowManager.getMainWindow()?.webContents.send('health:session', session)
  if (!session.active) windowManager.dismissHealthReminders()
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.harden.todopet')
  registerIpc()
  taskService.onChanged((task) => {
    if (taskService.get(task.id)) reminderService.syncTaskReminder(task)
    else reminderService.recover()
    windowManager.getMainWindow()?.webContents.send('task:changed', task)
  })
  reminderService.onReminder((reminder) => {
    if (reminder.sourceType === 'health' && windowManager.getPetSettings().paused) {
      try { reminderService.miss(reminder.id) } catch { /* already gone */ }
      return
    }
    windowManager.getMainWindow()?.webContents.send('reminder:raised', reminder)
    windowManager.showReminder(reminder)
  })
  reminderService.onSessionChange(broadcastSession)
  await windowManager.create()
  windowManager.bindHealthDuty({ start: startDuty, stop: stopDuty, clockOut })
  reminderService.init()
  ensureSittingOnLaunch()
  windowManager.setHealthDutyActive(reminderService.getSession().active,reminderService.getSession().state==='paused')
  windowManager.emitPet(reactionFor('boot'))
  let previousIdle = powerMonitor.getSystemIdleTime()
  const device = new DeviceActivity({
    pauseDelivery: paused => {
      windowManager.setReminderDeliveryPaused(paused)
      reminderService.setDeliveryPaused(paused)
    },
    clearPresentation: () => windowManager.dismissHealthReminders(),
    pauseRecording: () => { reminderService.pauseSession() },
    recordLock: () => { reminderService.records.lockScreen(); reminderService.resetHealth() },
    resumeRecording: fromLock => {
      const id = fromLock ? reminderService.records.unlockScreen() : reminderService.records.autoResume()
      if (!id) return
      reminderService.resetHealth()
      windowManager.emitPet({animation:'waving',message:'已坐回来 · 开始记录',autoResumeSegmentId:id})
    },
    displayChanged: off => windowManager.setDisplayPower(off)
  })
  const tryResume = () => {
    if (powerMonitor.getSystemIdleState(60) !== 'locked') device.input()
  }
  powerMonitor.on('lock-screen', () => device.lock())
  powerMonitor.on('suspend', () => device.suspend())
  powerMonitor.on('resume', () => { device.resume(); previousIdle=powerMonitor.getSystemIdleTime(); reminderService.recover() })
  powerMonitor.on('unlock-screen', () => { device.unlock(); reminderService.recover() })
  if (powerMonitor.getSystemIdleState(60) === 'locked') device.lock()
  // The helper reports real display power state. Keep this process-local event
  // as the single dispatch path for native notifications and regression tests.
  const onDisplayPower = (state: 'off' | 'on' | 'dim') => device.display(state)
  const displayPowerEvents = app as NodeJS.EventEmitter
  displayPowerEvents.on('todopet:display-power', onDisplayPower)
  const stopDisplayMonitor = startDisplayPowerMonitor(state => displayPowerEvents.emit('todopet:display-power', state))
  // Input resets the OS idle counter. Waking alone is not evidence of a return.
  const activityTimer=setInterval(()=>{
    const idle=powerMonitor.getSystemIdleTime()
    if(idle<previousIdle || idle===0)tryResume()
    previousIdle=idle
  },1000)
  if(previousIdle<2)tryResume()
  app.once('before-quit',()=>{ clearInterval(activityTimer); stopDisplayMonitor(); displayPowerEvents.removeListener('todopet:display-power', onDisplayPower) })
})

app.on('window-all-closed', () => { /* Keep running in the tray. */ })
app.on('before-quit', () => { reminderService.pauseSession();reminderService.dispose();closeDatabase() })
