import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../../shared/types'
import { useTodoStore } from './todo'

const openTask: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '巡逻',
  notes: '',
  status: 'open',
  priority: 'none',
  dueAt: null,
  remindAt: null,
  revision: 1,
  createdAt: '2026-09-07T01:00:00.000Z',
  updatedAt: '2026-09-07T01:00:00.000Z',
  completedAt: null
}

describe('todo store complete', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps a completed task even if a stale list refresh returns later', async () => {
    const live = [{ ...openTask }]
    let releaseStale!: (tasks: Task[]) => void
    const staleSnapshot = [{ ...openTask }]
    ;(globalThis as unknown as { window: unknown }).window = {
      todoPet: {
        tasks: {
          list: vi.fn(() => new Promise<Task[]>((resolve) => { releaseStale = resolve })),
          complete: vi.fn(async () => {
            live[0] = { ...live[0], status: 'completed', completedAt: '2026-09-07T02:00:00.000Z', revision: 2 }
            return live[0]
          })
        }
      }
    }

    const store = useTodoStore()
    store.tasks = [{ ...openTask }]
    const refresh = store.refresh()
    await store.complete(openTask.id)
    expect(store.tasks[0]?.status).toBe('completed')
    releaseStale(staleSnapshot)
    await refresh
    expect(store.tasks[0]?.status).toBe('completed')
    expect(store.completedTasks[0]?.id).toBe(openTask.id)
  })

  it('drops an archived task from both lists', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      todoPet: {
        tasks: {
          archive: vi.fn(async () => ({ ...openTask, status: 'archived' as const, revision: 2 }))
        }
      }
    }

    const store = useTodoStore()
    store.tasks = [{ ...openTask }]
    store.completedTasks = [{ ...openTask, status: 'completed', completedAt: '2026-09-07T02:00:00.000Z' }]
    await store.archive(openTask.id)
    expect(store.tasks).toEqual([])
    expect(store.completedTasks).toEqual([])
    expect(store.archivedTasks).toEqual([{ ...openTask, status: 'archived', revision: 2 }])
  })

  it('puts a restored task back on the open list', async () => {
    const archived = { ...openTask, status: 'archived' as const, revision: 2 }
    ;(globalThis as unknown as { window: unknown }).window = {
      todoPet: {
        tasks: {
          restore: vi.fn(async () => ({ ...archived, status: 'open' as const, revision: 3, completedAt: null }))
        }
      }
    }

    const store = useTodoStore()
    store.archivedTasks = [archived]
    await store.restore(openTask.id)
    expect(store.archivedTasks).toEqual([])
    expect(store.tasks[0]?.id).toBe(openTask.id)
    expect(store.tasks[0]?.status).toBe('open')
  })
})
