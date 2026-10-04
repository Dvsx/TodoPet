import type { HealthRecords } from './types'
export type HealthPeriod = 'day' | 'week' | 'month'
export const localDay = (date: Date) => new Date(date.getFullYear(),date.getMonth(),date.getDate())
export const addDays = (date: Date,n:number) => new Date(date.getFullYear(),date.getMonth(),date.getDate()+n)
export const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
export function periodRange(kind:HealthPeriod,date:Date):[Date,Date] {
  const start=localDay(date)
  if(kind==='week')start.setDate(start.getDate()-((start.getDay()+6)%7))
  if(kind==='month')start.setDate(1)
  return [start,kind==='month'?new Date(start.getFullYear(),start.getMonth()+1,1):addDays(start,kind==='week'?7:1)]
}
export function shiftPeriod(kind:HealthPeriod,date:Date,n:number):Date {
  const [start]=periodRange(kind,date)
  return kind==='month'?new Date(start.getFullYear(),start.getMonth()+n,1):addDays(start,n*(kind==='week'?7:1))
}
export function duration(ms:number):string {
  const minutes=Math.floor(Math.max(0,ms)/60000)
  return minutes>=60?`${Math.floor(minutes/60)} 小时 ${minutes%60} 分钟`:`${minutes} 分钟`
}
export function summarize(records:HealthRecords,start:Date,end:Date,now=new Date()) {
  const a=start.getTime(),b=Math.min(end.getTime(),now.getTime())
  let sittingMs=0,recordedMs=0,longestMs=0
  for(const s of records.segments) {
    const left=Math.max(a,Date.parse(s.start)),right=Math.min(b,s.end?Date.parse(s.end):now.getTime())
    const ms=Math.max(0,right-left);recordedMs+=ms
    if(s.posture==='sitting'){sittingMs+=ms;longestMs=Math.max(longestMs,ms)}
  }
  const events=records.events.filter(e=>!e.deletedAt && Date.parse(e.at)>=a && Date.parse(e.at)<end.getTime() && Date.parse(e.at)<=now.getTime())
  return {sittingMs,recordedMs,longestMs,water:events.filter(e=>e.kind==='water').length,stand:events.filter(e=>e.kind==='stand').length,hasRecord:recordedMs>0||events.length>0,legacy:events.filter(e=>e.source==='legacy').length}
}
export function dailyStats(records:HealthRecords,start:Date,end:Date,now=new Date()) {
  const days=[]
  for(let d=localDay(start);d<end;d=addDays(d,1))days.push({date:d,key:dayKey(d),...summarize(records,d,addDays(d,1),now)})
  return days
}
// Both periods need a duration record on every compared date. Missing data is never zero.
export function periodComparison(records:HealthRecords,kind:HealthPeriod,date:Date,now=new Date()) {
  const [start,end]=periodRange(kind,date),[previous,previousEnd]=periodRange(kind,shiftPeriod(kind,date,-1))
  const currentDays=dailyStats(records,start,end,now).filter(d=>d.date<=localDay(now))
  const count=Math.min(currentDays.length,dailyStats(records,previous,previousEnd,now).length)
  const before=dailyStats(records,previous,previousEnd,now).slice(0,count)
  const after=currentDays.slice(0,count)
  // Match today's elapsed clock time when comparing an unfinished period.
  if(now<end && count && after[count-1].key===dayKey(now)) {
    const cutoff=new Date(before[count-1].date);cutoff.setHours(now.getHours(),now.getMinutes(),now.getSeconds(),now.getMilliseconds())
    before[count-1]={...before[count-1],...summarize(records,before[count-1].date,cutoff,now)}
  }
  const sufficient=count>0 && [...before,...after].every(d=>d.recordedMs>0)
  const sum=(rows:typeof before,key:'sittingMs'|'water'|'stand')=>rows.reduce((n,d)=>n+d[key],0)
  return {count,sufficient,before:{sittingMs:sum(before,'sittingMs'),water:sum(before,'water'),stand:sum(before,'stand')},after:{sittingMs:sum(after,'sittingMs'),water:sum(after,'water'),stand:sum(after,'stand')}}
}
