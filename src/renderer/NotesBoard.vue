<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Note, NoteKind } from '../shared/types'
import { groupByDay } from './day-label'

const props = defineProps<{
  kind: NoteKind
  notes: Note[]
  selectedId: string | null
  busy?: boolean
}>()
const emit = defineEmits<{
  select: [note: Note]
  create: [title: string]
}>()
const showComposer = defineModel<boolean>('composer', { required: true })

const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
const copy = computed(() => props.kind === 'spark'
  ? {
      eyebrow: 'SPARK',
      title: '灵感',
      placeholder: '记下刚冒出来的念头…',
      emptyNote: '念头先落在纸上',
      emptyLead: '这里先不当任务',
      emptyHint: '刚冒出来的念头，扔进这里就行。'
    }
  : {
      eyebrow: 'WRAP',
      title: '总结',
      placeholder: '今天收工想记下什么…',
      emptyNote: '收工时写两句就行',
      emptyLead: '不必写长，记下今天就好',
      emptyHint: '每次收工，留一句给明天的自己。'
    }
)
const grouped = computed(() => groupByDay(props.notes, (note) => note.createdAt))
const stamp = (iso: string) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

watch(showComposer, async (open) => {
  if (!open) return
  await nextTick()
  input.value?.focus()
})

function submit() {
  if (!draft.value.trim()) return
  emit('create', draft.value.trim())
  draft.value = ''
  showComposer.value = false
}
</script>

<template>
  <header class="content-header">
    <div>
      <p class="eyebrow">{{ copy.eyebrow }}</p>
      <h1>{{ copy.title }}</h1>
    </div>
    <button class="soft-button" @click="showComposer = true">＋ 添加</button>
  </header>
  <div v-if="showComposer" class="quick-compose">
    <input ref="input" v-model="draft" :placeholder="copy.placeholder" @keyup.enter="submit" />
    <button @click="submit">添加</button>
    <button class="text-button" @click="showComposer = false">取消</button>
  </div>
  <div v-if="busy" class="empty">正在整理…</div>
  <div v-else-if="!notes.length" class="empty">
    <div class="empty-hang"><i class="empty-strand"></i><div class="empty-note">{{ copy.emptyNote }}</div></div>
    <h2>{{ copy.emptyLead }}</h2>
    <p>{{ copy.emptyHint }}</p>
  </div>
  <div v-else class="task-list">
    <template v-if="kind === 'wrap'">
      <section v-for="group in grouped" :key="group.key" class="task-day">
        <h2 class="task-day-label">{{ group.label }}</h2>
        <article
          v-for="note in group.items"
          :key="note.id"
          class="note-card"
          :class="{ selected: selectedId === note.id }"
          @click="emit('select', note)"
        >
          <strong>{{ note.title }}</strong>
          <span v-if="note.body">{{ note.body }}</span>
          <div class="task-meta"><small>{{ stamp(note.createdAt) }}</small></div>
        </article>
      </section>
    </template>
    <article
      v-else
      v-for="note in notes"
      :key="note.id"
      class="note-card"
      :class="{ selected: selectedId === note.id }"
      @click="emit('select', note)"
    >
      <strong>{{ note.title }}</strong>
      <span v-if="note.body">{{ note.body }}</span>
      <div class="task-meta"><small>{{ stamp(note.createdAt) }}</small></div>
    </article>
  </div>
</template>
