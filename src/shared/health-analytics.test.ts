import {describe,it,expect} from 'vitest'
import {periodRange,shiftPeriod,dayKey,dailyStats,periodComparison,summarize} from './health-analytics'
import type {HealthRecords,HealthSegment} from './types'
const segment=(start:string,end:string,posture:'sitting'|'standing'='sitting'):HealthSegment=>({id:start,sessionId:'s',posture,start:new Date(start).toISOString(),end:new Date(end).toISOString()})
describe('health period statistics',()=>{
  it('uses local Monday weeks and calendar month/year boundaries',()=>{
    expect(periodRange('week',new Date('2027-01-03T12:00:00')).map(dayKey)).toEqual(['2026-12-28','2027-01-04'])
    expect(periodRange('month',new Date('2028-02-29T12:00:00')).map(dayKey)).toEqual(['2028-02-01','2028-03-01'])
    expect(dayKey(shiftPeriod('month',new Date('2026-03-31T12:00:00'),-1))).toBe('2026-02-01')
  })
  it('distinguishes absent days, standing-only days, and legacy events without duration',()=>{
    const records:HealthRecords={segments:[segment('2026-09-14T09:00:00','2026-09-14T10:00:00','standing')],events:[{id:'e',sessionId:null,at:new Date('2026-09-15T12:00:00').toISOString(),kind:'water',source:'legacy',deletedAt:null}]}
    const days=dailyStats(records,new Date('2026-09-14'),new Date('2026-09-17'),new Date('2026-09-18'))
    expect(days[0]).toMatchObject({sittingMs:0,recordedMs:3600000,water:0,hasRecord:true});expect(days[1]).toMatchObject({water:1,recordedMs:0,hasRecord:true});expect(days[2].hasRecord).toBe(false)
    expect(days.filter(d=>d.recordedMs>0)).toHaveLength(1)
  })
  it('compares matching elapsed dates/time, excludes later prior-period activity and hides missing coverage',()=>{
    const now=new Date('2026-09-16T12:00:00'),records:HealthRecords={segments:[],events:[]}
    for(const day of ['07','08','09','14','15','16'])records.segments.push(segment(`2026-09-${day}T09:00:00`,`2026-09-${day}T10:00:00`))
    records.segments.push(segment('2026-09-09T13:00:00','2026-09-09T15:00:00'))
    let comparison=periodComparison(records,'week',now,now);expect(comparison.count).toBe(3);expect(comparison.sufficient).toBe(true);expect(comparison.before.sittingMs).toBe(3*3600000);expect(comparison.after.sittingMs).toBe(3*3600000)
    records.segments.shift();comparison=periodComparison(records,'week',now,now);expect(comparison.sufficient).toBe(false)
  })
  it('does not divide full months by different day counts in comparisons',()=>{
    const now=new Date('2026-04-01T12:00:00'),records:HealthRecords={segments:[],events:[]}
    for(let d=1;d<=31;d++)records.segments.push(segment(`2026-03-${String(d).padStart(2,'0')}T09:00:00`,`2026-03-${String(d).padStart(2,'0')}T10:00:00`))
    for(let d=1;d<=28;d++)records.segments.push(segment(`2026-02-${String(d).padStart(2,'0')}T09:00:00`,`2026-02-${String(d).padStart(2,'0')}T10:00:00`))
    const c=periodComparison(records,'month',new Date('2026-03-15'),now);expect(c.count).toBe(28);expect(c.before.sittingMs).toBe(c.after.sittingMs)
  })
  it('clips active intervals to now and retains continuous length across midnight for whole-period longest',()=>{
    const records:HealthRecords={segments:[{...segment('2026-09-14T23:30:00','2026-09-15T00:45:00'),end:null}],events:[]}
    const a=new Date('2026-09-14T00:00:00'),b=new Date('2026-09-16T00:00:00'),now=new Date('2026-09-15T00:45:00')
    expect(summarize(records,a,b,now).longestMs).toBe(75*60000);expect(dailyStats(records,a,b,now).map(d=>d.sittingMs)).toEqual([30*60000,45*60000])
  })
})
