<script setup lang="ts">
import {computed,ref,watch,onMounted,onBeforeUnmount} from 'vue'
import type {HealthRecords,HealthSegment} from '../shared/types'
import {type HealthPeriod,periodRange,shiftPeriod,localDay,addDays,dayKey,duration,summarize,dailyStats,periodComparison} from '../shared/health-analytics'
const mode=ref<HealthPeriod>('week'),date=ref(new Date()),metric=ref<'sittingMs'|'water'|'stand'>('sittingMs'),now=ref(new Date())
const records=ref<HealthRecords>({segments:[],events:[]}),error=ref(''),loading=ref(false),busy=ref(false)
const editing=ref<string|null>(null),editStart=ref(''),editEnd=ref('')
let unsubscribe:(()=>void)|undefined,timer:ReturnType<typeof setInterval>,generation=0
const bounds=computed(()=>periodRange(mode.value,date.value))
const days=computed(()=>dailyStats(records.value,...bounds.value,now.value))
const totals=computed(()=>summarize(records.value,...bounds.value,now.value))
const recordDays=computed(()=>days.value.filter(d=>d.recordedMs>0).length)
const comparison=computed(()=>periodComparison(records.value,mode.value,date.value,now.value))
const label=computed(()=>mode.value==='day'?dayKey(bounds.value[0]):mode.value==='month'?`${bounds.value[0].getFullYear()} 年 ${bounds.value[0].getMonth()+1} 月`:`${dayKey(bounds.value[0])} — ${dayKey(addDays(bounds.value[1],-1))}`)
const metricLabel=computed(()=>({sittingMs:'坐姿时长',water:'喝水',stand:'站起'})[metric.value])
const chartMax=computed(()=>Math.max(metric.value==='sittingMs'?3600000:1,...days.value.map(d=>d[metric.value])))
const comparisonCopy=computed(()=>{
  const c=comparison.value
  if(!c.sufficient)return '上期或本期记录覆盖不足，暂不显示增长率'
  const before=c.before[metric.value],after=c.after[metric.value]
  if(!before)return `同样 ${c.count} 天：上期为 0，本期 ${metric.value==='sittingMs'?duration(after):after+' 次'}`
  const change=(after-before)/before*100
  return `与上期相同已过 ${c.count} 天相比，${metricLabel.value}${change===0?'持平':`${change>0?'增加':'减少'} ${Math.abs(change).toFixed(1)}%`}`
})
async function load(){const seq=++generation;loading.value=true;try{const previous=periodRange(mode.value,shiftPeriod(mode.value,date.value,-1))[0];const value=await window.todoPet.health.records(previous.toISOString(),bounds.value[1].toISOString());if(seq===generation){records.value=value;error.value=''}}catch(e){if(seq===generation)error.value=String(e)}finally{if(seq===generation)loading.value=false}}
watch([mode,date],()=>{editing.value=null;void load()})
onMounted(()=>{void load();unsubscribe=window.todoPet.events.onHealthSession(()=>void load());timer=setInterval(()=>{now.value=new Date()},1000)})
onBeforeUnmount(()=>{unsubscribe?.();clearInterval(timer)})
function move(n:number){date.value=shiftPeriod(mode.value,date.value,n)}
function showDay(d:Date){date.value=new Date(d);mode.value='day'}
function chooseDate(value:string){if(value)date.value=new Date(value+'T12:00:00')}
const localInput=(iso:string)=>{const d=new Date(iso);return `${dayKey(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`}
function edit(s:HealthSegment){editing.value=s.id;editStart.value=localInput(s.start);editEnd.value=localInput(s.end!)}
async function save(){if(!editing.value||busy.value)return;busy.value=true;try{await window.todoPet.health.editSegment(editing.value,new Date(editStart.value).toISOString(),new Date(editEnd.value).toISOString());editing.value=null;await load()}catch(e){error.value=String(e)}finally{busy.value=false}}
async function remove(id:string){if(busy.value)return;busy.value=true;try{await window.todoPet.health.deleteEvent(id);await load()}catch(e){error.value=String(e)}finally{busy.value=false}}
const time=(iso:string)=>new Date(iso).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
const daySegments=computed(()=>records.value.segments.filter(s=>Date.parse(s.start)<bounds.value[1].getTime()&&(!s.end||Date.parse(s.end)>bounds.value[0].getTime())))
const dayEvents=computed(()=>records.value.events.filter(e=>Date.parse(e.at)>=bounds.value[0].getTime()&&Date.parse(e.at)<bounds.value[1].getTime()))
function segmentStyle(s:HealthSegment){const [a,b]=bounds.value,span=b.getTime()-a.getTime();const start=Math.max(a.getTime(),Date.parse(s.start)),end=Math.min(b.getTime(),s.end?Date.parse(s.end):now.value.getTime());return {left:`${(start-a.getTime())/span*100}%`,width:`${Math.max(0,end-start)/span*100}%`}}
const displayMetric=(value:number)=>metric.value==='sittingMs'?`${(value/3600000).toFixed(1)} 小时`:`${value} 次`
</script>
<template>
<section class="health-analysis" aria-label="健康记录分析">
  <header class="health-analysis-header"><div><p class="eyebrow">每天的记录，慢慢看见</p><h2>健康记录</h2></div><div class="range-tabs"><button v-for="item in (['day','week','month'] as const)" :key="item" :class="{active:mode===item}" @click="mode=item">{{ {day:'日',week:'周',month:'月'}[item] }}</button></div></header>
  <div class="health-period-nav"><button aria-label="上一周期" @click="move(-1)">←</button><strong>{{ label }}</strong><button aria-label="下一周期" :disabled="bounds[1]>now" @click="move(1)">→</button><button class="text-button" @click="date=new Date()">回到今天</button><input aria-label="选择记录日期" type="date" :value="dayKey(date)" :max="dayKey(now)" @change="chooseDate(($event.target as HTMLInputElement).value)" /></div>
  <p v-if="error" class="record-error" role="alert">{{ error }}</p>
  <div :aria-busy="loading" class="health-summary">
    <article><span>累计坐姿</span><strong>{{ totals.recordedMs?duration(totals.sittingMs):totals.hasRecord?'无时长记录':'未记录' }}</strong></article>
    <article><span>喝水</span><strong>{{ totals.hasRecord?`${totals.water} 次`:'未记录' }}</strong></article>
    <article><span>站起</span><strong>{{ totals.hasRecord?`${totals.stand} 次`:'未记录' }}</strong></article>
  </div>
  <p class="health-summary-note">根据记录状态估算 · {{ mode==='day'?'当天':mode==='week'?'本周':'本月' }}有时长记录 {{ recordDays }} 天<span v-if="mode!=='day'"> · 记录日均坐姿 {{ recordDays?duration(totals.sittingMs/recordDays):'无时长记录' }}（按 {{ recordDays }} 天计算）</span></p>
  <p class="health-insight">{{ totals.recordedMs?`这段时间最长连续坐姿记录为 ${duration(totals.longestMs)}`:totals.legacy?'只有历史行为确认，没有坐姿时长记录':'开始记录后，这里会显示坐姿时长和行为变化。' }}</p>
  <template v-if="mode!=='day'">
    <div class="health-metric-tabs"><button v-for="item in (['sittingMs','water','stand'] as const)" :key="item" :class="{active:metric===item}" @click="metric=item">{{ {sittingMs:'坐姿时长',water:'喝水',stand:'站起'}[item] }}</button><span>单位：{{ metric==='sittingMs'?'小时':'次' }}</span></div>
    <div class="health-chart-wrap"><div class="health-axis"><span>{{ displayMetric(chartMax) }}</span><span>0</span></div><div class="health-chart" :class="{monthly:mode==='month'}">
      <button v-for="d in days" :key="d.key" :disabled="d.date>localDay(now)" :aria-label="`${d.key} ${d.hasRecord?displayMetric(d[metric]):'未记录'}，查看日详情`" :title="`${d.key} · ${metric==='sittingMs'&&!d.recordedMs?(d.hasRecord?'无时长记录':'未记录'):d.hasRecord?displayMetric(d[metric]):'未记录'}`" @click="showDay(d.date)"><div class="health-bar-track"><i v-if="d.hasRecord&&(metric!=='sittingMs'||d.recordedMs)" :style="{height:`${Math.max(1,d[metric]/chartMax*100)}%`}" :class="metric"></i><span v-else class="no-record">—</span></div><small>{{ d.date.getDate() }}</small></button>
    </div></div>
    <p class="health-summary-note">— 未记录／无时长记录 · 点击日期查看详情</p><p class="health-comparison">{{ comparisonCopy }}</p>
  </template>
  <template v-else>
    <h3 class="health-section-title">坐站时间轴 <small>红色坐着 · 蓝色站着 · 空白未记录</small></h3>
    <div class="posture-timeline"><i v-for="s in daySegments" :key="s.id" :class="s.posture" :style="segmentStyle(s)" :title="`${s.posture==='sitting'?'坐着':'站着'} ${time(s.start)}—${s.end?time(s.end):'进行中'}`"></i></div><div class="timeline-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
    <p v-if="!daySegments.length" class="health-summary-note">无时长记录</p>
    <article v-for="s in daySegments" :key="s.id" class="health-detail-row"><span class="posture-label" :class="s.posture">{{ s.posture==='sitting'?'坐着':'站着' }}</span><span>{{ new Date(s.start).toLocaleString('zh-CN') }} — {{ s.end?new Date(s.end).toLocaleString('zh-CN'):'进行中' }}</span><button v-if="s.end" class="text-button" @click="edit(s)">调整时间</button></article>
    <form v-if="editing" class="segment-edit" @submit.prevent="save"><label>开始<input v-model="editStart" type="datetime-local" step="1" required /></label><label>结束<input v-model="editEnd" type="datetime-local" step="1" required /></label><p>只能调整已结束的记录段，时间不能重叠。修改前值会保留。</p><button class="soft-button" :disabled="busy">保存调整</button><button type="button" class="text-button" @click="editing=null">取消</button></form>
    <h3 class="health-section-title">行为记录</h3><p v-if="!dayEvents.length" class="health-summary-note">{{ totals.recordedMs?'当天喝水、站起均为 0 次':'未记录' }}</p>
    <article v-for="e in dayEvents" :key="e.id" class="health-detail-row"><strong>{{ time(e.at) }}</strong><span>{{ e.kind==='water'?'喝水一次':'站起一次' }} <small>{{ {manual:'手动记录',reminder:'提醒确认',legacy:'历史来源'}[e.source] }}</small></span><button class="text-button" :disabled="busy" @click="remove(e.id)">删除误记</button></article>
    <p class="health-summary-note">删除站起事件只修正次数；若坐站时间也有误，请同时调整时间段。</p>
  </template>
  <p v-if="totals.legacy" class="health-summary-note">含 {{ totals.legacy }} 次历史提醒确认，按确认时间归日；历史数据不补造坐姿时长。</p>
</section>
</template>
<style scoped>
.health-analysis{min-width:0;width:100%;margin-top:32px;border-top:4px solid #17171b;padding-top:26px}.health-analysis-header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px}.health-analysis h2{font-size:28px;margin:8px 0 20px}.health-period-nav{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:8px 0 24px}.health-period-nav>button:not(.text-button){border:2px solid #17171b;border-radius:6px;background:#fffdf4;width:34px;height:32px}.health-period-nav input{background:#fffdf4;border:2px solid #17171b;border-radius:5px;padding:5px;max-width:160px}.health-period-nav strong{font-size:14px}.health-summary{display:grid;grid-template-columns:minmax(0,1.5fr) repeat(2,minmax(0,1fr));gap:14px}.health-summary article{border:2px solid #17171b;border-radius:10px;box-shadow:3px 3px 0 #17171b;padding:20px 16px;background:#fffdf4}.health-summary article:first-child{background:#ffe94f}.health-summary span{display:block;font-size:12px;margin-bottom:10px;color:#746c54}.health-summary strong{font-size:clamp(16px,1.7vw,25px)}.health-summary-note{font-size:12px;color:#78715f;line-height:1.8}.health-insight{font-size:14px;margin:18px 0 24px;line-height:1.8}.health-metric-tabs{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.health-metric-tabs button{background:transparent;border:2px solid #17171b;border-radius:5px;padding:6px 12px}.health-metric-tabs button.active{background:#17171b;color:#fffdf4}.health-metric-tabs span{font-size:12px;margin-left:auto;color:#78715f}.health-chart-wrap{display:flex;margin-top:22px}.health-axis{width:60px;display:flex;flex-direction:column;justify-content:space-between;font-size:10px;color:#78715f;padding-bottom:25px}.health-chart{display:flex;gap:12px;flex:1;min-width:0;height:170px;border-bottom:1px solid #c7c0ac}.health-chart button{flex:1;min-width:0;border:0;background:transparent;display:flex;flex-direction:column;align-items:center;padding:0}.health-bar-track{position:relative;height:145px;width:100%;display:flex;align-items:flex-end;justify-content:center;background:repeating-linear-gradient(to top,transparent 0,transparent 35px,#e6e0cf 36px)}.health-bar-track i{display:block;width:60%;max-width:46px;background:#eb3151;border-radius:4px 4px 0 0;border:1px solid #17171b}.health-bar-track i.water{background:#e8b330}.health-bar-track i.stand{background:#2c49d8}.health-chart small{margin-top:8px;font-size:11px}.health-chart.monthly{gap:3px}.health-chart.monthly .health-bar-track i{width:80%}.no-record{font-size:13px;color:#a09b8c}.health-comparison{font-size:13px;color:#625c4c;border-left:3px solid #e8b330;padding-left:12px;margin:20px 0}.health-section-title{font-size:16px;margin-top:28px}.health-section-title small{font-size:11px;font-weight:400;margin-left:12px;color:#78715f}.posture-timeline{height:30px;border:1px solid #c7c0ac;background:#eee9dc;position:relative;border-radius:4px;overflow:hidden;margin-top:16px}.posture-timeline i{position:absolute;height:100%;background:#eb3151}.posture-timeline .standing{background:#2c49d8}.timeline-axis{display:flex;justify-content:space-between;font-size:10px;color:#78715f;margin:7px 0 18px}.health-detail-row{display:flex;flex-wrap:wrap;align-items:center;gap:14px;border-bottom:1px dashed #c7c0ac;padding:12px 0;font-size:12px}.health-detail-row>span{min-width:0;overflow-wrap:anywhere}.health-detail-row small{color:#78715f;margin-left:8px}.health-detail-row .text-button{margin-left:auto;white-space:nowrap;font-size:12px;color:#2c49d8}.posture-label{color:#d52c48;font-weight:bold;white-space:nowrap}.posture-label.standing{color:#2c49d8}.segment-edit{background:#fff6cc;border:2px solid #17171b;padding:20px;border-radius:8px;margin:12px 0}.segment-edit label{display:block;margin:8px 0;font-size:13px}.segment-edit input{margin-left:10px;padding:6px;border:1px solid #17171b;border-radius:4px}.segment-edit p{font-size:12px}.segment-edit .soft-button{font-size:13px;padding:8px 14px}.segment-edit .text-button{margin-left:20px}@media(max-width:1000px){.health-summary{grid-template-columns:1fr}.health-chart.monthly{gap:1px}.health-chart.monthly small{font-size:9px}}
</style>
