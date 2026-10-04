<script setup lang="ts">
import { computed } from 'vue'
import type { Note, ReminderOccurrence, Task } from '../shared/types'

const props = defineProps<{
  tasks: Task[]
  notes: Note[]
  history: ReminderOccurrence[]
  selectedDay: string
}>()

const keyOf = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
const dayKey = (iso: string) => keyOf(new Date(iso))

const selectedTasks = computed(() =>
  props.tasks
    .filter((task) => task.completedAt && dayKey(task.completedAt) === props.selectedDay)
    .slice()
    .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
)

const selectedNotes = computed(() =>
  props.notes.filter((note) => dayKey(note.createdAt) === props.selectedDay)
)

const selectedLabel = computed(() => {
  const [y, m, d] = props.selectedDay.split('-').map(Number)
  return `${y} 年 ${m + 1} 月 ${d} 日`
})

const weekRank = computed(() => {
  const count = selectedTasks.value.length
  if (!count) return ''
  const [y, m, d] = props.selectedDay.split('-').map(Number)
  const day = new Date(y, m, d)
  const monday = new Date(day)
  monday.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  const scores: number[] = []
  for (let i = 0; i < 7; i++) {
    const cursor = new Date(monday)
    cursor.setDate(monday.getDate() + i)
    const key = keyOf(cursor)
    scores.push(props.tasks.filter((task) => task.completedAt && dayKey(task.completedAt) === key).length)
  }
  const better = scores.filter((n) => n > count).length
  return `这周第 ${better + 1} 忙的一天`
})

const empty = computed(() => !selectedTasks.value.length && !selectedNotes.value.length)
const formatTime = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
const priorityLabel = { none: '普通', low: '低', medium: '中', high: '高' } as const
const checkinLabel = (row: ReminderOccurrence) => {
  const kind = row.sourceId === 'water' ? '喝水' : '站立'
  return row.status === 'acknowledged' ? `${kind} · 打卡` : `${kind} · 跳过`
}
const noteLabel = (note: Note) => note.kind === 'spark' ? '灵感' : '总结'
</script>

<template>
  <section class="day-list">
    <p class="eyebrow">当日记录</p>
    <h2 class="day-title">{{ selectedLabel }}</h2>
    <article v-for="task in selectedTasks" :key="task.id" class="day-task">
      <span class="day-check">✓</span>
      <strong>{{ task.title }}</strong>
      <b :class="`priority ${task.priority}`">{{ priorityLabel[task.priority] }}</b>
      <time>{{ formatTime(task.completedAt) }}</time>
    </article>
    <article v-for="note in selectedNotes" :key="note.id" class="day-task">
      <span class="day-check note">{{ note.kind === 'spark' ? '✦' : '✎' }}</span>
      <strong>{{ note.title }}</strong>
      <b>{{ noteLabel(note) }}</b>
    </article>
    <div v-if="empty" class="day-empty">这天没有记录</div>
    <p v-if="weekRank" class="day-rank">{{ weekRank }}</p>
  </section>
</template>
