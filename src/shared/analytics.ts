import type { HealthKind, Note, ReminderOccurrence, Task, TaskPriority } from './types.js'

export type StatsRange = 'week' | 'month' | 'weeks12'

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const
export const PRIORITY_ORDER: TaskPriority[] = ['high', 'medium', 'low', 'none']
export const PRIORITY_LABEL: Record<TaskPriority, string> = { high: '高', medium: '中', low: '低', none: '普通' }

function dayKeyOf(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function startOfDay(date: Date): Date {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  return start
}

export function rangeStart(range: StatsRange, now = new Date()): Date {
  const start = startOfDay(now)
  if (range === 'week') {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
    return start
  }
  if (range === 'month') {
    start.setDate(1)
    return start
  }
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 11 * 7)
  return start
}

export function inRange(iso: string, start: Date, now = new Date()): boolean {
  const time = new Date(iso).getTime()
  return time >= start.getTime() && time <= now.getTime()
}

export function consecutiveCompletedDays(tasks: Task[], now = new Date()): number {
  const keys = new Set(tasks.filter((task) => task.completedAt).map((task) => dayKeyOf(task.completedAt!)))
  const cursor = startOfDay(now)
  const keyOf = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
  if (!keys.has(keyOf(cursor))) cursor.setDate(cursor.getDate() - 1)
  let count = 0
  while (keys.has(keyOf(cursor))) {
    count += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return count
}

export function completedInRange(tasks: Task[], start: Date, now = new Date()): Task[] {
  return tasks.filter((task) => task.completedAt && inRange(task.completedAt, start, now))
}

export function overdueOpenCount(tasks: Task[], now = new Date()): number {
  const cutoff = startOfDay(now).getTime()
  return tasks.filter((task) => task.status === 'open' && task.dueAt && new Date(task.dueAt).getTime() < cutoff).length
}

export function priorityMix(tasks: Task[]): Array<{ priority: TaskPriority; label: string; count: number; ratio: number }> {
  const counts: Record<TaskPriority, number> = { high: 0, medium: 0, low: 0, none: 0 }
  for (const task of tasks) counts[task.priority] += 1
  const total = tasks.length || 1
  return PRIORITY_ORDER.map((priority) => ({
    priority,
    label: PRIORITY_LABEL[priority],
    count: counts[priority],
    ratio: counts[priority] / total
  }))
}

export function weekdayCounts(tasks: Task[]): Array<{ weekday: number; label: string; count: number }> {
  const counts = [0, 0, 0, 0, 0, 0, 0]
  for (const task of tasks) {
    if (!task.completedAt) continue
    const day = new Date(task.completedAt)
    const index = (day.getDay() + 6) % 7
    counts[index] += 1
  }
  return counts.map((count, index) => ({ weekday: index + 1, label: WEEKDAY_LABELS[index], count }))
}

function checkinOf(kind: HealthKind, occurrences: ReminderOccurrence[], start: Date, now = new Date()) {
  const rows = occurrences.filter((item) => item.sourceId === kind && inRange(item.scheduledAt, start, now))
  const acknowledged = rows.filter((item) => item.status === 'acknowledged').length
  const missed = rows.filter((item) => item.status === 'missed').length
  const total = acknowledged + missed
  return { acknowledged, missed, total, rate: total ? acknowledged / total : 0 }
}

export function healthCheckins(occurrences: ReminderOccurrence[], start: Date, now = new Date()) {
  return {
    water: checkinOf('water', occurrences, start, now),
    stand: checkinOf('stand', occurrences, start, now)
  }
}

export function noteCounts(notes: Note[], start: Date, now = new Date()) {
  const inWindow = notes.filter((note) => inRange(note.createdAt, start, now))
  return {
    spark: inWindow.filter((note) => note.kind === 'spark').length,
    wrap: inWindow.filter((note) => note.kind === 'wrap').length
  }
}

export function statsLine(input: {
  completed: number
  overdue: number
  waterRate: number
  standRate: number
  waterTotal: number
  standTotal: number
  sparks: number
  wraps: number
}): string {
  const bits = [`这段时间完成 ${input.completed} 件`]
  if (input.overdue) bits.push(`还有 ${input.overdue} 件过期没动`)
  if (input.waterTotal) bits.push(`喝水打卡 ${Math.round(input.waterRate * 100)}%`)
  if (input.standTotal) bits.push(`站立打卡 ${Math.round(input.standRate * 100)}%`)
  if (input.sparks || input.wraps) bits.push(`记下 ${input.sparks} 条灵感、${input.wraps} 条总结`)
  return `${bits.join('，')}。`
}
