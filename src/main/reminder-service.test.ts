import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HealthPreset, HealthSession, Task } from '../shared/types'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))

import { closeDatabase, getSqlite } from './database.js'
import { nextInSession, ReminderService } from './reminder-service'

const water: HealthPreset = { kind: 'water', enabled: true, intervalMinutes: 45, windowStart: '09:00', windowEnd: '18:00', weekdays: [1,2,3,4,5], nextTriggerAt: null, lastAcknowledgedAt: null }
const noon = new Date('2026-09-07T04:00:00.000Z')
const duty: HealthSession = { active: true, startedAt: noon.toISOString() }
const roots: string[] = []
const tempRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'todopet-remind-')); roots.push(dir); return dir }

afterEach(() => {
  vi.useRealTimers()
  closeDatabase()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function pendingHealth(sourceId?: string) {
  const sql = sourceId
    ? "SELECT * FROM reminder_occurrences WHERE source_type='health' AND source_id=? AND status='pending'"
    : "SELECT * FROM reminder_occurrences WHERE source_type='health' AND status='pending'"
  return (sourceId ? getSqlite().prepare(sql).all(sourceId) : getSqlite().prepare(sql).all()) as Array<{ id: string; source_id: string; scheduled_at: string; status: string }>
}

function boot(startDuty = true): ReminderService {
  vi.useFakeTimers()
  vi.setSystemTime(noon)
  state.root = tempRoot()
  const service = new ReminderService()
  service.init()
  if (startDuty) service.startSession()
  return service
}

describe('nextInSession', () => {
  it('schedules the first reminder after the interval', () => {
    expect(nextInSession(water, duty, noon)?.toISOString()).toBe('2026-09-07T04:45:00.000Z')
  })
  it('schedules the next allowed window instead of notifying outside it', () => {
    expect(nextInSession(water, duty, new Date('2026-09-07T09:30:00.000Z'))?.toISOString()).toBe('2026-09-08T01:45:00.000Z')
  })
  it('defers reminders outside the configured window even when recording', () => {
    const late: HealthSession = { active: true, startedAt: '2026-09-07T11:00:00.000Z' }
    expect(nextInSession(water, late, new Date('2026-09-07T11:00:00.000Z'))?.toISOString()).toBe('2026-09-08T01:45:00.000Z')
  })
  it('schedules from recording start when the window start is empty', () => {
    const morning = new Date('2026-09-07T00:00:00.000Z')
    const fromRecording = { ...water, windowStart: '' }
    expect(nextInSession(fromRecording, { active: true, startedAt: morning.toISOString() }, morning)?.toISOString()).toBe('2026-09-07T00:45:00.000Z')
  })
  it('still waits for a custom clock start when recording begins earlier', () => {
    const morning = new Date('2026-09-07T00:00:00.000Z')
    expect(nextInSession(water, { active: true, startedAt: morning.toISOString() }, morning)?.toISOString()).toBe('2026-09-07T01:45:00.000Z')
  })
  it('keeps reminding after 18:00 when the window end is empty', () => {
    const evening = new Date('2026-09-07T09:30:00.000Z')
    const openEnded = { ...water, windowStart: '', windowEnd: '' }
    expect(nextInSession(openEnded, { active: true, startedAt: evening.toISOString() }, evening)?.toISOString()).toBe('2026-09-07T10:15:00.000Z')
  })
  it('returns no occurrence when idle or disabled', () => {
    expect(nextInSession(water, { active: false, startedAt: null }, noon)).toBeNull()
    expect(nextInSession({ ...water, enabled: false }, duty, noon)).toBeNull()
  })
})

describe('ReminderService health session', () => {
  it('does not schedule health reminders until work starts', () => {
    const service = boot(false)
    expect(service.getSession()).toMatchObject({ active: false, startedAt: null })
    expect(pendingHealth()).toEqual([])
  })

  it('defaults new presets to follow recording with no clock window', () => {
    const service = boot(false)
    expect(service.listPresets().every((preset) => preset.windowStart === '' && preset.windowEnd === '')).toBe(true)
  })

  it('migrates the factory 09:00 start to follow recording', () => {
    vi.useFakeTimers()
    vi.setSystemTime(noon)
    state.root = tempRoot()
    const db = getSqlite()
    db.prepare('INSERT INTO health_presets VALUES (?,?,?,?,?,?,?,?)').run('water', 1, 45, '09:00', '18:00', '[1,2,3,4,5]', null, null)
    db.prepare('INSERT INTO health_presets VALUES (?,?,?,?,?,?,?,?)').run('stand', 1, 60, '08:30', '19:00', '[1,2,3,4,5]', null, null)
    const service = new ReminderService()
    service.init()
    const presets = Object.fromEntries(service.listPresets().map((preset) => [preset.kind, { start: preset.windowStart, end: preset.windowEnd }]))
    expect(presets).toEqual({ water: { start: '', end: '' }, stand: { start: '08:30', end: '19:00' } })
    const water = service.listPresets().find((preset) => preset.kind === 'water')!
    service.updatePreset({ ...water, windowStart: '09:00' })
    service.init()
    expect(service.listPresets().find((preset) => preset.kind === 'water')?.windowStart).toBe('09:00')
    service.updatePreset({ ...service.listPresets().find((preset) => preset.kind === 'water')!, windowStart: '' })
    expect(service.listPresets().find((preset) => preset.kind === 'water')?.windowStart).toBe('')
  })

  it('starts the first reminder after the interval instead of immediately', () => {
    boot()
    const waterRow = pendingHealth('water')[0]
    const standRow = pendingHealth('stand')[0]
    expect(waterRow).toBeTruthy()
    expect(standRow).toBeTruthy()
    expect(new Date(waterRow.scheduled_at).getTime()).toBe(noon.getTime() + 45 * 60_000)
    expect(new Date(standRow.scheduled_at).getTime()).toBe(noon.getTime() + 60 * 60_000)
  })

  it('cancels pending health reminders when work stops', () => {
    const service = boot()
    expect(pendingHealth().length).toBe(2)
    service.stopSession()
    expect(service.getSession().active).toBe(false)
    expect(pendingHealth()).toEqual([])
  })

  it('does not keep scheduling a disabled preset', () => {
    const service = boot(false)
    const stand = service.listPresets().find((item) => item.kind === 'stand')!
    service.updatePreset({ ...stand, enabled: false })
    service.startSession()
    expect(pendingHealth('water')).toHaveLength(1)
    expect(pendingHealth('stand')).toHaveLength(0)
  })

  it('pauses a recovered session instead of firing leftovers', () => {
    const service = boot()
    expect(service.getSession().active).toBe(true)
    vi.setSystemTime(new Date('2026-09-08T04:00:00.000Z'))
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))
    service.init()
    expect(raised).toEqual([])
    expect(service.getSession().active).toBe(false)
    expect(pendingHealth()).toEqual([])
  })

  it('continues recording past the window end and defers notifications', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-07T09:50:00.000Z'))
    state.root = tempRoot()
    const service = new ReminderService()
    service.init()
    service.startSession()
    expect(service.getSession().active).toBe(true)
    expect(pendingHealth()).toHaveLength(2)
    vi.advanceTimersByTime(10 * 60_000)
    expect(service.getSession().active).toBe(true)
  })
})

describe('ReminderService health fires', () => {
  it('discards health prompts during a long delivery pause and restarts full intervals on return', () => {
    const service = boot()
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))
    vi.advanceTimersByTime(45 * 60_000)
    expect(raised).toEqual(['water'])
    raised.length = 0

    service.setDeliveryPaused(true)
    expect(pendingHealth()).toEqual([])
    expect(service.listPresets().every((preset) => preset.nextTriggerAt === null)).toBe(true)
    expect(getSqlite().prepare("SELECT COUNT(*) AS n FROM reminder_occurrences WHERE source_type='health' AND status='fired'").get()).toEqual({ n: 0 })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(8 * 60 * 60_000)
    service.refresh()
    service.recover()
    expect(raised).toEqual([])
    expect(pendingHealth()).toEqual([])
    expect(vi.getTimerCount()).toBe(1)

    const returnedAt = Date.now()
    service.setDeliveryPaused(false)
    service.setDeliveryPaused(false)
    expect(raised).toEqual([])
    expect(pendingHealth('water').map((row) => Date.parse(row.scheduled_at))).toEqual([returnedAt + 45 * 60_000])
    expect(pendingHealth('stand').map((row) => Date.parse(row.scheduled_at))).toEqual([returnedAt + 60 * 60_000])
    vi.advanceTimersByTime(45 * 60_000 - 1)
    expect(raised).toEqual([])
    vi.advanceTimersByTime(1)
    expect(raised).toEqual(['water'])
  })

  it('suppresses water while locked even when standing recording remains active', () => {
    const service = boot()
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))
    service.setDeliveryPaused(true)
    service.records.lockScreen()
    service.resetHealth()
    expect(service.getSession()).toMatchObject({ active: true, state: 'standing' })
    vi.advanceTimersByTime(2 * 60 * 60_000)
    expect(raised).toEqual([])
    expect(pendingHealth()).toEqual([])

    service.records.unlockScreen()
    service.refresh()
    service.setDeliveryPaused(false)
    expect(service.getSession().state).toBe('sitting')
    expect(pendingHealth('water')[0].scheduled_at).toBe(new Date(Date.now() + 45 * 60_000).toISOString())
    expect(pendingHealth('stand')[0].scheduled_at).toBe(new Date(Date.now() + 60 * 60_000).toISOString())
  })

  it('keeps task reminders pending while unavailable and delivers them once on return', () => {
    const service = boot()
    const task: Task = { id: 'paused-task', title: 'Call back', notes: '', status: 'open', priority: 'none', dueAt: null, remindAt: new Date(Date.now() + 10 * 60_000).toISOString(), revision: 1, createdAt: noon.toISOString(), updatedAt: noon.toISOString(), completedAt: null }
    service.syncTaskReminder(task)
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))
    service.setDeliveryPaused(true)
    vi.advanceTimersByTime(2 * 60 * 60_000)
    service.recover()
    expect(raised).toEqual([])
    expect(getSqlite().prepare("SELECT status FROM reminder_occurrences WHERE source_type='task' AND source_id=?").get(task.id)).toEqual({ status: 'pending' })
    expect(vi.getTimerCount()).toBe(1)

    service.setDeliveryPaused(false)
    service.recover()
    service.setDeliveryPaused(false)
    expect(raised).toEqual([task.id])
    expect(getSqlite().prepare("SELECT status FROM reminder_occurrences WHERE source_type='task' AND source_id=?").get(task.id)).toEqual({ status: 'fired' })
  })

  it('does not replay health intervals after a long event-loop pause without a power event', () => {
    const service = boot()
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))
    const originalIds = pendingHealth().map((row) => row.id)
    vi.setSystemTime(new Date(noon.getTime() + 4 * 60 * 60_000))
    vi.advanceTimersByTime(30_000)
    expect(raised).toEqual([])
    for (const id of originalIds) {
      expect(getSqlite().prepare('SELECT status FROM reminder_occurrences WHERE id=?').get(id)).toEqual({ status: 'missed' })
    }
    expect(pendingHealth('water')[0].scheduled_at).toBe(new Date(Date.now() + 45 * 60_000).toISOString())
    expect(pendingHealth('stand')[0].scheduled_at).toBe(new Date(Date.now() + 60 * 60_000).toISOString())
  })

  it('recover discards all overdue health intervals and waits a full interval', () => {
    const service = boot()
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))
    vi.setSystemTime(new Date(noon.getTime() + 4 * 60 * 60_000))
    service.recover()
    vi.advanceTimersByTime(1)
    expect(raised).toEqual([])
    expect(Date.parse(pendingHealth('water')[0].scheduled_at)).toBe(noon.getTime() + (4 * 60 + 45) * 60_000)
    expect(Date.parse(pendingHealth('stand')[0].scheduled_at)).toBe(noon.getTime() + 5 * 60 * 60_000)
  })

  it('does not fire leftover health reminders when the app starts', () => {
    const service = boot()
    const db = getSqlite()
    db.prepare("UPDATE reminder_occurrences SET status='fired', fired_at=?, scheduled_at=? WHERE source_type='health' AND source_id='water'").run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString())
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))
    service.init()
    expect(raised.filter((kind) => kind === 'water')).toEqual([])
    const rows = db.prepare("SELECT status, scheduled_at FROM reminder_occurrences WHERE source_type='health' AND source_id='water' ORDER BY scheduled_at DESC").all() as Array<{ status: string; scheduled_at: string }>
    expect(rows.some((row) => row.status === 'missed')).toBe(true)
    const next = rows.find((row) => row.status === 'pending')
    expect(next).toBeUndefined()
    expect(service.getSession().state).toBe('paused')
  })

  it('keeps a fired health reminder until the user taps it', () => {
    const service = boot()
    const db = getSqlite()
    db.prepare("UPDATE reminder_occurrences SET status='fired', fired_at=? WHERE source_type='health' AND source_id='water' AND status='pending'").run(new Date().toISOString())
    service.recover()
    const fired = db.prepare("SELECT COUNT(*) AS n FROM reminder_occurrences WHERE source_type='health' AND source_id='water' AND status='fired'").get() as { n: number }
    expect(fired.n).toBe(1)
  })

  it('records a miss and schedules the next water reminder', () => {
    const service = boot()
    const db = getSqlite()
    const row = db.prepare("SELECT id FROM reminder_occurrences WHERE source_type='health' AND source_id='water' AND status='pending'").get() as { id: string }
    db.prepare("UPDATE reminder_occurrences SET status='fired', fired_at=? WHERE id=?").run(new Date().toISOString(), row.id)
    service.miss(row.id)
    expect(db.prepare("SELECT status FROM reminder_occurrences WHERE id=?").get(row.id) as { status: string }).toEqual({ status: 'missed' })
    const history = service.listHealthHistory()
    expect(history.some((item) => item.id === row.id && item.status === 'missed')).toBe(true)
    const next = db.prepare("SELECT COUNT(*) AS n FROM reminder_occurrences WHERE source_type='health' AND source_id='water' AND status='pending'").get() as { n: number }
    expect(next.n).toBe(1)
  })

  it('keeps a future health reminder pending instead of firing it on recover', () => {
    const service = boot()
    const db = getSqlite()
    const later = new Date(Date.now() + 45 * 60_000).toISOString()
    db.prepare("UPDATE reminder_occurrences SET scheduled_at=? WHERE source_type='health' AND source_id='stand' AND status='pending'").run(later)
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))
    service.recover()
    expect(raised).not.toContain('stand')
    const stand = db.prepare("SELECT status, scheduled_at FROM reminder_occurrences WHERE source_type='health' AND source_id='stand' AND status='pending'").get() as { status: string; scheduled_at: string }
    expect(stand.status).toBe('pending')
    expect(stand.scheduled_at).toBe(later)
  })

  it('does not notify overdue health during init', () => {
    const service = boot()
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))
    const db = getSqlite()
    db.prepare("UPDATE reminder_occurrences SET scheduled_at=? WHERE source_type='health' AND status='pending'").run(new Date(Date.now() - 60_000).toISOString())
    service.init()
    expect(raised).toEqual([])
    const pending = db.prepare("SELECT scheduled_at FROM reminder_occurrences WHERE source_type='health' AND status='pending'").all() as Array<{ scheduled_at: string }>
    expect(pending.length).toBe(0)
    expect(pending.every((row) => new Date(row.scheduled_at).getTime() > Date.now())).toBe(true)
  })

  it('schedules the next water reminder after the fired one is acknowledged', () => {
    const service = boot()
    const db = getSqlite()
    const row = db.prepare("SELECT id FROM reminder_occurrences WHERE source_type='health' AND source_id='water' AND status='pending'").get() as { id: string }
    db.prepare("UPDATE reminder_occurrences SET status='fired', fired_at=? WHERE id=?").run(new Date().toISOString(), row.id)
    service.acknowledge(row.id)
    expect(service.listHealthHistory().some((item) => item.id === row.id && item.status === 'acknowledged')).toBe(true)
    const next = db.prepare("SELECT COUNT(*) AS n FROM reminder_occurrences WHERE source_type='health' AND source_id='water' AND status='pending'").get() as { n: number }
    expect(next.n).toBe(1)
  })

  it('keeps scheduling stand after it fires even if water is acknowledged first', () => {
    const service = boot()
    const raised: string[] = []
    service.onReminder((reminder) => raised.push(reminder.sourceId))

    vi.advanceTimersByTime(45 * 60_000)
    expect(raised).toContain('water')
    vi.advanceTimersByTime(15 * 60_000)
    expect(raised).toContain('stand')

    const db = getSqlite()
    const waterFired = db.prepare("SELECT id FROM reminder_occurrences WHERE source_id='water' AND status='fired'").get() as { id: string }
    service.acknowledge(waterFired.id)

    const standPending = db.prepare("SELECT scheduled_at FROM reminder_occurrences WHERE source_id='stand' AND status='pending'").get() as { scheduled_at: string } | undefined
    expect(standPending).toBeTruthy()
    expect(new Date(standPending!.scheduled_at).getTime()).toBeGreaterThan(Date.now())

    const stand = service.listPresets().find((item) => item.kind === 'stand')
    expect(stand?.nextTriggerAt).toBeTruthy()
    expect(new Date(stand!.nextTriggerAt!).getTime()).toBeGreaterThan(Date.now())

    raised.length = 0
    vi.advanceTimersByTime(60 * 60_000)
    expect(raised).toContain('stand')
    const missed = db.prepare("SELECT COUNT(*) AS n FROM reminder_occurrences WHERE source_id='stand' AND status='missed'").get() as { n: number }
    expect(missed.n).toBe(1)
  })
})
