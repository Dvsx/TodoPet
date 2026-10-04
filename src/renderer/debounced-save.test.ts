import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDebouncedSave } from './debounced-save'

describe('autosave scheduling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saves once after typing stops', () => {
    const save = vi.fn()
    const schedule = createDebouncedSave(save)
    schedule()
    vi.advanceTimersByTime(300)
    schedule()
    vi.advanceTimersByTime(449)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(save).toHaveBeenCalledTimes(1)
    vi.runAllTimers()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('saves during continuous typing at the maximum wait', () => {
    const save = vi.fn()
    const schedule = createDebouncedSave(save)
    for (let i = 0; i < 5; i++) {
      schedule()
      vi.advanceTimersByTime(400)
    }
    expect(save).toHaveBeenCalledTimes(1)
    vi.runAllTimers()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('cancels both pending timers before an immediate save or deletion and can schedule again', () => {
    const save = vi.fn()
    const schedule = createDebouncedSave(save)
    schedule.cancel()
    schedule()
    vi.advanceTimersByTime(300)
    schedule.cancel()
    vi.runAllTimers()
    expect(save).not.toHaveBeenCalled()
    schedule()
    vi.advanceTimersByTime(450)
    expect(save).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
