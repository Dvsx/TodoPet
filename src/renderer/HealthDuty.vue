<script setup lang="ts">
import type { HealthPreset,HealthSession } from '../shared/types'
import { duration } from '../shared/health-analytics'
import { useHealthToday } from './use-health-today'
defineProps<{presets:HealthPreset[];session:HealthSession}>()
const {today,error}=useHealthToday()
</script>
<template>
<section class="duty-board"><p class="eyebrow">一点一滴</p><h2 class="day-title">今日记录</h2>
<article class="duty-card sitting"><div class="duty-icon">◷</div><div><h3>累计坐姿</h3><strong>{{ today.recordedMs?duration(today.sittingMs):'无时长记录' }}</strong><small>根据记录状态估算</small></div></article>
<article class="duty-card water"><div class="duty-icon">◒</div><div><h3>喝水</h3><strong>{{ today.hasRecord?`${today.water} 次`:'未记录' }}</strong></div></article>
<article class="duty-card stand"><div class="duty-icon">↟</div><div><h3>站起</h3><strong>{{ today.hasRecord?`${today.stand} 次`:'未记录' }}</strong></div></article>
<p class="duty-status">下一次提醒</p>
<p v-for="preset in presets" :key="preset.kind" class="record-next">{{ preset.kind==='water'?'喝水':'站立' }} · {{ !session.active?'记录未进行':!preset.enabled?'已关闭':preset.kind==='stand'&&session.state==='standing'?'坐回来后重新计时':preset.nextTriggerAt?new Date(preset.nextTriggerAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'暂无安排' }}</p>
<p v-if="today.legacy" class="record-note">含 {{ today.legacy }} 次历史确认记录</p><p v-if="error" class="record-error">{{ error }}</p>
</section>
</template>
<style scoped>.duty-card strong{font-size:20px}.sitting .duty-icon{background:#ffe94f;color:#17171b}.record-next{margin:10px 0!important;font-size:13px;line-height:1.8;color:#726d5c}</style>
