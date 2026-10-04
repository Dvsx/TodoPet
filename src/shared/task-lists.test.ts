import { describe, expect, it } from 'vitest'
import { applyTaskToLists } from './task-lists.js'
import type { Task } from './types.js'

const task = (over: Partial<Task> & Pick<Task, 'id' | 'title' | 'status'>): Task => ({
  notes: '', priority: 'none', dueAt: null, remindAt: null, revision: 1,
  createdAt: '2026-09-07T01:00:00.000Z', updatedAt: '2026-09-07T01:00:00.000Z', completedAt: null,
  ...over
})

describe('applyTaskToLists', () => {
  it('marks a task completed without dropping it from the main list', () => {
    const open = task({ id: 'a', title: '巡逻', status: 'open' })
    const done = { ...open, status: 'completed' as const, completedAt: '2026-09-07T02:00:00.000Z' }
    const next = applyTaskToLists([open], [], [], done)
    expect(next.tasks).toEqual([done])
    expect(next.completedTasks).toEqual([done])
    expect(next.archivedTasks).toEqual([])
  })

  it('reopening pulls the task out of completed', () => {
    const done = task({ id: 'a', title: '巡逻', status: 'completed', completedAt: '2026-09-07T02:00:00.000Z' })
    const open = { ...done, status: 'open' as const, completedAt: null }
    const next = applyTaskToLists([done], [done], [], open)
    expect(next.tasks).toEqual([open])
    expect(next.completedTasks).toEqual([])
    expect(next.archivedTasks).toEqual([])
  })

  it('moves an archived task into the third list', () => {
    const open = task({ id: 'a', title: '巡逻', status: 'open' })
    const archived = { ...open, status: 'archived' as const }
    const next = applyTaskToLists([open], [open], [], archived)
    expect(next.tasks).toEqual([])
    expect(next.completedTasks).toEqual([])
    expect(next.archivedTasks).toEqual([archived])
  })

  it('restores an archived task back to the open list', () => {
    const archived = task({ id: 'a', title: '巡逻', status: 'archived' })
    const open = { ...archived, status: 'open' as const }
    const next = applyTaskToLists([], [], [archived], open)
    expect(next.tasks).toEqual([open])
    expect(next.completedTasks).toEqual([])
    expect(next.archivedTasks).toEqual([])
  })
})
