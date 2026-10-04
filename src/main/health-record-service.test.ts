import {mkdtempSync,rmSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
const state=vi.hoisted(()=>({root:''}))
vi.mock('electron',()=>({app:{getPath:()=>state.root}}))
import {getSqlite,closeDatabase} from './database'
import {HealthRecordService} from './health-record-service'
import {ReminderService,nextInSession} from './reminder-service'
import {summarize,dailyStats,localDay,addDays} from '../shared/health-analytics'
let service:HealthRecordService,reminder:ReminderService|undefined
const start=new Date('2026-09-14T01:00:00Z')
const time=(minutes:number)=>new Date(start.getTime()+minutes*60000)
const records=()=>service.records(time(-10080).toISOString(),time(10080).toISOString())
const advance=(minutes:number)=>vi.setSystemTime(time(minutes))
beforeEach(()=>{state.root=mkdtempSync(join(tmpdir(),'todopet-health-'));vi.useFakeTimers();vi.setSystemTime(start);service=new HealthRecordService();service.init()})
afterEach(()=>{reminder?.dispose();reminder=undefined;vi.clearAllTimers();vi.useRealTimers();closeDatabase();rmSync(state.root,{recursive:true,force:true})})
describe('durable health records',()=>{
  it('accumulates multiple sessions and only sitting time; drink does not split sitting',()=>{
    service.start();advance(20);service.act('water',randomUUID());advance(45);service.act('stand',randomUUID());service.act('stand',randomUUID());advance(55);service.act('sit',randomUUID());advance(75);service.stop();advance(120);service.start();advance(150);service.stop()
    const r=records(),total=summarize(r,time(0),time(200),time(200))
    expect(total.sittingMs).toBe(95*60000);expect(total.recordedMs).toBe(105*60000);expect(total.longestMs).toBe(45*60000);expect(total.water).toBe(1);expect(total.stand).toBe(1)
    expect(r.segments).toHaveLength(4)
  })
  it('is idempotent for starts, repeated commands and reminder acknowledgements',()=>{
    const first=service.start();expect(service.start().id).toBe(first.id)
    const key=randomUUID(),occ=randomUUID();service.act('water',key,occ);service.act('water',key,occ);service.act('water',randomUUID(),occ)
    expect(records().events).toHaveLength(1)
  })
  it('pauses lock/suspend idempotently and resumes standing without a stand event',()=>{
    service.start();advance(30);service.pause();advance(60);service.pause();expect(service.getSession().state).toBe('paused');expect(()=>service.act('water',randomUUID())).toThrow()
    service.act('resume-standing',randomUUID());advance(75);service.act('sit',randomUUID());advance(90);service.stop()
    expect(summarize(records(),time(0),time(100),time(100)).sittingMs).toBe(45*60000);expect(records().events).toHaveLength(0)
  })
  it('recovers only through last persisted heartbeat and never counts offline time',()=>{
    service.start();advance(10);service.heartbeat();advance(600);closeDatabase();service=new HealthRecordService();service.init()
    expect(service.getSession().state).toBe('paused');expect(records().segments[0].end).toBe(time(10).toISOString());service.act('resume-sitting',randomUUID());advance(610);service.stop()
    expect(summarize(records(),time(0),time(620),time(620)).sittingMs).toBe(20*60000)
  })
  it('normal quit ends a session rather than leaving it recoverable',()=>{service.start();advance(5);service.stop();closeDatabase();service.init();expect(service.getSession().state).toBe('idle');expect(records().segments[0].end).toBe(time(5).toISOString())})
  it('splits midnight duration and assigns events to their actual date',()=>{
    const a=new Date('2026-09-14T15:30:00Z');vi.setSystemTime(a);service.start();vi.setSystemTime(new Date('2026-09-14T16:15:00Z'));service.act('water',randomUUID());service.act('stand',randomUUID());service.stop()
    const [first,second]=dailyStats(records(),localDay(a),addDays(localDay(a),2),new Date('2026-09-15T02:00:00Z'))
    expect(first.sittingMs).toBe(30*60000);expect(second.sittingMs).toBe(15*60000);expect(first.water).toBe(0);expect(second.water).toBe(1);expect(second.stand).toBe(1)
  })
  it('undoes standing without losing the continuous sitting span and retains audit values',()=>{
    service.start();advance(20);const action=service.act('stand',randomUUID());vi.setSystemTime(new Date(time(20).getTime()+2000));service.undo(action.eventId!);advance(40);service.stop()
    expect(records().events).toHaveLength(0);expect(records().segments).toHaveLength(1);expect(records().segments[0].end).toBe(time(40).toISOString());expect(getSqlite().prepare('SELECT * FROM health_record_audit').all()).toHaveLength(2)
  })
  it('rejects expired undo, allows soft deletion and validates correction boundaries',()=>{
    service.start();advance(10);const water=service.act('water',randomUUID());advance(11);expect(()=>service.undo(water.eventId!)).toThrow();service.deleteEvent(water.eventId!);advance(20);service.act('stand',randomUUID());advance(30);service.stop()
    const sitting=records().segments[0];service.editSegment(sitting.id,time(1).toISOString(),time(19).toISOString());expect(summarize(records(),time(0),time(40),time(40)).sittingMs).toBe(18*60000)
    expect(()=>service.editSegment(sitting.id,time(1).toISOString(),time(21).toISOString())).toThrow('重叠');expect(()=>service.editSegment(sitting.id,time(1).toISOString(),time(40).toISOString())).toThrow();expect(records().events.filter(e=>e.kind==='water')).toHaveLength(0)
    const audit=getSqlite().prepare("SELECT before_json FROM health_record_audit WHERE action='edit-segment'").get() as {before_json:string};expect(JSON.parse(audit.before_json).started_at).toBe(time(0).toISOString())
  })
  it('does not allow editing an active segment',()=>{service.start();advance(10);expect(()=>service.editSegment(records().segments[0].id,time(1).toISOString(),time(5).toISOString())).toThrow('已经结束')})
  it('imports only confirmed legacy timestamps once and preserves all unrelated content',()=>{
    const db=getSqlite();db.exec('DELETE FROM health_record_migrations')
    db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?)').run(randomUUID(),'spark','解压灵感','用户灵感',time(0).toISOString(),time(0).toISOString());db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?)').run(randomUUID(),'wrap','解压总结','用户总结',time(0).toISOString(),time(0).toISOString())
    for(const at of [time(0).toISOString(),null,'invalid'])db.prepare('INSERT INTO reminder_occurrences VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),'health','water',time(-1440).toISOString(),'acknowledged',null,at,null,'历史喝水')
    const before=db.prepare('SELECT * FROM notes').all(),history=db.prepare('SELECT * FROM reminder_occurrences').all();service.init();service.init()
    expect(records().events).toHaveLength(1);expect(records().events[0].source).toBe('legacy');expect(records().events[0].at).toBe(time(0).toISOString());expect(records().segments).toHaveLength(0);expect(db.prepare('SELECT * FROM notes').all()).toEqual(before);expect(db.prepare('SELECT * FROM reminder_occurrences').all()).toEqual(history)
  })
  it('makes a consistent backup before adding schema to an existing database',()=>{
    closeDatabase();const raw=new DatabaseSync(join(state.root,'todopet.db'));raw.exec('DROP TABLE health_events;DROP TABLE health_segments;DROP TABLE health_record_sessions');raw.close();getSqlite();const files=readdirSync(join(state.root,'backups'));expect(files).toHaveLength(1);const backup=new DatabaseSync(join(state.root,'backups',files[0]),{readOnly:true});expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get()).toBeTruthy();expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='health_record_sessions'").get()).toBeUndefined();backup.close()
  })
})
describe('recording and notification integration',()=>{
  it('records outside weekdays/windows and only schedules in the next allowed window',()=>{
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));reminder=new ReminderService();reminder.init();reminder.startSession();expect(reminder.getSession().active).toBe(true)
    const water=reminder.listPresets().find(p=>p.kind==='water')!;expect(nextInSession(water,reminder.getSession())?.toISOString()).toBe('2026-09-20T16:45:00.000Z');reminder.action('water',randomUUID());expect(service.records('2026-09-19T00:00:00Z','2026-09-20T00:00:00Z').events).toHaveLength(1)
  })
  it('resets stand interval on sitting and water interval on confirmation',()=>{
    reminder=new ReminderService();reminder.init();reminder.startSession();vi.advanceTimersByTime(20*60000);reminder.action('stand',randomUUID());expect(reminder.listPresets().find(p=>p.kind==='stand')!.nextTriggerAt).toBeNull();vi.advanceTimersByTime(10*60000);reminder.action('sit',randomUUID());expect(reminder.listPresets().find(p=>p.kind==='stand')!.nextTriggerAt).toBe(time(90).toISOString());reminder.action('water',randomUUID());expect(reminder.listPresets().find(p=>p.kind==='water')!.nextTriggerAt).toBe(time(75).toISOString())
  })
  it('commits a reminder action exactly once and skips/snoozes without behavior counts',()=>{
    reminder=new ReminderService();reminder.init();reminder.startSession();const raised:string[]=[];reminder.onReminder(r=>raised.push(r.id));vi.advanceTimersByTime(45*60000);expect(raised).toHaveLength(1);reminder.acknowledge(raised[0]);reminder.acknowledge(raised[0]);expect(records().events).toHaveLength(1);vi.advanceTimersByTime(15*60000);reminder.snooze(raised[1]);reminder.snooze(raised[1]);expect(records().events).toHaveLength(1);vi.advanceTimersByTime(10*60000);reminder.miss(raised.at(-1)!);expect(records().events).toHaveLength(1)
  })
  it('saves heartbeat every 30 seconds; suspend pauses reminders and recovery waits for choice',()=>{
    reminder=new ReminderService();reminder.init();reminder.startSession();vi.advanceTimersByTime(31000);const row=getSqlite().prepare('SELECT heartbeat_at FROM health_record_sessions').get() as {heartbeat_at:string};expect(row.heartbeat_at).toBe(new Date(start.getTime()+30000).toISOString());reminder.pauseSession();vi.advanceTimersByTime(3600000);reminder.recover();expect(reminder.getSession().state).toBe('paused');expect(reminder.listPresets().every(p=>p.nextTriggerAt===null)).toBe(true);reminder.action('resume-standing',randomUUID());expect(records().events).toHaveLength(0)
  })
})

describe('automatic return recording',()=>{
  it('excludes absence and resumes exactly once, corrections cover the complete new span',()=>{
    service.start();advance(20);service.pause();advance(100)
    const id=service.autoResume()!;expect(id).toBeTruthy();expect(service.autoResume()).toBeNull()
    advance(105);service.correctAutoResume(id,'standing')
    expect(records().segments.at(-1)?.posture).toBe('standing')
    expect(records().segments.at(-1)?.start).toBe(time(100).toISOString())
    expect(summarize(records(),time(0),time(110),time(105)).sittingMs).toBe(20*60000)
    expect(records().events).toHaveLength(0)
  })
  it('persists manual pause through power events and restart until manually resumed',()=>{
    service.start();advance(10);service.pause();advance(30)
    const id=service.autoResume()!;service.correctAutoResume(id,'pause')
    expect(records().segments).toHaveLength(1)
    service.pause();closeDatabase();service.init();expect(service.autoResume()).toBeNull()
    service.act('resume-sitting',randomUUID());service.pause();expect(service.autoResume()).toBeTruthy()
  })
  it('respects disabled setting, stopped sessions, and rejects stale corrections',()=>{
    service.start();service.pause();service.setAutoResume(false);closeDatabase();service.init()
    expect(service.autoResumeEnabled()).toBe(false);expect(service.autoResume()).toBeNull()
    service.setAutoResume(true);const id=service.autoResume()!;advance(1);service.act('stand',randomUUID())
    expect(()=>service.correctAutoResume(id,'pause')).toThrow('已改变')
    service.stop();expect(service.autoResume()).toBeNull()
  })
})

describe('lock posture transitions',()=>{
  it('counts one stand on lock and starts a new sitting span on unlock',()=>{
    service.start();advance(20);service.lockScreen();service.lockScreen()
    expect(service.getSession().state).toBe('standing');expect(records().events.filter(e=>e.kind==='stand')).toHaveLength(1)
    advance(80);const id=service.unlockScreen();expect(id).toBeTruthy();expect(service.unlockScreen()).toBeNull()
    advance(90);expect(summarize(records(),time(0),time(100),time(90)).sittingMs).toBe(30*60000)
    expect(records().segments.map(s=>s.posture)).toEqual(['sitting','standing','sitting'])
  })
  it('does not double count a manual stand or override a deliberate stop or pause',()=>{
    service.start();service.act('stand',randomUUID());service.lockScreen();expect(records().events).toHaveLength(1)
    const id=service.unlockScreen()!;service.correctAutoResume(id,'pause');service.lockScreen();expect(service.unlockScreen()).toBeNull()
    service.stop();service.lockScreen();expect(service.unlockScreen()).toBeNull()
  })
  it('does not count sleeping time and resumes sitting after a locked sleep',()=>{
    service.start();advance(10);service.lockScreen();advance(15);service.pause();advance(100);service.unlockScreen()
    expect(records().events).toHaveLength(1);expect(records().segments[1].end).toBe(time(15).toISOString());expect(service.getSession().state).toBe('sitting')
  })
})
