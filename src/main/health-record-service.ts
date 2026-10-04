import { randomUUID } from 'node:crypto'
import { getSqlite } from './database.js'
import type { HealthMutation, HealthRecords, HealthSession, HealthSegment, HealthRecordEvent } from '../shared/types.js'

type SessionRow = { id: string; started_at: string; ended_at: string | null; state: 'sitting' | 'standing' | 'paused'; heartbeat_at: string }
type SegmentRow = { id: string; session_id: string; posture: 'sitting' | 'standing'; started_at: string; ended_at: string | null }
type EventRow = { id: string; session_id: string | null; kind: 'water' | 'stand'; occurred_at: string; source: 'manual' | 'reminder' | 'legacy'; deleted_at: string | null }
const segment = (r: SegmentRow): HealthSegment => ({ id:r.id, sessionId:r.session_id, posture:r.posture, start:r.started_at, end:r.ended_at })
const event = (r: EventRow): HealthRecordEvent => ({ id:r.id, sessionId:r.session_id, kind:r.kind, at:r.occurred_at, source:r.source, deletedAt:r.deleted_at })

export class HealthRecordService {
  private transaction<T>(fn: () => T): T {
    const db=getSqlite(); db.exec('BEGIN IMMEDIATE')
    try { const value=fn(); db.exec('COMMIT'); return value } catch(error) { db.exec('ROLLBACK'); throw error }
  }
  private current(): SessionRow | undefined { return getSqlite().prepare('SELECT * FROM health_record_sessions WHERE ended_at IS NULL').get() as SessionRow | undefined }
  private openSegment(): SegmentRow | undefined { return getSqlite().prepare('SELECT * FROM health_segments WHERE ended_at IS NULL').get() as SegmentRow | undefined }
  init(): void {
    getSqlite().exec(`CREATE TABLE IF NOT EXISTS health_record_control (id INTEGER PRIMARY KEY CHECK(id=1), auto_resume INTEGER NOT NULL DEFAULT 1, manual_pause INTEGER NOT NULL DEFAULT 0, auto_segment TEXT);
      INSERT OR IGNORE INTO health_record_control(id) VALUES(1);`)
    this.transaction(() => {
      const db=getSqlite()
      if (!db.prepare('SELECT version FROM health_record_migrations WHERE version=1').get()) {
        db.exec(`INSERT OR IGNORE INTO health_events (id,kind,occurred_at,source,occurrence_id)
          SELECT id,source_id,acknowledged_at,'legacy',id FROM reminder_occurrences
          WHERE source_type='health' AND source_id IN ('water','stand') AND status='acknowledged' AND acknowledged_at IS NOT NULL AND julianday(acknowledged_at) IS NOT NULL;
          INSERT INTO health_record_migrations VALUES (1);`)
      }
      const current=this.current()
      if (current && current.state !== 'paused') this.pauseAt(current.heartbeat_at)
    })
  }
  getSession(): HealthSession {
    const r=this.current(), seg=this.openSegment()
    return r ? { id:r.id, active:r.state!=='paused', state:r.state, startedAt:r.started_at, segmentStartedAt:seg?.started_at ?? null, autoResumeSegmentId:seg && seg.id===this.control().auto_segment?seg.id:null } : { active:false, state:'idle', startedAt:null, segmentStartedAt:null }
  }
  private control(): {auto_resume:number;manual_pause:number;auto_segment:string|null} {
    return getSqlite().prepare('SELECT * FROM health_record_control WHERE id=1').get() as {auto_resume:number;manual_pause:number;auto_segment:string|null}
  }
  autoResumeEnabled(): boolean { return Boolean(this.control().auto_resume) }
  setAutoResume(enabled:boolean): void { getSqlite().prepare('UPDATE health_record_control SET auto_resume=? WHERE id=1').run(Number(enabled)) }
  autoResume(at=new Date()): string|null {
    return this.transaction(()=>{
      const c=this.control(), current=this.current()
      if(!c.auto_resume || c.manual_pause || current?.state!=='paused')return null
      const iso=at.toISOString()
      getSqlite().prepare('UPDATE health_record_sessions SET state=?,heartbeat_at=? WHERE id=?').run('sitting',iso,current.id)
      this.newSegment(current.id,'sitting',iso)
      const id=this.openSegment()!.id
      getSqlite().prepare('UPDATE health_record_control SET auto_segment=? WHERE id=1').run(id)
      return id
    })
  }
  lockScreen(): void {
    const current=this.current()
    if(!current || this.control().manual_pause)return
    if(current.state==='sitting')this.act('stand',randomUUID())
  }
  unlockScreen(): string|null {
    if(this.current()?.state!=='standing')return this.autoResume()
    this.act('sit',randomUUID())
    const id=this.openSegment()!.id
    getSqlite().prepare('UPDATE health_record_control SET auto_segment=? WHERE id=1').run(id)
    return id
  }
  correctAutoResume(id:string,choice:'standing'|'pause'): void {
    this.transaction(()=>{
      const seg=this.openSegment()
      if(!seg || seg.id!==id || this.control().auto_segment!==id)throw new Error('这段记录已改变，请按当前姿势操作')
      this.audit(id,'correct-auto-resume',seg)
      if(choice==='standing') {
        getSqlite().prepare("UPDATE health_segments SET posture='standing' WHERE id=?").run(id)
        getSqlite().prepare("UPDATE health_record_sessions SET state='standing' WHERE id=?").run(seg.session_id)
      } else {
        getSqlite().prepare('DELETE FROM health_segments WHERE id=?').run(id)
        getSqlite().prepare("UPDATE health_record_sessions SET state='paused' WHERE id=?").run(seg.session_id)
        getSqlite().exec('UPDATE health_record_control SET manual_pause=1 WHERE id=1')
      }
      getSqlite().exec('UPDATE health_record_control SET auto_segment=NULL WHERE id=1')
    })
  }
  start(at=new Date()): HealthSession {
    return this.transaction(() => {
      if (this.current()) return this.getSession()
      getSqlite().exec('UPDATE health_record_control SET manual_pause=0,auto_segment=NULL WHERE id=1')
      const iso=at.toISOString(),id=randomUUID()
      getSqlite().prepare('INSERT INTO health_record_sessions VALUES (?,?,NULL,?,?)').run(id,iso,'sitting',iso)
      this.newSegment(id,'sitting',iso); return this.getSession()
    })
  }
  private newSegment(id:string,posture:'sitting'|'standing',at:string): void {
    getSqlite().prepare('INSERT INTO health_segments VALUES (?,?,?,?,NULL)').run(randomUUID(),id,posture,at)
  }
  private closeSegment(at:string): void {
    // Clock changes must never create negative intervals.
    getSqlite().prepare('UPDATE health_segments SET ended_at=MAX(started_at,?) WHERE ended_at IS NULL').run(at)
  }
  heartbeat(at=new Date()): void { getSqlite().prepare("UPDATE health_record_sessions SET heartbeat_at=MAX(heartbeat_at,?) WHERE ended_at IS NULL AND state!='paused'").run(at.toISOString()) }
  private pauseAt(at:string): void {
    this.closeSegment(at)
    getSqlite().prepare("UPDATE health_record_sessions SET state='paused',heartbeat_at=? WHERE ended_at IS NULL").run(at)
  }
  pause(at=new Date()): HealthSession { return this.transaction(() => { if(this.current()?.state!=='paused')this.pauseAt(at.toISOString()); return this.getSession() }) }
  stop(at=new Date()): HealthSession {
    return this.transaction(() => { const iso=at.toISOString();this.closeSegment(iso);getSqlite().prepare("UPDATE health_record_sessions SET ended_at=?,heartbeat_at=? WHERE ended_at IS NULL").run(iso,iso);return this.getSession() })
  }
  act(action:'water'|'stand'|'sit'|'resume-sitting'|'resume-standing',requestId:string,occurrenceId?:string,at=new Date()): HealthMutation {
    return this.transaction(() => {
      const db=getSqlite(), current=this.current(), iso=at.toISOString()
      const old=db.prepare('SELECT id FROM health_events WHERE request_id=? OR occurrence_id=?').get(requestId,occurrenceId??null) as {id:string}|undefined
      if(old)return { session:this.getSession(),eventId:old.id }
      if(!current)throw new Error('请先开始记录')
      if(action.startsWith('resume-')) {
        if(current.state!=='paused')return {session:this.getSession(),eventId:null}
        getSqlite().exec('UPDATE health_record_control SET manual_pause=0,auto_segment=NULL WHERE id=1')
        const posture=action==='resume-standing'?'standing':'sitting'
        db.prepare('UPDATE health_record_sessions SET state=?,heartbeat_at=? WHERE id=?').run(posture,iso,current.id)
        this.newSegment(current.id,posture,iso);return {session:this.getSession(),eventId:null}
      }
      if(current.state==='paused')throw new Error('请先继续记录')
      if(action==='stand'||action==='sit') {
        const posture=action==='stand'?'standing':'sitting'
        if(current.state===posture)return {session:this.getSession(),eventId:null}
        this.closeSegment(iso);this.newSegment(current.id,posture,iso)
        db.prepare('UPDATE health_record_sessions SET state=?,heartbeat_at=? WHERE id=?').run(posture,iso,current.id)
      }
      let eventId:string|null=null
      if(action==='water'||action==='stand') {
        eventId=randomUUID()
        db.prepare('INSERT INTO health_events VALUES (?,?,?,?,?,?,?,NULL)').run(eventId,current.id,action,iso,occurrenceId?'reminder':'manual',requestId,occurrenceId??null)
      }
      this.heartbeat(at)
      return {session:this.getSession(),eventId}
    })
  }
  records(start:string,end:string): HealthRecords {
    const db=getSqlite()
    return {segments:(db.prepare('SELECT * FROM health_segments WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at').all(end,start) as SegmentRow[]).map(segment), events:(db.prepare('SELECT * FROM health_events WHERE occurred_at >= ? AND occurred_at < ? AND deleted_at IS NULL ORDER BY occurred_at').all(start,end) as EventRow[]).map(event)}
  }
  private audit(id:string,action:string,before:unknown):void { getSqlite().prepare('INSERT INTO health_record_audit VALUES (?,?,?,?,?)').run(randomUUID(),id,action,JSON.stringify(before),new Date().toISOString()) }
  deleteEvent(id:string):void { this.transaction(()=>{const db=getSqlite(),r=db.prepare('SELECT * FROM health_events WHERE id=?').get(id) as EventRow|undefined;if(!r)throw new Error('记录不存在');if(r.deleted_at)return;this.audit(id,'delete-event',r);db.prepare('UPDATE health_events SET deleted_at=? WHERE id=?').run(new Date().toISOString(),id)}) }
  undo(id:string):void {
    this.transaction(()=>{
      const db=getSqlite(),r=db.prepare('SELECT * FROM health_events WHERE id=?').get(id) as EventRow|undefined
      if(!r||r.deleted_at)return
      if(Date.now()-Date.parse(r.occurred_at)>10000)throw new Error('撤销时间已过，可到日详情删除记录')
      if(r.kind==='stand') {
        const open=this.openSegment()
        if(!open||open.posture!=='standing'||open.started_at!==r.occurred_at)throw new Error('坐站状态已改变，请到日详情修正')
        const prev=db.prepare("SELECT * FROM health_segments WHERE session_id=? AND ended_at=? AND posture='sitting' ORDER BY started_at DESC LIMIT 1").get(r.session_id,r.occurred_at) as SegmentRow|undefined
        if(!prev)throw new Error('无法撤销这次站起')
        this.audit(open.id,'undo-stand-segments',{open,prev})
        db.prepare('DELETE FROM health_segments WHERE id=?').run(open.id)
        db.prepare('UPDATE health_segments SET ended_at=NULL WHERE id=?').run(prev.id)
        db.prepare("UPDATE health_record_sessions SET state='sitting' WHERE id=?").run(r.session_id)
      }
      this.audit(id,'undo-event',r);db.prepare('UPDATE health_events SET deleted_at=? WHERE id=?').run(new Date().toISOString(),id)
    })
  }
  editSegment(id:string,start:string,end:string):void {
    if(Number.isFinite(Date.parse(start)))start=new Date(start).toISOString()
    if(Number.isFinite(Date.parse(end)))end=new Date(end).toISOString()
    if(!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||start>=end||Date.parse(end)>Date.now())throw new Error('请选择有效的已发生时间')
    this.transaction(()=>{
      const db=getSqlite(),r=db.prepare('SELECT * FROM health_segments WHERE id=?').get(id) as SegmentRow|undefined
      if(!r?.ended_at)throw new Error('只能调整已经结束的时间段')
      const overlap=db.prepare('SELECT id FROM health_segments WHERE id!=? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?) LIMIT 1').get(id,end,start)
      if(overlap)throw new Error('与其他记录时间段重叠')
      this.audit(id,'edit-segment',r);db.prepare('UPDATE health_segments SET started_at=?,ended_at=? WHERE id=?').run(start,end,id)
    })
  }
}
