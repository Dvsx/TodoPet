import { randomUUID } from 'node:crypto'
import { HealthRecordService } from './health-record-service.js'
import { getSqlite } from './database.js'
import type { HealthKind, HealthPreset, HealthSession, ReminderOccurrence, ReminderStatus, Task } from '../shared/types.js'

type PresetRow = { kind: HealthKind; enabled: number; interval_minutes: number; window_start: string; window_end: string; weekdays_json: string; next_trigger_at: string | null; last_acknowledged_at: string | null }
type ReminderRow = { id: string; source_type: 'task' | 'health'; source_id: string; scheduled_at: string; status: ReminderStatus; fired_at: string | null; acknowledged_at: string | null; snoozed_from_id: string | null; title: string }
const toPreset = (row: PresetRow): HealthPreset => ({ kind: row.kind, enabled: Boolean(row.enabled), intervalMinutes: row.interval_minutes, windowStart: row.window_start ?? '', windowEnd: row.window_end ?? '', weekdays: JSON.parse(row.weekdays_json), nextTriggerAt: row.next_trigger_at, lastAcknowledgedAt: row.last_acknowledged_at })
const toReminder = (row: ReminderRow): ReminderOccurrence => ({ id: row.id, sourceType: row.source_type, sourceId: row.source_id, scheduledAt: row.scheduled_at, status: row.status, firedAt: row.fired_at, acknowledgedAt: row.acknowledged_at, snoozedFromId: row.snoozed_from_id, title: row.title })
const HEARTBEAT_INTERVAL_MS = 30_000

function twelveWeeksAgo(from = new Date()): Date {
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 11 * 7)
  return start
}

export function inReminderWindow(preset: HealthPreset, at = new Date()): boolean {
  const time = at.getHours() * 60 + at.getMinutes()
  const minutes = (v: string) => { const [h,m] = v.split(':').map(Number); return h*60+m }
  const startBound = preset.windowStart ? minutes(preset.windowStart) : 0
  const endBound = preset.windowEnd ? minutes(preset.windowEnd) : 24 * 60
  return preset.enabled && preset.weekdays.includes(at.getDay() || 7) && time >= startBound && time < endBound
}
export function nextInSession(preset: HealthPreset, session: HealthSession, from = new Date()): Date | null {
  if (!preset.enabled || !session.active || !session.startedAt || (preset.kind==='stand' && session.state==='standing')) return null
  for(let offset=0; offset<8; offset++) {
    const start=new Date(from); start.setDate(start.getDate()+offset)
    const [h,m]=preset.windowStart ? preset.windowStart.split(':').map(Number) : [0,0]
    start.setHours(h,m,0,0)
    const base = offset===0 && from>start ? from : start
    const next=new Date(base.getTime()+preset.intervalMinutes*60000)
    if(inReminderWindow(preset,next) && (preset.windowEnd ? next.getDate()===start.getDate() : true))return next
  }
  return null
}

export class ReminderService {
  readonly records = new HealthRecordService()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private timer: NodeJS.Timeout | null = null
  private listeners = new Set<(reminder: ReminderOccurrence) => void>()
  private sessionListeners = new Set<(session: HealthSession) => void>()
  private deliveryPaused = false
  private healthScheduleFloor = 0

  onReminder(listener: (reminder: ReminderOccurrence) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  onSessionChange(listener: (session: HealthSession) => void): () => void { this.sessionListeners.add(listener); return () => this.sessionListeners.delete(listener) }

  init(): void {
    const db = getSqlite()
    const count = (db.prepare('SELECT COUNT(*) AS count FROM health_presets').get() as { count: number }).count
    if (!count) {
      db.prepare('INSERT INTO health_presets VALUES (?,?,?,?,?,?,?,?)').run('water', 1, 45, '', '', '[1,2,3,4,5]', null, null)
      db.prepare('INSERT INTO health_presets VALUES (?,?,?,?,?,?,?,?)').run('stand', 1, 60, '', '', '[1,2,3,4,5]', null, null)
    }
    this.records.init()
    if (!db.prepare('SELECT version FROM health_record_migrations WHERE version=2').get()) {
      db.prepare("UPDATE health_presets SET window_start='' WHERE window_start='09:00'").run()
      db.exec('INSERT INTO health_record_migrations VALUES (2)')
    }
    if (!db.prepare('SELECT version FROM health_record_migrations WHERE version=3').get()) {
      db.prepare("UPDATE health_presets SET window_end='' WHERE window_end='18:00'").run()
      db.exec('INSERT INTO health_record_migrations VALUES (3)')
    }
    this.cancelPendingHealth()
    this.missCatchUpHealth()
    if(this.heartbeatTimer)clearInterval(this.heartbeatTimer)
    this.heartbeatTimer=setInterval(()=>{this.records.heartbeat();this.fireDue();this.emitSession(this.getSession())},HEARTBEAT_INTERVAL_MS)
    this.ensureHealthOccurrences()
    this.reschedule()
  }

  listPresets(): HealthPreset[] { return (getSqlite().prepare('SELECT * FROM health_presets ORDER BY kind').all() as PresetRow[]).map(toPreset) }

  getSession(): HealthSession { return this.records.getSession() }
  /** Availability is independent of posture: a locked user can still be standing. */
  setDeliveryPaused(paused: boolean): void {
    if (this.deliveryPaused === paused) return
    this.deliveryPaused = paused
    this.cancelPendingHealth()
    this.missFiredHealth()
    this.clearNextTriggers()
    if (paused) {
      this.reschedule()
    } else {
      // Returning from an unavailable screen starts a fresh health interval.
      // Task occurrences remain pending and are delivered once on return.
      this.healthScheduleFloor = Date.now()
      this.fireDue()
    }
    this.emitSession(this.getSession())
  }
  startSession(at = new Date()): HealthSession { const session=this.records.start(at);this.refresh();return session }
  stopSession(): HealthSession { const session=this.records.stop();this.resetHealth();return session }
  pauseSession(): HealthSession { const session=this.records.pause();this.resetHealth();return session }
  action(action: 'water'|'stand'|'sit'|'resume-sitting'|'resume-standing', requestId: string) {
    const result=this.records.act(action,requestId)
    this.resetKind(action==='water'?'water':'stand')
    if(action.startsWith('resume-')) {
      this.resetKind('water')
      const preset=this.listPresets().find(p=>p.kind==='water')!
      const next=nextInSession(preset,result.session)
      if(next)this.createOccurrence('health','water',next.toISOString(),'喝水时间到了')
    }
    this.refresh();return result
  }
  refresh(): void { this.ensureHealthOccurrences();this.reschedule();this.emitSession(this.getSession()) }
  dispose(): void { if(this.timer)clearTimeout(this.timer);if(this.heartbeatTimer)clearInterval(this.heartbeatTimer) }
  resetHealth(): void { this.cancelPendingHealth();this.missFiredHealth();this.clearNextTriggers();this.refresh() }
  private resetKind(kind: HealthKind): void {
    getSqlite().prepare("UPDATE reminder_occurrences SET status='cancelled' WHERE source_type='health' AND source_id=? AND status IN ('pending','fired')").run(kind)
  }

  updatePreset(preset: HealthPreset): HealthPreset {
    getSqlite().prepare(`UPDATE health_presets SET enabled=?, interval_minutes=?, window_start=?, window_end=?, weekdays_json=?, next_trigger_at=?, last_acknowledged_at=? WHERE kind=?`).run(
      Number(preset.enabled), preset.intervalMinutes, preset.windowStart, preset.windowEnd, JSON.stringify(preset.weekdays), null, preset.lastAcknowledgedAt, preset.kind
    )
    getSqlite().prepare("UPDATE reminder_occurrences SET status='cancelled' WHERE source_type='health' AND source_id=? AND status='pending'").run(preset.kind)
    this.ensureHealthOccurrences(); this.reschedule()
    return this.listPresets().find((item) => item.kind === preset.kind)!
  }

  syncTaskReminder(task: Task): void {
    const db = getSqlite()
    db.prepare("UPDATE reminder_occurrences SET status='cancelled' WHERE source_type='task' AND source_id=? AND status='pending'").run(task.id)
    if (task.status === 'open' && task.remindAt && new Date(task.remindAt) > new Date()) {
      this.createOccurrence('task', task.id, task.remindAt, task.title)
    }
    this.reschedule()
  }

  acknowledge(id: string): ReminderOccurrence {
    const db=getSqlite(), occurrence=this.get(id);if(!occurrence)throw new Error('提醒不存在')
    if(occurrence.status!=='fired')return occurrence
    if(occurrence.sourceType==='health') {
      this.records.act(occurrence.sourceId==='water'?'water':'stand',id,id)
      db.prepare('UPDATE health_presets SET last_acknowledged_at=? WHERE kind=?').run(new Date().toISOString(),occurrence.sourceId)
      this.resetKind(occurrence.sourceId as HealthKind)
    }
    db.prepare("UPDATE reminder_occurrences SET status='acknowledged', acknowledged_at=? WHERE id=?").run(new Date().toISOString(),id)
    this.refresh();return this.get(id)!
  }

  snooze(id: string, minutes = 10): void {
    const db = getSqlite(); const occurrence = this.get(id); if (!occurrence) throw new Error('提醒不存在')
    if(occurrence.status!=='fired')return
    if(occurrence.sourceType==='health')this.resetKind(occurrence.sourceId as HealthKind)
    db.prepare("UPDATE reminder_occurrences SET status='snoozed' WHERE id=?").run(id)
    this.createOccurrence(occurrence.sourceType, occurrence.sourceId, new Date(Date.now() + minutes * 60_000).toISOString(), occurrence.title, id)
    this.reschedule()
  }

  miss(id: string): ReminderOccurrence {
    const db = getSqlite(); const occurrence = this.get(id); if (!occurrence) throw new Error('提醒不存在')
    if(occurrence.status!=='fired')return occurrence
    db.prepare("UPDATE reminder_occurrences SET status='missed' WHERE id=?").run(id)
    if (occurrence.sourceType === 'health') this.ensureHealthOccurrences()
    this.reschedule()
    return occurrence
  }

  listHealthHistory(since?: Date): ReminderOccurrence[] {
    const start = since ?? twelveWeeksAgo()
    return (getSqlite().prepare("SELECT * FROM reminder_occurrences WHERE source_type='health' AND status IN ('acknowledged','missed') AND scheduled_at >= ? ORDER BY scheduled_at DESC").all(start.toISOString()) as ReminderRow[]).map(toReminder)
  }

  recover(): void {
    this.missOverduePendingHealth()
    this.fireDue()
    this.ensureHealthOccurrences()
    this.reschedule()
  }

  /** Last session leftovers: fired or overdue pending never got a tap. */
  private missCatchUpHealth(): void {
    const db = getSqlite()
    const now = new Date().toISOString()
    db.prepare(`UPDATE reminder_occurrences SET status='missed'
      WHERE source_type='health' AND (status='fired' OR (status='pending' AND scheduled_at <= ?))`).run(now)
  }

  /** Keep an on-screen fired reminder until the user taps 喝了 / 跳过. */
  private missOverduePendingHealth(): void {
    const now = new Date().toISOString()
    const result = getSqlite().prepare(`UPDATE reminder_occurrences SET status='missed'
      WHERE source_type='health' AND status='pending' AND scheduled_at <= ?`).run(now)
    if (result.changes > 0) this.healthScheduleFloor = Date.now()
  }

  private cancelPendingHealth(): void {
    getSqlite().prepare("UPDATE reminder_occurrences SET status='cancelled' WHERE source_type='health' AND status='pending'").run()
  }

  private missFiredHealth(): void {
    getSqlite().prepare("UPDATE reminder_occurrences SET status='missed' WHERE source_type='health' AND status='fired'").run()
  }

  private clearNextTriggers(): void {
    getSqlite().prepare('UPDATE health_presets SET next_trigger_at=NULL').run()
  }

  private emitSession(session: HealthSession): void {
    for (const listener of this.sessionListeners) listener(session)
  }

  private ensureHealthOccurrences(): void {
    if (this.deliveryPaused) return
    const db = getSqlite()
    const session = this.getSession()
    for (const preset of this.listPresets()) {
      if (!session.active || !preset.enabled || (preset.kind==='stand' && session.state==='standing')) {
        if (!session.active || !preset.enabled || session.state==='standing') {
          db.prepare("UPDATE reminder_occurrences SET status='cancelled' WHERE source_type='health' AND source_id=? AND status='pending'").run(preset.kind)
        }
        db.prepare('UPDATE health_presets SET next_trigger_at=NULL WHERE kind=?').run(preset.kind)
        continue
      }
      // A fired bubble must not block the next interval. Otherwise a later
      // drink reminder can overwrite the stand bubble and freeze stand all day.
      const pending = db.prepare("SELECT scheduled_at FROM reminder_occurrences WHERE source_type='health' AND source_id=? AND status='pending' LIMIT 1").get(preset.kind) as { scheduled_at: string } | undefined
      if (pending) {
        db.prepare('UPDATE health_presets SET next_trigger_at=? WHERE kind=?').run(pending.scheduled_at, preset.kind)
        continue
      }
      const anchor = preset.kind==='stand' ? session.segmentStartedAt ?? session.startedAt! : session.startedAt!
      const latestEvent = preset.kind==='water' ? db.prepare("SELECT MAX(occurred_at) AS at FROM health_events WHERE session_id=? AND kind='water' AND deleted_at IS NULL").get(session.id!) as {at:string|null} : null
      const lastReminder = db.prepare("SELECT MAX(scheduled_at) AS at FROM reminder_occurrences WHERE source_type='health' AND source_id=? AND scheduled_at>=? AND status IN ('fired','acknowledged','missed','snoozed')").get(preset.kind,anchor) as {at:string|null}
      const baseline = new Date(Math.max(this.healthScheduleFloor,Date.parse(anchor),latestEvent?.at?Date.parse(latestEvent.at):0,lastReminder?.at?Date.parse(lastReminder.at):0))
      const current = new Date()
      const candidate = nextInSession(preset,session,baseline)
      const next = candidate && candidate<=current
        ? (inReminderWindow(preset,current) && inReminderWindow(preset,baseline) && baseline.toDateString()===current.toDateString() ? current : nextInSession(preset,session,current))
        : candidate
      if (!next) {
        db.prepare('UPDATE health_presets SET next_trigger_at=NULL WHERE kind=?').run(preset.kind)
        continue
      }
      const title = preset.kind === 'water' ? '喝水时间到了' : '站立时间到了'
      this.createOccurrence('health', preset.kind, next.toISOString(), title)
      db.prepare('UPDATE health_presets SET next_trigger_at=? WHERE kind=?').run(next.toISOString(), preset.kind)
    }
  }

  private createOccurrence(sourceType: 'task' | 'health', sourceId: string, scheduledAt: string, title: string, snoozedFromId: string | null = null): void {
    if (sourceType === 'health' && this.deliveryPaused) return
    getSqlite().prepare('INSERT INTO reminder_occurrences VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), sourceType, sourceId, scheduledAt, 'pending', null, null, snoozedFromId, title)
  }

  private get(id: string): ReminderOccurrence | null {
    const row = getSqlite().prepare('SELECT * FROM reminder_occurrences WHERE id=?').get(id) as ReminderRow | undefined
    return row ? toReminder(row) : null
  }

  private reschedule(): void {
    if(this.timer)clearTimeout(this.timer)
    this.timer = null
    if (this.deliveryPaused) return
    const row=getSqlite().prepare("SELECT scheduled_at FROM reminder_occurrences WHERE status='pending' ORDER BY scheduled_at LIMIT 1").get() as {scheduled_at:string}|undefined
    if(row)this.timer=setTimeout(()=>this.fireDue(),Math.max(0,Math.min(Date.parse(row.scheduled_at)-Date.now(),2147000000)))
  }

  private fireDue(): void {
    if (this.deliveryPaused) return
    const db = getSqlite(); const now = new Date().toISOString()
    const due = db.prepare("SELECT * FROM reminder_occurrences WHERE status='pending' AND scheduled_at <= ? ORDER BY scheduled_at").all(now) as ReminderRow[]
    const session = this.getSession()
    for (const row of due) {
      if (this.deliveryPaused) break
      // A timer can arrive hours late after sleep or an event-loop stall, before
      // the power event is processed. Health prompts are useful only on time.
      if (row.source_type === 'health' && Date.now() - Date.parse(row.scheduled_at) > HEARTBEAT_INTERVAL_MS) {
        db.prepare("UPDATE reminder_occurrences SET status='missed' WHERE id=? AND status='pending'").run(row.id)
        this.healthScheduleFloor = Date.now()
        continue
      }
      if (row.source_type === 'health' && (!session.active || !this.listPresets().some(p=>p.kind===row.source_id && inReminderWindow(p)) || (row.source_id==='stand' && session.state==='standing'))) {
        db.prepare("UPDATE reminder_occurrences SET status='cancelled' WHERE id=? AND status='pending'").run(row.id)
        continue
      }
      if (row.source_type === 'health') {
        db.prepare("UPDATE reminder_occurrences SET status='missed' WHERE source_type='health' AND source_id=? AND status='fired'").run(row.source_id)
      }
      db.prepare("UPDATE reminder_occurrences SET status='fired', fired_at=? WHERE id=? AND status='pending'").run(now, row.id)
      const reminder = this.get(row.id)!; for (const listener of this.listeners) listener(reminder)
    }
    this.ensureHealthOccurrences(); this.reschedule()
  }
}
