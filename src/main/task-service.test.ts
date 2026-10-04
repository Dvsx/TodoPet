import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))

import { closeDatabase, getSqlite } from './database.js'
import { TaskService } from './task-service.js'

const roots: string[] = []
const tempRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'todopet-tasks-')); roots.push(dir); return dir }

afterEach(() => {
  closeDatabase()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('TaskService.list', () => {
  it("treats 'all' as every non-archived task, completed ones included", () => {
    state.root = tempRoot()
    const service = new TaskService()
    const open = service.create({ title: '进行中' })
    const done = service.create({ title: '已完成' }); service.complete(done.id)
    const archived = service.create({ title: '已归档' }); service.archive(archived.id)
    const allIds = service.list('all').map((task) => task.id)
    expect(allIds).toContain(open.id)
    expect(allIds).toContain(done.id)
    expect(allIds).not.toContain(archived.id)
    expect(service.list('all').map((task) => task.status)).toEqual(['open', 'completed'])
    expect(service.list('today').map((task) => task.id)).toEqual([open.id])
  })

  it('stamps completedAt when a task is completed', () => {
    state.root = tempRoot()
    const service = new TaskService()
    const open = service.create({ title: '进行中' })
    const done = service.create({ title: '已完成' })
    expect(service.get(done.id)?.completedAt).toBeNull()
    const completed = service.complete(done.id)
    expect(completed.completedAt).toBeTruthy()
    expect(new Date(completed.completedAt!).getTime()).toBeGreaterThanOrEqual(new Date(done.createdAt).getTime())
    expect(service.get(open.id)?.completedAt).toBeNull()
  })

  it('reopens a completed task and clears completedAt', () => {
    state.root = tempRoot()
    const service = new TaskService()
    const task = service.create({ title: '误点完成' })
    service.complete(task.id)
    const reopened = service.reopen(task.id)
    expect(reopened.status).toBe('open')
    expect(reopened.completedAt).toBeNull()
    expect(service.list('completed')).toHaveLength(0)
    expect(service.reopen(reopened.id).status).toBe('open')
  })

  it("puts a tomorrow due date into upcoming, not today", () => {
    state.root = tempRoot()
    const service = new TaskService()
    const due = new Date()
    due.setDate(due.getDate() + 1)
    due.setHours(9, 0, 0, 0)
    const planned = service.create({ title: '明天计划', dueAt: due.toISOString() })
    const undated = service.create({ title: '未定期' })
    expect(service.list('upcoming').map((task) => task.id)).toEqual([planned.id])
    expect(service.list('today').map((task) => task.id)).toEqual([undated.id])
  })

  it('archives an open task without counting it as completed', () => {
    state.root = tempRoot()
    const service = new TaskService()
    const keep = service.create({ title: '留下' })
    const discarded = service.create({ title: '不做了' })
    const archived = service.archive(discarded.id)
    expect(archived.status).toBe('archived')
    expect(service.list('all').map((task) => task.id)).toEqual([keep.id])
    expect(service.list('completed').map((task) => task.id)).not.toContain(discarded.id)
    expect(() => service.archive('00000000-0000-4000-8000-000000000000')).toThrow('任务不存在')
  })

  it("lists only archived tasks and restores them to open", () => {
    state.root = tempRoot()
    const service = new TaskService()
    const keep = service.create({ title: '留下' })
    const discarded = service.create({ title: '不做了' })
    service.complete(discarded.id)
    service.archive(discarded.id)
    const archivedOnly = service.list('archived')
    expect(archivedOnly.map((task) => task.id)).toEqual([discarded.id])
    expect(archivedOnly[0]?.status).toBe('archived')
    expect(service.list('all').map((task) => task.id)).toEqual([keep.id])
    const restored = service.restore(discarded.id)
    expect(restored.status).toBe('open')
    expect(restored.completedAt).toBeNull()
    expect(service.list('all').map((task) => task.id)).toEqual([discarded.id, keep.id])
    expect(service.list('archived')).toHaveLength(0)
    expect(service.restore(keep.id).status).toBe('open')
  })

  it('permanently removes a task and its reminder rows', () => {
    state.root = tempRoot()
    const service = new TaskService()
    const keep = service.create({ title: '留下' })
    const gone = service.create({ title: '删掉' })
    getSqlite().prepare('INSERT INTO reminder_occurrences VALUES (?,?,?,?,?,?,?,?,?)').run(
      '11111111-1111-4111-8111-111111111111', 'task', gone.id, new Date().toISOString(), 'pending', null, null, null, gone.title
    )
    expect(service.remove(gone.id).id).toBe(gone.id)
    expect(service.get(gone.id)).toBeNull()
    expect(service.list('all').map((task) => task.id)).toEqual([keep.id])
    const leftover = getSqlite().prepare('SELECT count(*) AS c FROM reminder_occurrences WHERE source_id=?').get(gone.id) as { c: number }
    expect(leftover.c).toBe(0)
    expect(() => service.remove(gone.id)).toThrow('任务不存在')
  })
})
