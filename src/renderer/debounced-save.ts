// Autosave needs explicit cancellation before completing, switching or deleting
// an item. VueUse 13's useDebounceFn returns a function without cancel().
export function createDebouncedSave(save: () => void, delay = 450, maxWait = 2000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let maxTimer: ReturnType<typeof setTimeout> | undefined

  function cancel() {
    clearTimeout(timer)
    clearTimeout(maxTimer)
    timer = undefined
    maxTimer = undefined
  }

  function run() {
    cancel()
    save()
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(run, delay)
    if (maxTimer === undefined) maxTimer = setTimeout(run, maxWait)
  }

  return Object.assign(schedule, { cancel })
}
