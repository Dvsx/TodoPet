<script setup lang="ts">
import { computed,ref,onBeforeUnmount,onMounted } from 'vue'
import { duration } from '../shared/health-analytics'
import { useHealthToday } from './use-health-today'
const {session,today,now,error,refresh}=useHealthToday()
const busy=ref(false),undoId=ref<string|null>(null),notice=ref(''),autoResume=ref(true)
onMounted(async()=>{try{autoResume.value=await window.todoPet.health.autoResumeSetting()}catch(e){error.value=String(e)}})
async function toggleAutoResume(event:Event){try{const enabled=(event.target as HTMLInputElement).checked;await window.todoPet.health.setAutoResume(enabled);autoResume.value=enabled}catch(e){error.value=String(e);(event.target as HTMLInputElement).checked=autoResume.value}}
async function correct(choice:'standing'|'pause'){
  if(busy.value || !session.value.autoResumeSegmentId)return
  busy.value=true
  try{await window.todoPet.health.correctAutoResume(session.value.autoResumeSegmentId,choice);await refresh()}catch(e){error.value=String(e)}finally{busy.value=false}
}
let undoTimer:ReturnType<typeof setTimeout>
onBeforeUnmount(()=>clearTimeout(undoTimer))
const sitting=computed(()=>session.value.state==='sitting')
const current=computed(()=>sitting.value&&session.value.segmentStartedAt?duration(now.value.getTime()-Date.parse(session.value.segmentStartedAt)):'')
async function run(action:'start'|'stop'|'water'|'stand'|'sit'|'resume-sitting'|'resume-standing'|'undo') {
  if(busy.value)return;busy.value=true;error.value=''
  try {
    clearTimeout(undoTimer)
    const oldUndo=undoId.value;undoId.value=null;notice.value=''
    if(action==='start')await window.todoPet.health.start()
    else if(action==='stop')await window.todoPet.health.stop()
    else if(action==='undo' && oldUndo){await window.todoPet.health.undo(oldUndo);notice.value='已撤销'}
    else if(action!=='undo'){
      const result=await window.todoPet.health.action(action,crypto.randomUUID());undoId.value=result.eventId
      if(result.eventId){notice.value=action==='water'?'已记录一次喝水':'已记录一次站起';undoTimer=setTimeout(()=>{undoId.value=null;notice.value=''},10000)}
    }
    await refresh()
  }catch(e){error.value=String(e)}finally{busy.value=false}
}
</script>
<template>
  <header class="content-header"><div><p class="eyebrow">每天一点，留下记录</p><h1>日常健康记录</h1></div>
    <button v-if="!session.startedAt" class="soft-button" :disabled="busy" @click="run('start')">开始记录</button>
    <button v-else class="soft-button duty-stop" :disabled="busy" @click="run('stop')">停止记录</button>
  </header>
  <section class="record-live" :class="{standing:session.state==='standing'}">
    <p class="record-state"><i></i>{{ session.state==='paused'?'已暂停':session.active?(sitting?'正在记录 · 坐着':'正在记录 · 站着'):'尚未开始' }}</p>
    <h2>{{ sitting ? `本次已坐 ${current}` : session.state==='standing'?'站起来，换个姿势':session.state==='paused'?'回来后，按实际姿势继续':'从这一次坐下开始' }}</h2>
    <p class="record-today">今日累计坐 <strong>{{ today.recordedMs?duration(today.sittingMs):'无时长记录' }}</strong></p>
    <div v-if="session.active" class="record-actions"><button class="soft-button" :disabled="busy" @click="run('water')">◒ 喝了一次水</button><button class="soft-button posture-button" :disabled="busy" @click="run(sitting?'stand':'sit')">{{ sitting?'↟ 站起来了':'↓ 坐回来了' }}</button></div>
    <template v-else-if="session.state==='paused'"><div class="record-actions"><button class="soft-button" :disabled="busy" @click="run('resume-sitting')">坐着继续</button><button class="soft-button posture-button" :disabled="busy" @click="run('resume-standing')">站着继续</button></div></template>
    <p v-else>打开软件会按坐姿开始记录。关掉主窗口后，托盘会继续记录。</p>
    <p v-if="session.autoResumeSegmentId" class="record-feedback">已自动按坐姿继续 <button class="text-button" :disabled="busy" @click="correct('standing')">我在站着</button> · <button class="text-button" :disabled="busy" @click="correct('pause')">暂不记录</button></p>
    <p class="record-note">按使用状态估算，不自动识别姿势 · 锁屏算站起，解锁算坐回 · 休眠暂停计时</p>
    <label class="record-note"><input type="checkbox" :checked="autoResume" @change="toggleAutoResume"> 回来后自动继续记录</label>
    <p class="record-feedback" aria-live="polite">{{ notice }} <button v-if="undoId" class="text-button" @click="run('undo')">撤销</button></p>
  </section>
  <p v-if="error" class="record-error" role="alert">{{ error }}</p>
</template>
<style>
.record-live{padding:28px 32px;margin:24px 0 32px;border:3px solid #17171b;border-radius:14px;background:#fffbea;box-shadow:5px 5px 0 #17171b}.record-state{font-size:13px;font-weight:800;color:#b72743}.record-state i{display:inline-block;width:9px;height:9px;border-radius:50%;background:currentColor;margin-right:8px}.record-live h2{font-size:clamp(22px,2.1vw,32px);margin:18px 0 12px}.record-today{color:#686351;margin-bottom:26px}.record-today strong{color:#17171b}.record-actions{display:flex;gap:16px;flex-wrap:wrap}.posture-button{background:#2b49d8!important;color:white!important}.record-note{font-size:12px;color:#777260;margin-top:24px}.record-feedback{min-height:24px;margin:8px 0 0;font-size:13px}.record-feedback .text-button{color:#2b49d8;text-decoration:underline}.record-error{color:#b41b36;overflow-wrap:anywhere}.record-live.standing{background:#f1f3ff}.health-settings>summary{cursor:pointer;font-weight:800;padding:14px 0;margin-bottom:14px}.health-settings>p{color:#777260;font-size:13px}button:disabled{opacity:.5;cursor:wait}
</style>
