import { randomUUID } from 'node:crypto'
import { getSqlite } from './database.js'
import type { Task, TaskInput, TaskPriority, TaskStatus } from '../shared/types.js'

type TaskRow = {
  id: string; title: string; notes: string; status: TaskStatus; priority: TaskPriority
  due_at: string | null; remind_at: string | null
  revision: number; created_at: string; updated_at: string; completed_at: string | null
}

const toTask = (row: TaskRow): Task => ({
  id: row.id, title: row.title, notes: row.notes, status: row.status, priority: row.priority,
  dueAt: row.due_at, remindAt: row.remind_at,
  revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  completedAt: row.completed_at ?? null
})

export class TaskService {
  private listeners = new Set<(task: Task) => void>()

  onChanged(listener: (task: Task) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(task: Task): void {
    for (const listener of this.listeners) listener(task)
  }

  list(view: 'today' | 'upcoming' | 'completed' | 'all' | 'archived' = 'today'): Task[] {
    const db = getSqlite()
    if (view === 'archived') {
      return (db.prepare("SELECT * FROM tasks WHERE status = 'archived' ORDER BY updated_at DESC").all() as TaskRow[]).map(toTask)
    }
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1)
    let sql = "SELECT * FROM tasks WHERE status != 'archived'"
    const values: string[] = []
    if (view === 'completed') sql += " AND status = 'completed'"
    if (view === 'today') { sql += " AND status = 'open' AND (due_at IS NULL OR due_at < ?)"; values.push(tomorrow.toISOString()) }
    if (view === 'upcoming') { sql += " AND status = 'open' AND due_at >= ?"; values.push(tomorrow.toISOString()) }
    sql += " ORDER BY CASE status WHEN 'completed' THEN 1 ELSE 0 END, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, due_at IS NULL, due_at, created_at DESC"
    return (db.prepare(sql).all(...values) as TaskRow[]).map(toTask)
  }

  get(id: string): Task | null {
    const row = getSqlite().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? toTask(row) : null
  }

  create(input: TaskInput): Task {
    const now = new Date().toISOString(); const id = randomUUID()
    getSqlite().prepare(`INSERT INTO tasks (id,title,notes,status,priority,due_at,remind_at,revision,sync_state,created_at,updated_at)
      VALUES (@id,@title,@notes,'open',@priority,@dueAt,@remindAt,1,'none',@now,@now)`).run({
      id, title: input.title.trim(), notes: input.notes?.trim() ?? '', priority: input.priority ?? 'none',
      dueAt: input.dueAt ?? null, remindAt: input.remindAt ?? null, now
    })
    const task = this.get(id)!; this.emit(task); return task
  }

  update(id: string, input: Partial<TaskInput>): Task {
    const existing = this.get(id); if (!existing) throw new Error('任务不存在')
    const now = new Date().toISOString()
    getSqlite().prepare(`UPDATE tasks SET title=?, notes=?, priority=?, due_at=?, remind_at=?, revision=revision+1, updated_at=? WHERE id=?`).run(
      input.title === undefined ? existing.title : input.title.trim(),
      input.notes === undefined ? existing.notes : input.notes.trim(),
      input.priority ?? existing.priority,
      input.dueAt === undefined ? existing.dueAt : input.dueAt,
      input.remindAt === undefined ? existing.remindAt : input.remindAt,
      now, id
    )
    const task = this.get(id)!; this.emit(task); return task
  }

  complete(id: string): Task {
    const now = new Date().toISOString()
    getSqlite().prepare("UPDATE tasks SET status='completed', revision=revision+1, updated_at=?, completed_at=? WHERE id=?").run(now, now, id)
    const task = this.get(id); if (!task) throw new Error('任务不存在'); this.emit(task); return task
  }

  reopen(id: string): Task {
    const existing = this.get(id); if (!existing) throw new Error('任务不存在')
    if (existing.status !== 'completed') return existing
    const now = new Date().toISOString()
    getSqlite().prepare("UPDATE tasks SET status='open', revision=revision+1, updated_at=?, completed_at=NULL WHERE id=?").run(now, id)
    const task = this.get(id)!; this.emit(task); return task
  }

  archive(id: string): Task {
    const existing = this.get(id); if (!existing) throw new Error('任务不存在')
    const now = new Date().toISOString()
    getSqlite().prepare("UPDATE tasks SET status='archived', revision=revision+1, updated_at=? WHERE id=?").run(now, id)
    const task = this.get(id)!; this.emit(task); return task
  }

  restore(id: string): Task {
    const existing = this.get(id); if (!existing) throw new Error('任务不存在')
    if (existing.status !== 'archived') return existing
    const now = new Date().toISOString()
    getSqlite().prepare("UPDATE tasks SET status='open', revision=revision+1, updated_at=?, completed_at=NULL WHERE id=?").run(now, id)
    const task = this.get(id)!; this.emit(task); return task
  }

  remove(id: string): Task {
    const existing = this.get(id)
    if (!existing) throw new Error('任务不存在')
    const db = getSqlite()
    db.prepare("DELETE FROM reminder_occurrences WHERE source_type='task' AND source_id=?").run(id)
    db.prepare('DELETE FROM sync_records WHERE task_id=?').run(id)
    db.prepare('DELETE FROM tasks WHERE id=?').run(id)
    this.emit(existing)
    return existing
  }
}
