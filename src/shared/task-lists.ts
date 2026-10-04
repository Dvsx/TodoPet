import type { Task } from './types.js'

export function applyTaskToLists(
  tasks: Task[],
  completedTasks: Task[],
  archivedTasks: Task[],
  task: Task
): { tasks: Task[]; completedTasks: Task[]; archivedTasks: Task[] } {
  const drop = (list: Task[]) => list.filter((item) => item.id !== task.id)
  const upsert = (list: Task[]) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id === task.id)
    if (idx >= 0) next[idx] = task
    else next.push(task)
    return next
  }
  if (task.status === 'archived') {
    return {
      tasks: drop(tasks),
      completedTasks: drop(completedTasks),
      archivedTasks: upsert(archivedTasks)
    }
  }
  return {
    tasks: upsert(tasks),
    completedTasks: task.status === 'completed'
      ? upsert(completedTasks)
      : drop(completedTasks),
    archivedTasks: drop(archivedTasks)
  }
}
