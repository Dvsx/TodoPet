export type TaskStatus = 'open' | 'completed' | 'archived'
export type TaskPriority = 'none' | 'low' | 'medium' | 'high'
export type HealthKind = 'water' | 'stand'
export type ReminderSourceType = 'task' | 'health'
export type ReminderStatus = 'pending' | 'fired' | 'acknowledged' | 'snoozed' | 'missed' | 'cancelled'
export type PetAnimation = 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review'

export interface Task {
  id: string
  title: string
  notes: string
  status: TaskStatus
  priority: TaskPriority
  dueAt: string | null
  remindAt: string | null
  revision: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface TaskInput {
  title: string
  notes?: string
  priority?: TaskPriority
  dueAt?: string | null
  remindAt?: string | null
}

export type NoteKind = 'spark' | 'wrap'

export interface Note {
  id: string
  kind: NoteKind
  title: string
  body: string
  createdAt: string
  updatedAt: string
}

export interface NoteInput {
  title: string
  body?: string
}

export interface HealthPreset {
  kind: HealthKind
  enabled: boolean
  intervalMinutes: number
  /** Empty string means reminders start when recording starts. */
  windowStart: string
  /** Empty string means reminders continue until recording stops. */
  windowEnd: string
  weekdays: number[]
  nextTriggerAt: string | null
  lastAcknowledgedAt: string | null
}

export interface HealthSession {
  autoResumeSegmentId?: string | null
  id?: string
  state?: 'idle' | 'sitting' | 'standing' | 'paused'
  segmentStartedAt?: string | null
  active: boolean
  startedAt: string | null
}

export interface ReminderOccurrence {
  id: string
  sourceType: ReminderSourceType
  sourceId: string
  scheduledAt: string
  status: ReminderStatus
  firedAt: string | null
  acknowledgedAt: string | null
  snoozedFromId: string | null
  title: string
}

export interface PetSettings {
  displayId: string | null
  x: number | null
  y: number | null
  size: 'small' | 'medium' | 'large'
  reducedMotion: boolean
  paused: boolean
}

export type HangMode = 'perch' | 'drop'
export type PetAction = 'boot' | 'task-created' | 'task-updated' | 'task-completed' | 'task-due' | 'health-water' | 'health-stand' | 'health-ack' | 'health-duty-start' | 'snoozed'

export interface PetEvent {
  autoResumeSegmentId?: string
  animation: PetAnimation
  title?: string
  message?: string
  reminder?: ReminderOccurrence
  action?: PetAction
  /** When true, keep looping until the next event. Flash poses return to idle. */
  hold?: boolean
}

export interface TodoPetApi {
  tasks: {
    list: (view?: 'today' | 'upcoming' | 'completed' | 'all' | 'archived') => Promise<Task[]>
    create: (input: TaskInput) => Promise<Task>
    update: (id: string, input: Partial<TaskInput>) => Promise<Task>
    complete: (id: string) => Promise<Task>
    reopen: (id: string) => Promise<Task>
    archive: (id: string) => Promise<Task>
    restore: (id: string) => Promise<Task>
    remove: (id: string) => Promise<void>
  }
  notes: {
    list: (kind: NoteKind) => Promise<Note[]>
    create: (kind: NoteKind, input: NoteInput) => Promise<Note>
    update: (id: string, input: Partial<NoteInput>) => Promise<Note>
    remove: (id: string) => Promise<void>
  }
  health: {
    autoResumeSetting: () => Promise<boolean>
    setAutoResume: (enabled: boolean) => Promise<void>
    correctAutoResume: (id: string, choice: 'standing' | 'pause') => Promise<void>
    list: () => Promise<HealthPreset[]>
    update: (preset: HealthPreset) => Promise<HealthPreset>
    session: () => Promise<HealthSession>
    start: () => Promise<HealthSession>
    stop: () => Promise<HealthSession>
    acknowledge: (occurrenceId: string) => Promise<void>
    miss: (occurrenceId: string) => Promise<void>
    snooze: (occurrenceId: string, minutes?: number) => Promise<void>
    history: () => Promise<ReminderOccurrence[]>
    records: (start: string, end: string) => Promise<HealthRecords>
    action: (action: 'water' | 'stand' | 'sit' | 'resume-sitting' | 'resume-standing', requestId: string) => Promise<HealthMutation>
    undo: (eventId: string) => Promise<void>
    deleteEvent: (id: string) => Promise<void>
    editSegment: (id: string, start: string, end: string) => Promise<void>
  }
  pet: {
    getSettings: () => Promise<PetSettings>
    updateSettings: (settings: Partial<PetSettings>) => Promise<PetSettings>
    move: (position: Pick<PetSettings, 'displayId' | 'x' | 'y'>) => Promise<void>
    show: () => Promise<void>
    ready: () => Promise<void>
    setHangMode: (mode: HangMode) => Promise<void>
    finishHang: (occurrenceId?: string) => Promise<void>
    setToastVisible: (visible: boolean) => Promise<void>
    setPointerInside: (inside: boolean) => Promise<void>
    nudge: (delta: { dx: number; dy: number }) => void
    endDrag: () => void
  }
  window: {
    minimize: () => Promise<void>
    isMaximized: () => Promise<boolean>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    quit: () => Promise<void>
  }
  events: {
    onPetReset: (listener: () => void) => () => void
    onTaskChanged: (listener: (task: Task) => void) => () => void
    onReminder: (listener: (reminder: ReminderOccurrence) => void) => () => void
    onHealthSession: (listener: (session: HealthSession) => void) => () => void
    onMaximized: (listener: (maximized: boolean) => void) => () => void
    onPetEvent: (listener: (event: PetEvent) => void) => () => void
  }
}

declare global {
  interface Window {
    todoPet: TodoPetApi
  }
}

export interface HealthSegment { id: string; sessionId: string; posture: 'sitting' | 'standing'; start: string; end: string | null }
export interface HealthRecordEvent { id: string; sessionId: string | null; kind: HealthKind; at: string; source: 'manual' | 'reminder' | 'legacy'; deletedAt: string | null }
export interface HealthRecords { segments: HealthSegment[]; events: HealthRecordEvent[] }
export interface HealthMutation { session: HealthSession; eventId: string | null }
