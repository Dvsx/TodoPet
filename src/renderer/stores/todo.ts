import { defineStore } from 'pinia'
import { applyTaskToLists } from '../../shared/task-lists'
import type { HealthPreset, HealthSession, Note, NoteInput, NoteKind, ReminderOccurrence, Task, TaskInput } from '../../shared/types'

export const useTodoStore = defineStore('todo', {
  state: () => ({
    tasks: [] as Task[],
    completedTasks: [] as Task[],
    archivedTasks: [] as Task[],
    sparks: [] as Note[],
    wraps: [] as Note[],
    health: [] as HealthPreset[],
    healthSession: { active: false, startedAt: null } as HealthSession,
    healthHistory: [] as ReminderOccurrence[],
    busy: false,
    listEpoch: 0,
    completedEpoch: 0,
    archivedEpoch: 0
  }),
  actions: {
    applyTask(task: Task) {
      this.listEpoch += 1
      this.completedEpoch += 1
      this.archivedEpoch += 1
      const next = applyTaskToLists(this.tasks, this.completedTasks, this.archivedTasks, task)
      this.tasks = next.tasks
      this.completedTasks = next.completedTasks
      this.archivedTasks = next.archivedTasks
    },
    async load(view: 'today' | 'upcoming' | 'completed' | 'all' = 'all') {
      this.busy = true
      try {
        const epoch = this.listEpoch + 1
        this.listEpoch = epoch
        const [tasks, health, session] = await Promise.all([
          window.todoPet.tasks.list(view),
          window.todoPet.health.list(),
          window.todoPet.health.session()
        ])
        if (epoch !== this.listEpoch) return
        this.tasks = tasks
        this.health = health
        this.healthSession = session
      } finally {
        this.busy = false
      }
    },
    async refresh() {
      const epoch = this.listEpoch + 1
      this.listEpoch = epoch
      const tasks = await window.todoPet.tasks.list('all')
      if (epoch !== this.listEpoch) return
      this.tasks = tasks
    },
    async loadCompleted() {
      const epoch = this.completedEpoch + 1
      this.completedEpoch = epoch
      const completed = await window.todoPet.tasks.list('completed')
      if (epoch !== this.completedEpoch) return
      this.completedTasks = completed
    },
    async loadArchived() {
      const epoch = this.archivedEpoch + 1
      this.archivedEpoch = epoch
      const archived = await window.todoPet.tasks.list('archived')
      if (epoch !== this.archivedEpoch) return
      this.archivedTasks = archived
    },
    async loadHealthHistory() { this.healthHistory = await window.todoPet.health.history() },
    async loadStats() {
      const listEpoch = this.listEpoch + 1
      const completedEpoch = this.completedEpoch + 1
      this.listEpoch = listEpoch
      this.completedEpoch = completedEpoch
      const [tasks, completed, sparks, wraps, health, session, history] = await Promise.all([
        window.todoPet.tasks.list('all'),
        window.todoPet.tasks.list('completed'),
        window.todoPet.notes.list('spark'),
        window.todoPet.notes.list('wrap'),
        window.todoPet.health.list(),
        window.todoPet.health.session(),
        window.todoPet.health.history()
      ])
      if (listEpoch === this.listEpoch) this.tasks = tasks
      if (completedEpoch === this.completedEpoch) this.completedTasks = completed
      this.sparks = sparks
      this.wraps = wraps
      this.health = health
      this.healthSession = session
      this.healthHistory = history
    },
    async create(input: TaskInput) { const task = await window.todoPet.tasks.create(input); await this.load(); return task },
    async patch(id: string, input: Partial<TaskInput>) {
      const task = await window.todoPet.tasks.update(id, input)
      this.applyTask(task)
      return task
    },
    async update(id: string, input: Partial<TaskInput>) { await this.patch(id, input) },
    async complete(id: string) {
      const task = await window.todoPet.tasks.complete(id)
      this.applyTask(task)
    },
    async reopen(id: string) {
      const task = await window.todoPet.tasks.reopen(id)
      this.applyTask(task)
    },
    async archive(id: string) {
      const task = await window.todoPet.tasks.archive(id)
      this.applyTask(task)
    },
    async restore(id: string) {
      const task = await window.todoPet.tasks.restore(id)
      this.applyTask(task)
    },
    async remove(id: string) {
      await window.todoPet.tasks.remove(id)
      this.listEpoch += 1
      this.completedEpoch += 1
      this.archivedEpoch += 1
      this.tasks = this.tasks.filter((item) => item.id !== id)
      this.completedTasks = this.completedTasks.filter((item) => item.id !== id)
      this.archivedTasks = this.archivedTasks.filter((item) => item.id !== id)
    },
    async loadNotes(kind: NoteKind) {
      const notes = await window.todoPet.notes.list(kind)
      if (kind === 'spark') this.sparks = notes
      else this.wraps = notes
    },
    async createNote(kind: NoteKind, input: NoteInput) {
      const note = await window.todoPet.notes.create(kind, input)
      await this.loadNotes(kind)
      return note
    },
    async patchNote(id: string, input: Partial<NoteInput>) {
      const note = await window.todoPet.notes.update(id, input)
      const list = note.kind === 'spark' ? this.sparks : this.wraps
      const idx = list.findIndex((item) => item.id === id)
      if (idx >= 0) list[idx] = note
      return note
    },
    async updateNote(id: string, input: Partial<NoteInput>) {
      const note = await this.patchNote(id, input)
      await this.loadNotes(note.kind)
      return note
    },
    async removeNote(id: string, kind: NoteKind) {
      await window.todoPet.notes.remove(id)
      await this.loadNotes(kind)
    },
    applyHealthSession(session: HealthSession) { this.healthSession = session },
    async loadHealth() {
      const [health, session] = await Promise.all([
        window.todoPet.health.list(),
        window.todoPet.health.session()
      ])
      this.health = health
      this.healthSession = session
    },
    async updateHealth(preset: HealthPreset) {
      await window.todoPet.health.update(JSON.parse(JSON.stringify(preset)))
      this.health = await window.todoPet.health.list()
    },
    async startHealthDuty() {
      this.healthSession = await window.todoPet.health.start()
      this.health = await window.todoPet.health.list()
    },
    async stopHealthDuty() {
      this.healthSession = await window.todoPet.health.stop()
      this.health = await window.todoPet.health.list()
    }
  }
})
