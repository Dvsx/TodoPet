import { describe, expect, it } from 'vitest'
import { coversWorkArea } from './window-state'

const work = { x: 0, y: 0, width: 1920, height: 1040 }

describe('coversWorkArea', () => {
  it('treats a work-area-filling window as maximized', () => {
    expect(coversWorkArea({ x: 0, y: 0, width: 1920, height: 1040 }, work)).toBe(true)
  })
  it('treats a slightly overflowing Windows maximize frame as maximized', () => {
    expect(coversWorkArea({ x: -8, y: -8, width: 1936, height: 1056 }, work)).toBe(true)
  })
  it('does not treat the default window as maximized', () => {
    expect(coversWorkArea({ x: 200, y: 120, width: 1160, height: 760 }, work)).toBe(false)
  })
})
