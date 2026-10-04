<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createDebouncedSave } from './debounced-save'
import { useTodoStore } from './stores/todo'
import ReviewBoard from './ReviewBoard.vue'
import DayReport from './DayReport.vue'
import HealthDuty from './HealthDuty.vue'
import HealthRecording from './HealthRecording.vue'
import NotesBoard from './NotesBoard.vue'
import { groupByDay } from './day-label'
import type { Note, NoteInput, NoteKind, Task, TaskInput } from '../shared/types'
import appIcon from '../../resources/icon/icon.png'

const store = useTodoStore()
const draftTitle = ref('')
const selected = ref<Task | null>(null)
const selectedNote = ref<Note | null>(null)
const showComposer = ref(false)
const showNoteComposer = ref(false)
const composeInput = ref<HTMLInputElement | null>(null)
const pendingDelete = ref<{ id: string; title: string; kind: 'task' | 'note' } | null>(null)
const view = ref<'tasks' | 'trash' | 'health' | 'review' | 'spark' | 'wrap'>('tasks')
const todayKey = () => {
  const now = new Date()
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`
}
const selectedDay = ref(todayKey())
const visibleTasks = computed(() => store.tasks)
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '未设置时间'
const formatTime = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : ''
const localDate = (value: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const asIso = (value: string) => value ? new Date(value).toISOString() : null
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
const taskSaveStatus = ref<SaveStatus>('idle')
const noteSaveStatus = ref<SaveStatus>('idle')
const savedTaskById = new Map<string, string>()
const savedNoteById = new Map<string, string>()
let skippingTaskId: string | null = null
let skippingNoteId: string | null = null
let taskSaveChain: Promise<void> = Promise.resolve()
let noteSaveChain: Promise<void> = Promise.resolve()
const snapshotTask = (task: Task) => JSON.stringify({ title: task.title, notes: task.notes, priority: task.priority, dueAt: task.dueAt, remindAt: task.remindAt })
const snapshotNote = (note: Note) => JSON.stringify({ title: note.title, body: note.body })
const taskSaveLabel = computed(() => taskSaveStatus.value === 'saving' ? '正在保存' : taskSaveStatus.value === 'saved' ? '已保存' : taskSaveStatus.value === 'error' ? '没存上' : '')
const noteSaveLabel = computed(() => noteSaveStatus.value === 'saving' ? '正在保存' : noteSaveStatus.value === 'saved' ? '已保存' : noteSaveStatus.value === 'error' ? '没存上' : '')
function rememberTask(task: Task | null) {
  selected.value = task ? { ...task } : null
  if (task) savedTaskById.set(task.id, snapshotTask(task))
}
function rememberNote(note: Note | null) {
  selectedNote.value = note ? { ...note } : null
  if (note) savedNoteById.set(note.id, snapshotNote(note))
}
function taskPatch(task: Task) {
  const input: Partial<TaskInput> = { notes: task.notes, priority: task.priority, dueAt: task.dueAt, remindAt: task.remindAt }
  const title = task.title.trim()
  if (title) input.title = title
  return input
}
function notePatch(note: Note) {
  const input: Partial<NoteInput> = { body: note.body }
  const title = note.title.trim()
  if (title) input.title = title
  return input
}
async function persistTask(task: Task) {
  if (skippingTaskId === task.id) return
  const snap = snapshotTask(task)
  if (savedTaskById.get(task.id) === snap) return
  if (selected.value?.id === task.id) taskSaveStatus.value = 'saving'
  try {
    await store.patch(task.id, taskPatch(task))
    savedTaskById.set(task.id, snap)
    if (selected.value?.id === task.id) taskSaveStatus.value = 'saved'
  } catch {
    if (selected.value?.id === task.id) taskSaveStatus.value = 'error'
  }
}
async function persistNote(note: Note) {
  if (skippingNoteId === note.id) return
  const snap = snapshotNote(note)
  if (savedNoteById.get(note.id) === snap) return
  if (selectedNote.value?.id === note.id) noteSaveStatus.value = 'saving'
  try {
    await store.patchNote(note.id, notePatch(note))
    savedNoteById.set(note.id, snap)
    if (selectedNote.value?.id === note.id) noteSaveStatus.value = 'saved'
  } catch {
    if (selectedNote.value?.id === note.id) noteSaveStatus.value = 'error'
  }
}
function enqueueTaskSave(task?: Task | null) {
  const target = task ?? selected.value
  if (!target) return taskSaveChain
  const copy = { ...target }
  taskSaveChain = taskSaveChain.then(() => persistTask(copy), () => persistTask(copy))
  return taskSaveChain
}
function enqueueNoteSave(note?: Note | null) {
  const target = note ?? selectedNote.value
  if (!target) return noteSaveChain
  const copy = { ...target }
  noteSaveChain = noteSaveChain.then(() => persistNote(copy), () => persistNote(copy))
  return noteSaveChain
}
const scheduleTaskSave = createDebouncedSave(() => { void enqueueTaskSave(selected.value) })
const scheduleNoteSave = createDebouncedSave(() => { void enqueueNoteSave(selectedNote.value) })
async function flushTaskNow() {
  scheduleTaskSave.cancel()
  await enqueueTaskSave(selected.value)
}
async function flushNoteNow() {
  scheduleNoteSave.cancel()
  await enqueueNoteSave(selectedNote.value)
}
async function flushAll() {
  await Promise.all([flushTaskNow(), flushNoteNow()])
}
async function selectTask(task: Task) {
  if (selected.value?.id === task.id) return
  await flushTaskNow()
  rememberTask(task)
  taskSaveStatus.value = 'idle'
}
async function selectNote(note: Note) {
  if (selectedNote.value?.id === note.id) return
  await flushNoteNow()
  rememberNote(note)
  noteSaveStatus.value = 'idle'
}

const openGroups = computed(() => groupByDay(
  visibleTasks.value.filter((task) => task.status !== 'completed'),
  (task) => task.dueAt ?? task.createdAt
))
const doneGroups = computed(() => groupByDay(
  visibleTasks.value.filter((task) => task.status === 'completed'),
  (task) => task.completedAt ?? task.updatedAt
))
const trashGroups = computed(() => groupByDay(
  store.archivedTasks,
  (task) => task.updatedAt
))
const currentNotes = computed(() => view.value === 'wrap' ? store.wraps : store.sparks)
const currentNoteKind = computed<NoteKind>(() => view.value === 'wrap' ? 'wrap' : 'spark')
function cardStamp(task: Task) {
  if (task.status === 'archived') return `丢弃 ${formatDate(task.updatedAt)}`
  if (task.status === 'completed' && task.completedAt) return `完成 ${formatDate(task.completedAt)}`
  return `创建 ${formatDate(task.createdAt)}`
}

function visibleList() {
  return view.value === 'trash' ? store.archivedTasks : store.tasks
}

function ensureSelected(preferId?: string | null) {
  const tasks = visibleList()
  if (!tasks.length) { rememberTask(null); return }
  const preferred = preferId ? tasks.find((item) => item.id === preferId) : null
  if (preferred) {
    if (selected.value?.id === preferred.id && savedTaskById.get(preferred.id) !== snapshotTask(selected.value)) return
    rememberTask(preferred)
    return
  }
  if (selected.value && tasks.some((item) => item.id === selected.value!.id)) {
    const fresh = tasks.find((item) => item.id === selected.value!.id)
    if (fresh && savedTaskById.get(fresh.id) === snapshotTask(selected.value)) rememberTask(fresh)
    return
  }
  const nextOpen = tasks.find((item) => item.status !== 'completed')
  rememberTask(nextOpen ?? tasks[0])
}

function ensureSelectedNote(preferId?: string | null) {
  const notes = currentNotes.value
  if (!notes.length) { rememberNote(null); return }
  const preferred = preferId ? notes.find((item) => item.id === preferId) : null
  if (preferred) {
    if (selectedNote.value?.id === preferred.id && savedNoteById.get(preferred.id) !== snapshotNote(selectedNote.value)) return
    rememberNote(preferred)
    return
  }
  if (selectedNote.value && notes.some((item) => item.id === selectedNote.value!.id)) {
    const fresh = notes.find((item) => item.id === selectedNote.value!.id)
    if (fresh && savedNoteById.get(fresh.id) === snapshotNote(selectedNote.value)) rememberNote(fresh)
    return
  }
  rememberNote(notes[0])
}

async function openNotes(kind: NoteKind) {
  await flushAll()
  view.value = kind
  showComposer.value = false
  await store.loadNotes(kind)
  ensureSelectedNote()
}

function tomorrowDueAt() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.toISOString()
}
async function createTask(forTomorrow = false) {
  if (!draftTitle.value.trim()) return
  await flushTaskNow()
  const task = await store.create({
    title: draftTitle.value,
    ...(forTomorrow ? { dueAt: tomorrowDueAt() } : {})
  })
  draftTitle.value = ''
  showComposer.value = false
  if (task) rememberTask(task)
}
const thwipId = ref<string | null>(null)
let thwipTimer: ReturnType<typeof setTimeout> | null = null
async function complete(task: Task) {
  await flushTaskNow()
  thwipId.value = task.id
  if (thwipTimer) clearTimeout(thwipTimer)
  thwipTimer = setTimeout(() => { thwipId.value = null; thwipTimer = null }, 750)
  const list = store.tasks
  const idx = list.findIndex((item) => item.id === task.id)
  const nextOpen = list.slice(idx + 1).find((item) => item.status !== 'completed' && item.id !== task.id)
    ?? list.find((item) => item.status !== 'completed' && item.id !== task.id)
  try {
    await store.complete(task.id)
    ensureSelected(nextOpen?.id ?? null)
  } catch {
    thwipId.value = null
    if (thwipTimer) { clearTimeout(thwipTimer); thwipTimer = null }
  }
}
async function reopen(task: Task) {
  await flushTaskNow()
  await store.reopen(task.id)
  ensureSelected(task.id)
}
async function toggleDone(task: Task) {
  if (task.status === 'completed') await reopen(task)
  else await complete(task)
}
async function discardTask(task: Task) {
  if (task.status !== 'open') return
  await flushTaskNow()
  skippingTaskId = task.id
  scheduleTaskSave.cancel()
  const list = store.tasks
  const idx = list.findIndex((item) => item.id === task.id)
  const nextOpen = list.slice(idx + 1).find((item) => item.status !== 'completed' && item.id !== task.id)
    ?? list.find((item) => item.status !== 'completed' && item.id !== task.id)
  try {
    await store.archive(task.id)
    savedTaskById.delete(task.id)
    skippingTaskId = null
    ensureSelected(nextOpen?.id ?? null)
  } catch {
    skippingTaskId = null
  }
}
async function restoreTask(task: Task) {
  if (task.status !== 'archived') return
  await flushTaskNow()
  skippingTaskId = task.id
  scheduleTaskSave.cancel()
  const list = store.archivedTasks
  const idx = list.findIndex((item) => item.id === task.id)
  const next = list[idx + 1] ?? list[idx - 1]
  try {
    await store.restore(task.id)
    savedTaskById.delete(task.id)
    skippingTaskId = null
    ensureSelected(next && next.id !== task.id ? next.id : null)
  } catch {
    skippingTaskId = null
  }
}
async function createNote(title: string) {
  await flushNoteNow()
  const note = await store.createNote(currentNoteKind.value, { title })
  if (note) rememberNote(note)
}
async function removeTask() {
  if (!selected.value) return
  pendingDelete.value = { id: selected.value.id, title: selected.value.title, kind: 'task' }
}
async function removeNote() {
  if (!selectedNote.value) return
  pendingDelete.value = { id: selectedNote.value.id, title: selectedNote.value.title, kind: 'note' }
}
async function cancelRemove() {
  pendingDelete.value = null
}
async function confirmRemove() {
  const item = pendingDelete.value
  if (!item) return
  pendingDelete.value = null
  if (item.kind === 'task') {
    skippingTaskId = item.id
    scheduleTaskSave.cancel()
    const list = view.value === 'trash' ? store.archivedTasks : store.tasks
    const idx = list.findIndex((entry) => entry.id === item.id)
    const next = list[idx + 1] ?? list[idx - 1]
    await store.remove(item.id)
    savedTaskById.delete(item.id)
    skippingTaskId = null
    rememberTask(null)
    ensureSelected(next && next.id !== item.id ? next.id : null)
    return
  }
  skippingNoteId = item.id
  scheduleNoteSave.cancel()
  const list = currentNotes.value
  const idx = list.findIndex((entry) => entry.id === item.id)
  const next = list[idx + 1] ?? list[idx - 1]
  await store.removeNote(item.id, currentNoteKind.value)
  savedNoteById.delete(item.id)
  skippingNoteId = null
  rememberNote(null)
  ensureSelectedNote(next && next.id !== item.id ? next.id : null)
}
async function togglePreset(kind: 'water' | 'stand') {
  const preset = store.health.find((item) => item.kind === kind)
  if (preset) await store.updateHealth({ ...preset, enabled: !preset.enabled })
}
async function updatePresetInterval(kind: 'water' | 'stand', value: string) {
  const preset = store.health.find((item) => item.kind === kind)
  if (preset) await store.updateHealth({ ...preset, intervalMinutes: Number(value) })
}
const healthSettingsError = ref('')
async function updatePreset(kind: 'water' | 'stand', update: Record<string, unknown>) {
  const preset = store.health.find((item) => item.kind === kind)
  if(preset){healthSettingsError.value='';try{await store.updateHealth({...preset,...update})}catch{healthSettingsError.value='请检查提醒时段：结束时间需晚于开始时间。'}}
}
async function toggleWeekday(kind: 'water' | 'stand', weekday: number) {
  const preset = store.health.find((item) => item.kind === kind)
  if (!preset) return
  const weekdays = preset.weekdays.includes(weekday) ? preset.weekdays.filter((item) => item !== weekday) : [...preset.weekdays, weekday].sort()
  if (weekdays.length) await store.updateHealth({ ...preset, weekdays })
}
const minimize = () => window.todoPet.window.minimize()
const maximized = ref(false)
async function syncMaximized() { maximized.value = await window.todoPet.window.isMaximized() }
async function onToggleMaximize() { maximized.value = await window.todoPet.window.toggleMaximize() }
async function closeWindow() {
  await flushAll()
  window.todoPet.window.close()
}
async function clockOut() {
  await flushAll()
  await window.todoPet.window.quit()
}
async function openTasks() {
  await flushAll()
  view.value = 'tasks'
  showNoteComposer.value = false
  ensureSelected()
}
async function openTrash() {
  await flushAll()
  view.value = 'trash'
  showComposer.value = false
  showNoteComposer.value = false
  await store.loadArchived()
  ensureSelected()
}
function openNotesSpark() { void openNotes('spark') }
function openNotesWrap() { void openNotes('wrap') }
async function openReview() {
  await flushAll()
  view.value = 'review'
  showNoteComposer.value = false
  void store.loadStats()
}
async function openHealth() {
  await flushAll()
  view.value = 'health'
  showNoteComposer.value = false
}
async function startNewTask() {
  await flushAll()
  view.value = 'tasks'
  showComposer.value = true
}
let unsubscribers: Array<() => void> = []
onMounted(async () => {
  document.title = 'TodoPet'
  await store.load('all')
  void store.loadCompleted()
  void store.loadArchived()
  ensureSelected()
  window.addEventListener('keydown', onGlobalKey)
  unsubscribers = [
    window.todoPet.events.onTaskChanged(() => { void store.refresh(); void store.loadCompleted(); void store.loadArchived() }),
    window.todoPet.events.onHealthSession((session) => {
      store.applyHealthSession(session)
      void store.loadHealth()
    }),
    window.todoPet.events.onMaximized((value) => { maximized.value = value })
  ]
  void syncMaximized()
})
onBeforeUnmount(() => {
  unsubscribers.forEach((unsubscribe) => unsubscribe())
  if (thwipTimer) clearTimeout(thwipTimer)
  window.removeEventListener('keydown', onGlobalKey)
  void flushAll()
})
watch(showComposer, async (open) => {
  if (!open) return
  await nextTick()
  composeInput.value?.focus()
})
function onGlobalKey(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (pendingDelete.value) { pendingDelete.value = null; event.preventDefault() }
}
watch(selected, () => {
  const task = selected.value
  if (!task) return
  if (savedTaskById.get(task.id) === snapshotTask(task)) return
  scheduleTaskSave()
}, { deep: true })
watch(selectedNote, () => {
  const note = selectedNote.value
  if (!note) return
  if (savedNoteById.get(note.id) === snapshotNote(note)) return
  scheduleNoteSave()
}, { deep: true })
</script>

<template>
  <main class="app-shell">
    <header class="titlebar">
      <div class="window-title">TodoPet</div>
      <div class="window-controls">
        <button class="window-button" aria-label="最小化" @click="minimize">─</button>
        <button class="window-button" :aria-label="maximized ? '还原' : '最大化'" @click="onToggleMaximize"><i :class="maximized ? 'icon-restore' : 'icon-maximize'"></i></button>
        <button class="window-button close" aria-label="关闭" @click="closeWindow">✕</button>
      </div>
    </header>
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-mark" :src="appIcon" alt="" width="40" height="40" draggable="false" />
        <div><strong>TodoPet</strong><small>和蜘蛛侠一起完成</small></div>
      </div>
      <button class="new-task" @click="startNewTask">＋ 新建任务</button>
      <nav>
        <button :class="{ active: view === 'tasks' }" @click="openTasks"><span>◷</span>任务清单</button>
        <button :class="{ active: view === 'trash' }" @click="openTrash"><span>⊘</span>垃圾篓</button>
        <button :class="{ active: view === 'spark' }" @click="openNotesSpark"><span>✦</span>灵感</button>
        <button :class="{ active: view === 'wrap' }" @click="openNotesWrap"><span>✎</span>总结</button>
        <button :class="{ active: view === 'review' }" @click="openReview"><span>▦</span>数据分析</button>
        <button :class="{ active: view === 'health' }" @click="openHealth"><span>♡</span>健康记录</button>
      </nav>
      <div class="sidebar-bottom">
        <button class="clock-out" @click="clockOut">下班</button>
        <p class="local-status">数据只保存在本机</p>
      </div>
    </aside>
    <section class="content">
      <template v-if="view === 'tasks'">
        <header class="content-header">
          <div><p class="eyebrow">全部任务</p><h1>任务清单</h1></div>
          <button class="soft-button" @click="showComposer = true">＋ 添加</button>
        </header>
        <div v-if="showComposer" class="quick-compose">
          <input ref="composeInput" v-model="draftTitle" placeholder="写下要完成的一件事…" @keyup.enter="createTask()" />
          <button @click="createTask()">添加</button>
          <button class="tomorrow-button" @click="createTask(true)">明天</button>
          <button class="text-button" @click="showComposer = false">取消</button>
        </div>
        <div v-if="store.busy" class="empty">正在整理任务…</div>
        <div v-else-if="!visibleTasks.length" class="empty">
          <div class="empty-hang"><i class="empty-strand"></i><div class="empty-note">蜘蛛刚巡逻完<br />这里干干净净</div></div>
          <h2>这里很轻，正适合开始</h2>
          <p>给蜘蛛侠一件今天想完成的事吧。</p>
        </div>
        <div v-else class="task-list">
          <section v-for="group in openGroups" :key="`open-${group.key}`" class="task-day">
            <h2 class="task-day-label">{{ group.label }}</h2>
            <article
              v-for="task in group.items"
              :key="task.id"
              class="task-card"
              :class="{ selected: selected?.id === task.id, thwip: thwipId === task.id }"
              @click="selectTask(task)"
            >
              <button class="check" :aria-label="`完成 ${task.title}`" @click.stop="toggleDone(task)"></button>
              <div class="task-copy">
                <strong>{{ task.title }}</strong>
                <span v-if="task.notes">{{ task.notes }}</span>
                <div class="task-meta">
                  <small>{{ cardStamp(task) }}</small>
                  <small v-if="task.dueAt">截止 {{ formatDate(task.dueAt) }}</small>
                  <small v-if="task.remindAt">提醒 {{ formatTime(task.remindAt) }}</small>
                  <b :class="`priority ${task.priority}`">{{ task.priority === 'none' ? '普通' : task.priority }}</b>
                </div>
              </div>
              <button class="discard" :aria-label="`丢弃 ${task.title}`" @click.stop="discardTask(task)">丢弃</button>
            </article>
          </section>
          <p v-if="openGroups.length && doneGroups.length" class="task-split">已完成</p>
          <section v-for="group in doneGroups" :key="`done-${group.key}`" class="task-day">
            <h2 class="task-day-label">{{ group.label }}</h2>
            <article
              v-for="task in group.items"
              :key="task.id"
              class="task-card done"
              :class="{ selected: selected?.id === task.id, thwip: thwipId === task.id }"
              @click="selectTask(task)"
            >
              <button class="check" :aria-label="`取消完成 ${task.title}`" @click.stop="toggleDone(task)">✓</button>
              <div class="task-copy">
                <strong>{{ task.title }}</strong>
                <span v-if="task.notes">{{ task.notes }}</span>
                <div class="task-meta">
                  <small>{{ cardStamp(task) }}</small>
                  <b :class="`priority ${task.priority}`">{{ task.priority === 'none' ? '普通' : task.priority }}</b>
                </div>
              </div>
            </article>
          </section>
        </div>
      </template>
      <template v-else-if="view === 'trash'">
        <header class="content-header">
          <div><p class="eyebrow">已丢弃</p><h1>垃圾篓</h1></div>
        </header>
        <div v-if="!store.archivedTasks.length" class="empty">
          <div class="empty-hang"><i class="empty-strand"></i><div class="empty-note">篓里还没有丢掉的事</div></div>
          <h2>篓里还没有丢掉的事</h2>
          <p>不想做的任务丢弃后会出现在这里。</p>
        </div>
        <div v-else class="task-list">
          <section v-for="group in trashGroups" :key="`trash-${group.key}`" class="task-day">
            <h2 class="task-day-label">{{ group.label }}</h2>
            <article
              v-for="task in group.items"
              :key="task.id"
              class="task-card"
              :class="{ selected: selected?.id === task.id }"
              @click="selectTask(task)"
            >
              <div class="task-copy">
                <strong>{{ task.title }}</strong>
                <span v-if="task.notes">{{ task.notes }}</span>
                <div class="task-meta">
                  <small>{{ cardStamp(task) }}</small>
                  <b :class="`priority ${task.priority}`">{{ task.priority === 'none' ? '普通' : task.priority }}</b>
                </div>
              </div>
              <button class="discard" :aria-label="`放回 ${task.title}`" @click.stop="restoreTask(task)">放回</button>
            </article>
          </section>
        </div>
      </template>
      <template v-else-if="view === 'spark' || view === 'wrap'">
        <NotesBoard
          :kind="currentNoteKind"
          :notes="currentNotes"
          :selected-id="selectedNote?.id ?? null"
          v-model:composer="showNoteComposer"
          @select="selectNote"
          @create="createNote"
        />
      </template>
      <template v-else-if="view === 'review'">
        <ReviewBoard
          :tasks="store.completedTasks"
          :all-tasks="store.tasks"
          :notes="[...store.sparks, ...store.wraps]"
          :history="store.healthHistory"
          v-model:selected-day="selectedDay"
        />
      </template>
      <template v-else-if="view === 'health'">
        <HealthRecording />
        <details class="health-settings"><summary>提醒设置</summary><p>开始、结束都留空则记录期间按间隔提醒。填了开始钟点才等到那个点，填了结束钟点过点就不再提醒。日期可改，不影响手动记录。</p>
        <p v-if="healthSettingsError" class="record-error">{{ healthSettingsError }}</p><section class="health-grid">
          <article v-for="preset in store.health" :key="preset.kind" class="health-card">
            <div class="health-icon">{{ preset.kind === 'water' ? '◒' : '↟' }}</div>
            <div>
              <h2>{{ preset.kind === 'water' ? '喝水' : '站立' }}</h2>
              <p>{{ preset.kind === 'water' ? '补一口水，别等口渴。' : '离开椅子，活动一下。' }}</p>
            </div>
            <button class="toggle" :class="{ on: preset.enabled }" @click="togglePreset(preset.kind)"><i></i></button>
            <label>每 <select :value="preset.intervalMinutes" @change="updatePresetInterval(preset.kind, ($event.target as HTMLSelectElement).value)"><option v-for="n in [15,30,45,60,90,120]" :key="n" :value="n">{{ n }}</option></select> 分钟</label>
            <div class="time-range">提醒时段 <input type="time" :value="preset.windowStart" @change="updatePreset(preset.kind, { windowStart: ($event.target as HTMLInputElement).value })" /><button v-if="preset.windowStart" type="button" class="text-button" @click.stop="updatePreset(preset.kind, { windowStart: '' })">从开始记录</button><span v-else class="window-start-hint">从开始记录</span> 至 <input type="time" :value="preset.windowEnd" @change="updatePreset(preset.kind, { windowEnd: ($event.target as HTMLInputElement).value })" /><button v-if="preset.windowEnd" type="button" class="text-button" @click.stop="updatePreset(preset.kind, { windowEnd: '' })">不限制</button><span v-else class="window-start-hint">不限制</span></div>
            <div class="weekday-row">
              <span>提醒日期</span>
              <button v-for="(day, index) in ['一','二','三','四','五','六','日']" :key="day" :class="{ active: preset.weekdays.includes(index + 1) }" @click="toggleWeekday(preset.kind, index + 1)">{{ day }}</button>
            </div>
          </article>
        </section>
        </details>
      </template>
    </section>
    <aside class="detail-panel" :class="{ open: true }">
      <template v-if="view === 'tasks' || view === 'trash'">
        <template v-if="selected">
          <div class="detail-header">
            <p class="eyebrow">{{ view === 'trash' ? '垃圾篓' : '任务详情' }}</p>
            <p v-if="taskSaveLabel" class="save-status" :class="taskSaveStatus">{{ taskSaveLabel }}</p>
          </div>
          <textarea v-model="selected.title" class="detail-title" rows="2" @blur="flushTaskNow"></textarea>
          <label>备注<textarea v-model="selected.notes" placeholder="留下一点上下文…" rows="7" @blur="flushTaskNow"></textarea></label>
          <template v-if="view === 'tasks'">
            <label>优先级<select v-model="selected.priority" @change="flushTaskNow"><option value="none">普通</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
            <label>截止时间<input type="datetime-local" :value="localDate(selected.dueAt)" @input="selected.dueAt = asIso(($event.target as HTMLInputElement).value)" @change="flushTaskNow" /></label>
            <label>提醒时间<input type="datetime-local" :value="localDate(selected.remindAt)" @input="selected.remindAt = asIso(($event.target as HTMLInputElement).value)" @change="flushTaskNow" /></label>
          </template>
          <div class="detail-actions">
            <button v-if="view === 'tasks' && selected.status === 'open'" class="text-button" @click="discardTask(selected)">丢弃</button>
            <button v-if="view === 'tasks' && selected.status === 'completed'" class="text-button" @click="reopen(selected)">取消完成</button>
            <button v-if="view === 'trash'" class="text-button" @click="restoreTask(selected)">放回清单</button>
            <button class="text-button destructive" @click="removeTask">删除任务</button>
          </div>
        </template>
        <div v-else class="detail-empty">
          <div class="empty-hang"><i class="empty-strand"></i>
            <div v-if="view === 'trash'" class="empty-note">篓里还没有丢掉的事</div>
            <div v-else class="empty-note">蜘蛛刚巡逻完<br />这里干干净净</div>
          </div>
        </div>
      </template>
      <template v-else-if="view === 'spark' || view === 'wrap'">
        <template v-if="selectedNote">
          <div class="detail-header">
            <p class="eyebrow">{{ view === 'spark' ? '灵感详情' : '总结详情' }}</p>
            <p v-if="noteSaveLabel" class="save-status" :class="noteSaveStatus">{{ noteSaveLabel }}</p>
          </div>
          <textarea v-model="selectedNote.title" class="detail-title" rows="2" @blur="flushNoteNow"></textarea>
          <label>正文<textarea v-model="selectedNote.body" :placeholder="view === 'spark' ? '把念头写完整…' : '今天想记下的收工话…'" rows="12" @blur="flushNoteNow"></textarea></label>
          <div class="detail-actions">
            <button class="text-button destructive" @click="removeNote">删除</button>
          </div>
        </template>
        <div v-else class="detail-empty">
          <div class="empty-hang"><i class="empty-strand"></i><div class="empty-note">{{ view === 'spark' ? '念头先落在纸上' : '收工时写两句就行' }}</div></div>
        </div>
      </template>
      <DayReport
        v-else-if="view === 'review'"
        :tasks="store.completedTasks"
        :notes="[...store.sparks, ...store.wraps]"
        :history="store.healthHistory"
        :selected-day="selectedDay"
      />
      <HealthDuty v-else :presets="store.health" :session="store.healthSession" />
    </aside>
    <div v-if="pendingDelete" class="confirm-mask" @click.self="cancelRemove">
      <div class="confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirm-delete-title">
        <p class="eyebrow">确定删除</p>
        <h2 id="confirm-delete-title">删掉这件事？</h2>
        <p>「{{ pendingDelete.title }}」删了就回不来。</p>
        <div class="confirm-actions">
          <button class="text-button" @click="cancelRemove">取消</button>
          <button class="save-button" @click="confirmRemove">删除</button>
        </div>
      </div>
    </div>
  </main>
</template>
