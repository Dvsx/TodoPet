import { describe, expect, it } from 'vitest'
import { completedInRange, consecutiveCompletedDays, healthCheckins, noteCounts, overdueOpenCount, priorityMix, rangeStart, statsLine, weekdayCounts } from './analytics.js'
import type { Note, ReminderOccurrence, Task } from './types.js'

const now = new Date(2026, 8, 6, 12, 0, 0)

function task(partial: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    notes: '', status: 'completed', priority: 'none', dueAt: null, remindAt: null, revision: 1,
    createdAt: '2026-09-01T01:00:00.000Z', updatedAt: '2026-09-01T01:00:00.000Z', completedAt: null,
    ...partial
  }
}

describe('analytics range', () => {
  it('starts the week on Monday of the local calendar', () => {
    const start = rangeStart('week', now)
    expect(start.getDay()).toBe(1)
    expect(start.getHours()).toBe(0)
  })
  it('starts the month on the 1st local day', () => {
    expect(rangeStart('month', now).getDate()).toBe(1)
    expect(rangeStart('month', now).getMonth()).toBe(8)
  })
})

describe('task stats', () => {
  it('counts consecutive days that have a completion', () => {
    const tasks = [
      task({ id: 'a', title: '今', completedAt: new Date(2026, 8, 6, 10).toISOString() }),
      task({ id: 'b', title: '昨', completedAt: new Date(2026, 8, 5, 10).toISOString() }),
      task({ id: 'c', title: '前', completedAt: new Date(2026, 8, 4, 10).toISOString() })
    ]
    expect(consecutiveCompletedDays(tasks, now)).toBe(3)
  })
  it('starts consecutive days from yesterday when today is empty', () => {
    const tasks = [task({ id: 'b', title: '昨', completedAt: new Date(2026, 8, 5, 10).toISOString() })]
    expect(consecutiveCompletedDays(tasks, now)).toBe(1)
  })
  it('counts overdue open tasks before today', () => {
    const tasks = [
      task({ id: 'o', title: '过期', status: 'open', dueAt: new Date(2026, 8, 4, 9).toISOString(), completedAt: null }),
      task({ id: 't', title: '今天到期', status: 'open', dueAt: new Date(2026, 8, 6, 18).toISOString(), completedAt: null })
    ]
    expect(overdueOpenCount(tasks, now)).toBe(1)
  })
  it('mixes priorities of completed work in range', () => {
    const start = rangeStart('week', now)
    const tasks = [
      task({ id: 'h', title: '急', priority: 'high', completedAt: new Date(2026, 8, 1, 10).toISOString() }),
      task({ id: 'n', title: '普', completedAt: new Date(2026, 8, 2, 10).toISOString() }),
      task({ id: 'old', title: '更早', completedAt: new Date(2026, 7, 1, 10).toISOString() })
    ]
    const mix = priorityMix(completedInRange(tasks, start, now))
    expect(mix.find((item) => item.priority === 'high')?.count).toBe(1)
    expect(mix.find((item) => item.priority === 'none')?.count).toBe(1)
  })
  it('bins completions by weekday', () => {
    const tasks = [task({ id: 's', title: '周日', completedAt: new Date(2026, 8, 6, 10).toISOString() })]
    const sunday = weekdayCounts(tasks).find((item) => item.label === '日')
    expect(sunday?.count).toBe(1)
  })
})

describe('health checkins', () => {
  it('computes drink rate from acknowledged vs missed', () => {
    const start = rangeStart('weeks12', now)
    const rows: ReminderOccurrence[] = [
      { id: '1', sourceType: 'health', sourceId: 'water', scheduledAt: '2026-09-01T01:00:00.000Z', status: 'acknowledged', firedAt: null, acknowledgedAt: '2026-09-01T01:01:00.000Z', snoozedFromId: null, title: '喝水时间到了' },
      { id: '2', sourceType: 'health', sourceId: 'water', scheduledAt: '2026-09-02T01:00:00.000Z', status: 'missed', firedAt: null, acknowledgedAt: null, snoozedFromId: null, title: '喝水时间到了' },
      { id: '3', sourceType: 'health', sourceId: 'stand', scheduledAt: '2026-09-02T02:00:00.000Z', status: 'acknowledged', firedAt: null, acknowledgedAt: '2026-09-02T02:01:00.000Z', snoozedFromId: null, title: '站立时间到了' }
    ]
    const checkins = healthCheckins(rows, start, now)
    expect(checkins.water.acknowledged).toBe(1)
    expect(checkins.water.missed).toBe(1)
    expect(checkins.water.rate).toBe(0.5)
    expect(checkins.stand.rate).toBe(1)
  })
})

describe('notes and copy', () => {
  it('counts sparks and wraps in range', () => {
    const start = rangeStart('month', now)
    const notes: Note[] = [
      { id: 's', kind: 'spark', title: '念头', body: '', createdAt: new Date(2026, 8, 3, 10).toISOString(), updatedAt: new Date(2026, 8, 3, 10).toISOString() },
      { id: 'w', kind: 'wrap', title: '收工', body: '', createdAt: new Date(2026, 8, 4, 10).toISOString(), updatedAt: new Date(2026, 8, 4, 10).toISOString() },
      { id: 'old', kind: 'spark', title: '旧', body: '', createdAt: new Date(2026, 6, 1, 10).toISOString(), updatedAt: new Date(2026, 6, 1, 10).toISOString() }
    ]
    expect(noteCounts(notes, start, now)).toEqual({ spark: 1, wrap: 1 })
  })
  it('stitches a local summary line', () => {
    expect(statsLine({ completed: 12, overdue: 1, waterRate: 0.8, standRate: 0, waterTotal: 5, standTotal: 0, sparks: 2, wraps: 1 })).toBe('这段时间完成 12 件，还有 1 件过期没动，喝水打卡 80%，记下 2 条灵感、1 条总结。')
  })
})
