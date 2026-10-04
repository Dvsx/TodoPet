<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ReminderOccurrence } from '../shared/types'

const reminder = ref<ReminderOccurrence | null>(null)
let unsubscribe: (() => void) | null = null
let acting = false

const isHealth = computed(() => reminder.value?.sourceType === 'health')
const isWater = computed(() => reminder.value?.sourceId === 'water')

function takeReminder(): ReminderOccurrence | null {
  if (acting) return null
  const current = reminder.value
  if (!current) return null
  acting = true
  reminder.value = null
  return current
}

async function acknowledge(event: Event) {
  event.preventDefault()
  const current = takeReminder()
  if (!current) return
  try {
    if (current.sourceType === 'task') await window.todoPet.tasks.complete(current.sourceId)
    await window.todoPet.health.acknowledge(current.id)
  } catch {
    /* preview UUID or already gone */
  } finally {
    acting = false
  }
}

async function skip(event: Event) {
  event.preventDefault()
  const current = takeReminder()
  if (!current) return
  try {
    if (current.sourceType === 'health') await window.todoPet.health.miss(current.id)
    else await window.todoPet.health.snooze(current.id, 10)
  } catch {
    /* preview UUID or already gone */
  } finally {
    acting = false
  }
}

onMounted(() => {
  unsubscribe = window.todoPet.events.onReminder((next) => {
    acting = false
    reminder.value = next
  })
})
onBeforeUnmount(() => unsubscribe?.())
</script>
<template>
  <div v-if="reminder" class="reminder-bubble">
    <p class="bubble-kicker">蜘蛛感应</p>
    <h1>{{ reminder.title }}</h1>
    <p>{{ isHealth ? '照顾好自己，也是待办事项。' : '现在处理，还是先留十分钟？' }}</p>
    <div>
      <button class="bubble-primary" @pointerdown="acknowledge">{{ isHealth ? (isWater ? '喝了' : '站了') : '完成任务' }}</button>
      <button class="bubble-secondary" @pointerdown="skip">{{ isHealth ? '这次跳过' : '10 分钟后' }}</button>
    </div>
  </div>
</template>
