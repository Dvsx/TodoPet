import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReminderOccurrence } from '../shared/types'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))

import { closeDatabase, getSqlite } from './database'
import { DeviceActivity } from './device-activity'
import { ReminderService } from './reminder-service'

const startedAt = new Date('2026-09-07T01:00:00.000Z')
let reminders: ReminderService
let device: DeviceActivity
let raised: ReminderOccurrence[]

function pendingHealth() {
  return getSqlite().prepare("SELECT source_id, scheduled_at FROM reminder_occurrences WHERE source_type='health' AND status='pending' ORDER BY source_id").all() as Array<{ source_id: string; scheduled_at: string }>
}

function expectFreshIntervals(at: number) {
  expect(pendingHealth()).toEqual([
    { source_id: 'stand', scheduled_at: new Date(at + 60 * 60_000).toISOString() },
    { source_id: 'water', scheduled_at: new Date(at + 45 * 60_000).toISOString() }
  ])
}

// Jump over the unavailable interval without running thousands of individual
// timers, then allow one real heartbeat to exercise the service's due check.
function absentFor(hours: number) {
  vi.setSystemTime(new Date(Date.now() + hours * 60 * 60_000))
  vi.advanceTimersByTime(30_000)
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'todopet-device-integration-'))
  vi.useFakeTimers()
  vi.setSystemTime(startedAt)
  reminders = new ReminderService()
  reminders.init()
  reminders.startSession()
  raised = []
  reminders.onReminder(reminder => raised.push(reminder))
  // These are the recording/delivery callbacks used in index.ts. Only window
  // presentation is omitted; scheduling and persistence use the real services.
  device = new DeviceActivity({
    pauseDelivery: paused => reminders.setDeliveryPaused(paused),
    clearPresentation: () => {},
    pauseRecording: () => { reminders.pauseSession() },
    recordLock: () => { reminders.records.lockScreen(); reminders.resetHealth() },
    resumeRecording: fromLock => {
      const id = fromLock ? reminders.records.unlockScreen() : reminders.records.autoResume()
      if (!id) return
      reminders.resetHealth()
    },
    displayChanged: () => {}
  })
})

afterEach(() => {
  reminders.dispose()
  vi.clearAllTimers()
  vi.useRealTimers()
  closeDatabase()
  rmSync(state.root, { recursive: true, force: true })
})

describe('device activity with durable records and reminder scheduling', () => {
  it.each(['wake input', 'unlock'] as const)('restores full reminder intervals when %s arrives before display-on', signal => {
    vi.advanceTimersByTime(10 * 60_000)
    if (signal === 'unlock') device.lock()
    device.display('off')
    absentFor(8)
    if (signal === 'unlock') device.unlock()
    else device.input()
    expect(reminders.getSession().state).toBe('paused')
    expect(pendingHealth()).toEqual([])
    expect(raised).toEqual([])

    vi.advanceTimersByTime(1000)
    const returnAt = Date.now()
    device.display('on')
    expect(reminders.getSession()).toMatchObject({ active: true, state: 'sitting', segmentStartedAt: new Date(returnAt).toISOString() })
    expectFreshIntervals(returnAt)
    expect(raised).toEqual([])
    vi.advanceTimersByTime(30_000)
    expect(raised).toEqual([])
  })

  it('excludes eight hours of screen-off time and starts fresh intervals only after input', () => {
    vi.advanceTimersByTime(20 * 60_000)
    const offAt = new Date().toISOString()
    device.display('off')
    expect(reminders.getSession()).toMatchObject({ active: false, state: 'paused' })
    expect(pendingHealth()).toEqual([])

    absentFor(8)
    reminders.recover()
    expect(raised).toEqual([])
    expect(pendingHealth()).toEqual([])
    expect(reminders.listPresets().every(preset => preset.nextTriggerAt === null)).toBe(true)
    expect(getSqlite().prepare('SELECT started_at, ended_at FROM health_segments').all()).toEqual([
      { started_at: startedAt.toISOString(), ended_at: offAt }
    ])
    expect(getSqlite().prepare('SELECT heartbeat_at FROM health_record_sessions').get()).toEqual({ heartbeat_at: offAt })

    device.display('on')
    vi.advanceTimersByTime(30_000)
    expect(reminders.getSession().state).toBe('paused')
    expect(raised).toEqual([])
    expect(pendingHealth()).toEqual([])

    const returnAt = Date.now()
    device.input()
    device.input()
    expect(reminders.getSession()).toMatchObject({ active: true, state: 'sitting', segmentStartedAt: new Date(returnAt).toISOString() })
    expectFreshIntervals(returnAt)
    expect(raised).toEqual([])
    expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM health_segments').get()).toEqual({ n: 2 })

    vi.advanceTimersByTime(45 * 60_000 - 1)
    expect(raised).toEqual([])
    vi.advanceTimersByTime(1)
    expect(raised.map(reminder => reminder.sourceId)).toEqual(['water'])
    vi.advanceTimersByTime(15 * 60_000)
    expect(raised.map(reminder => reminder.sourceId)).toEqual(['water', 'stand'])
  })

  it('keeps the locked posture as standing while suppressing water as well as stand prompts', () => {
    vi.advanceTimersByTime(10 * 60_000)
    device.lock()
    device.lock()
    expect(reminders.getSession()).toMatchObject({ active: true, state: 'standing' })
    absentFor(8)
    device.input()
    reminders.recover()
    expect(raised).toEqual([])
    expect(pendingHealth()).toEqual([])
    expect(reminders.getSession()).toMatchObject({ active: true, state: 'standing' })
    expect(getSqlite().prepare("SELECT COUNT(*) AS n FROM health_events WHERE kind='stand'").get()).toEqual({ n: 1 })

    const returnAt = Date.now()
    device.unlock()
    reminders.recover()
    expect(reminders.getSession().state).toBe('sitting')
    expectFreshIntervals(returnAt)
    expect(raised).toEqual([])
  })

  it('waits for all independent power states to clear before resuming', () => {
    device.lock()
    device.display('off')
    device.suspend()
    absentFor(8)
    device.unlock()
    device.display('on')
    device.input()
    expect(reminders.getSession().state).toBe('paused')
    expect(pendingHealth()).toEqual([])
    device.resume()
    reminders.recover()
    expect(reminders.getSession().state).toBe('paused')
    expect(raised).toEqual([])

    const returnAt = Date.now()
    device.input()
    expect(reminders.getSession().state).toBe('sitting')
    expectFreshIntervals(returnAt)
    expect(raised).toEqual([])
  })

  it.each(['manual pause', 'disabled auto-resume'] as const)('respects %s when the screen comes on and input arrives', reason => {
    vi.advanceTimersByTime(10 * 60_000)
    if (reason === 'manual pause') {
      reminders.pauseSession()
      const resumedSegmentId = reminders.records.autoResume()!
      expect(resumedSegmentId).toBeTruthy()
      reminders.records.correctAutoResume(resumedSegmentId, 'pause')
      reminders.resetHealth()
    } else {
      reminders.records.setAutoResume(false)
    }
    device.display('off')
    const segmentsBefore = getSqlite().prepare('SELECT * FROM health_segments').all()
    absentFor(8)
    device.display('on')
    device.input()
    device.input()
    reminders.recover()
    vi.advanceTimersByTime(30_000)
    expect(reminders.getSession()).toMatchObject({ active: false, state: 'paused' })
    expect(getSqlite().prepare('SELECT * FROM health_segments').all()).toEqual(segmentsBefore)
    expect(pendingHealth()).toEqual([])
    expect(raised).toEqual([])
    expect(reminders.listPresets().every(preset => preset.nextTriggerAt === null)).toBe(true)
  })
})
