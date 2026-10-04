<script setup lang="ts">
import { computed, ref } from 'vue'
import HealthAnalytics from './HealthAnalytics.vue'
import { completedInRange, consecutiveCompletedDays, noteCounts, overdueOpenCount, priorityMix, rangeStart, statsLine, weekdayCounts, type StatsRange } from '../shared/analytics'
import type { Note, ReminderOccurrence, Task } from '../shared/types'

const props = defineProps<{
  tasks: Task[]
  allTasks: Task[]
  notes: Note[]
  history: ReminderOccurrence[]
}>()
const selectedDay = defineModel<string>('selectedDay', { required: true })
const range = ref<StatsRange>('week')

const keyOf = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
const dayKey = (iso: string) => keyOf(new Date(iso))

const now = computed(() => new Date())
const start = computed(() => rangeStart(range.value, now.value))
const rangedCompleted = computed(() => completedInRange(props.tasks, start.value, now.value))
const notesInRange = computed(() => noteCounts(props.notes, start.value, now.value))
const overdue = computed(() => overdueOpenCount(props.allTasks, now.value))
const mix = computed(() => priorityMix(rangedCompleted.value))
const weekdays = computed(() => weekdayCounts(rangedCompleted.value))
const weekdayMax = computed(() => Math.max(1, ...weekdays.value.map((item) => item.count)))
const line = computed(() => statsLine({
  completed: rangedCompleted.value.length,
  overdue: overdue.value,
  waterRate: 0,
  standRate: 0,
  waterTotal: 0,
  standTotal: 0,
  sparks: notesInRange.value.spark,
  wraps: notesInRange.value.wrap
}))

const byDay = computed(() => {
  const map = new Map<string, Task[]>()
  for (const task of props.tasks) {
    if (!task.completedAt) continue
    const key = dayKey(task.completedAt)
    const list = map.get(key)
    if (list) list.push(task)
    else map.set(key, [task])
  }
  return map
})
const countOf = (key: string) => byDay.value.get(key)?.length ?? 0

const todayCount = computed(() => countOf(keyOf(new Date())))
const weekCount = computed(() => {
  const end = new Date(); end.setHours(0, 0, 0, 0)
  const cursor = new Date(end)
  cursor.setDate(end.getDate() - ((end.getDay() + 6) % 7))
  let total = 0
  while (cursor <= end) { total += countOf(keyOf(cursor)); cursor.setDate(cursor.getDate() + 1) }
  return total
})
const streak = computed(() => consecutiveCompletedDays(props.tasks, now.value))

type Cell = { key: string; date: Date; count: number; future: boolean; today: boolean }
const weeks = computed(() => {
  const end = new Date(); end.setHours(0, 0, 0, 0)
  const monday = new Date(end)
  monday.setDate(end.getDate() - ((end.getDay() + 6) % 7))
  const origin = new Date(monday)
  origin.setDate(monday.getDate() - 11 * 7)
  const todayKey = keyOf(end)
  const cols: { label: string; cells: Cell[] }[] = []
  let lastMonth = -1
  for (let w = 0; w < 12; w++) {
    const colStart = new Date(origin)
    colStart.setDate(origin.getDate() + w * 7)
    const label = colStart.getMonth() !== lastMonth ? `${colStart.getMonth() + 1}月` : ''
    lastMonth = colStart.getMonth()
    const cells: Cell[] = []
    for (let d = 0; d < 7; d++) {
      const date = new Date(colStart)
      date.setDate(colStart.getDate() + d)
      const key = keyOf(date)
      cells.push({ key, date, count: countOf(key), future: date > end, today: key === todayKey })
    }
    cols.push({ label, cells })
  }
  return cols
})

const levelOf = (count: number) => count === 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : count <= 7 ? 3 : 4
const tooltip = (cell: Cell) => `${cell.date.getMonth() + 1}月${cell.date.getDate()}日 · 完成 ${cell.count}`
const pct = (ratio: number) => `${Math.round(ratio * 100)}%`
</script>

<template>
  <div class="review-board">
    <header class="content-header">
      <div><p class="eyebrow">STATS</p><h1>数据分析</h1></div>
      <div class="range-tabs">
        <button :class="{ active: range === 'week' }" @click="range = 'week'">本周</button>
        <button :class="{ active: range === 'month' }" @click="range = 'month'">本月</button>
        <button :class="{ active: range === 'weeks12' }" @click="range = 'weeks12'">近 12 周</button>
      </div>
    </header>

    <div class="hero-row">
      <article class="hero-card hero-today"><span class="hero-num">{{ todayCount }}</span><span class="hero-label">今日完成</span></article>
      <article class="hero-card hero-streak"><span class="hero-num">{{ streak }}</span><span class="hero-label">连续有完成</span></article>
      <article class="hero-card hero-week"><span class="hero-num">{{ weekCount }}</span><span class="hero-label">本周战果</span></article>
    </div>
    <p class="stats-line">{{ line }}</p>

    <section class="heatmap-panel">
      <h2>完成日历<small>近 12 周</small></h2>
      <div class="heatmap-months"><span v-for="(col, index) in weeks" :key="index">{{ col.label }}</span></div>
      <div class="heatmap">
        <div v-for="(col, index) in weeks" :key="index" class="heatmap-col">
          <button
            v-for="cell in col.cells"
            :key="cell.key"
            class="heat-cell"
            :class="[`lv-${levelOf(cell.count)}`, { today: cell.today, selected: cell.key === selectedDay, future: cell.future }]"
            :title="tooltip(cell)"
            @click="selectedDay = cell.key"
          ></button>
        </div>
      </div>
      <div class="heat-legend">少 <i class="lv-0"></i><i class="lv-1"></i><i class="lv-2"></i><i class="lv-3"></i><i class="lv-4"></i> 多</div>
    </section>

    <section class="stat-panel">
      <h2>任务优先级<small>{{ rangedCompleted.length }} 件完成</small></h2>
      <div class="stat-bars">
        <div v-for="item in mix" :key="item.priority" class="stat-bar">
          <span>{{ item.label }}</span>
          <i><b :style="{ width: pct(item.ratio) }"></b></i>
          <em>{{ item.count }}</em>
        </div>
      </div>
      <h2>星期分布</h2>
      <div class="stat-bars weekday-bars">
        <div v-for="item in weekdays" :key="item.weekday" class="stat-bar">
          <span>周{{ item.label }}</span>
          <i><b :style="{ width: `${Math.round((item.count / weekdayMax) * 100)}%` }"></b></i>
          <em>{{ item.count }}</em>
        </div>
      </div>
    </section>

    <HealthAnalytics />
  </div>
</template>
