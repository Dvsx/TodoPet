import { contextBridge, ipcRenderer } from 'electron'
import type { TodoPetApi } from '../shared/types.js'

const subscribe = <T>(channel: string, listener: (value: T) => void) => {
  const wrapped = (_: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: TodoPetApi = {
  tasks: {
    list: (view) => ipcRenderer.invoke('tasks:list', view), create: (input) => ipcRenderer.invoke('tasks:create', input),
    update: (id, input) => ipcRenderer.invoke('tasks:update', id, input), complete: (id) => ipcRenderer.invoke('tasks:complete', id), reopen: (id) => ipcRenderer.invoke('tasks:reopen', id),     archive: (id) => ipcRenderer.invoke('tasks:archive', id), restore: (id) => ipcRenderer.invoke('tasks:restore', id), remove: (id) => ipcRenderer.invoke('tasks:remove', id)
  },
  notes: {
    list: (kind) => ipcRenderer.invoke('notes:list', kind),
    create: (kind, input) => ipcRenderer.invoke('notes:create', kind, input),
    update: (id, input) => ipcRenderer.invoke('notes:update', id, input),
    remove: (id) => ipcRenderer.invoke('notes:remove', id)
  },
  health: {
    autoResumeSetting: () => ipcRenderer.invoke('health:auto-resume-setting'),
    setAutoResume: (enabled) => ipcRenderer.invoke('health:set-auto-resume',enabled),
    correctAutoResume: (id,choice) => ipcRenderer.invoke('health:correct-auto-resume',id,choice),
    records: (start,end) => ipcRenderer.invoke('health:records',start,end),
    action: (action,requestId) => ipcRenderer.invoke('health:action',action,requestId),
    undo: (id) => ipcRenderer.invoke('health:undo',id),
    deleteEvent: (id) => ipcRenderer.invoke('health:delete-event',id),
    editSegment: (id,start,end) => ipcRenderer.invoke('health:edit-segment',id,start,end),
    list: () => ipcRenderer.invoke('health:list'),
    update: (preset) => ipcRenderer.invoke('health:update', preset),
    session: () => ipcRenderer.invoke('health:session'),
    start: () => ipcRenderer.invoke('health:start'),
    stop: () => ipcRenderer.invoke('health:stop'),
    acknowledge: (id) => ipcRenderer.invoke('health:acknowledge', id),
    miss: (id) => ipcRenderer.invoke('health:miss', id),
    snooze: (id, minutes) => ipcRenderer.invoke('health:snooze', id, minutes),
    history: () => ipcRenderer.invoke('health:history')
  },
  pet: {
    getSettings: () => ipcRenderer.invoke('pet:settings'),
    updateSettings: (settings) => ipcRenderer.invoke('pet:update-settings', settings),
    move: (position) => ipcRenderer.invoke('pet:move', position),
    show: () => ipcRenderer.invoke('pet:show'),
    ready: () => ipcRenderer.invoke('pet:ready'),
    setHangMode: (mode) => ipcRenderer.invoke('pet:hang-mode', mode),
    finishHang: (occurrenceId) => ipcRenderer.invoke('pet:hang-finished', occurrenceId),
    setToastVisible: (visible) => ipcRenderer.invoke('pet:toast-visible', visible),
    setPointerInside: (inside) => ipcRenderer.invoke('pet:pointer-inside', inside),
    nudge: (delta) => ipcRenderer.send('pet:nudge', delta),
    endDrag: () => ipcRenderer.send('pet:end-drag')
  },
  window: { minimize: () => ipcRenderer.invoke('window:minimize'), isMaximized: () => ipcRenderer.invoke('window:is-maximized'), toggleMaximize: () => ipcRenderer.invoke('window:maximize'), close: () => ipcRenderer.invoke('window:close'), quit: () => ipcRenderer.invoke('window:quit') },
  events: { onPetReset: (listener) => subscribe('pet:reset-interaction', listener), onTaskChanged: (listener) => subscribe('task:changed', listener), onReminder: (listener) => subscribe('reminder:raised', listener), onHealthSession: (listener) => subscribe('health:session', listener), onMaximized: (listener) => subscribe('window:maximized', listener), onPetEvent: (listener) => subscribe('pet:event', listener) }
}
contextBridge.exposeInMainWorld('todoPet', api)
