import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  app: { isPackaged: false, getAppPath: () => 'C:\\TodoPet Dev' }
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: mocks.app }))

import { parseDisplayPowerState, startDisplayPowerMonitor } from './display-power-monitor.js'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
let dispose: (() => void) | undefined

function makeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: 'C:\\TodoPet Packaged' })
  mocks.app.isPackaged = false
  mocks.spawn.mockReset()
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  Object.defineProperty(process, 'platform', platformDescriptor)
  if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
  else Reflect.deleteProperty(process, 'resourcesPath')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('display power monitor', () => {
  it('accepts only explicit complete state messages', () => {
    expect(parseDisplayPowerState('display-power:off')).toBe('off')
    expect(parseDisplayPowerState('display-power:on\r')).toBe('on')
    expect(parseDisplayPowerState('display-power:dim')).toBe('dim')
    for (const line of ['on', 'display-power:', 'display-power:unknown', 'warning display-power:on', 'display-power:on trailing']) {
      expect(parseDisplayPowerState(line)).toBeNull()
    }
  })

  it('frames split and batched stdout without guessing the initial state', () => {
    const child = makeChild()
    mocks.spawn.mockReturnValue(child)
    const onState = vi.fn()
    dispose = startDisplayPowerMonitor(onState)
    expect(onState).not.toHaveBeenCalled()
    child.stdout.write('display-pow')
    expect(onState).not.toHaveBeenCalled()
    child.stdout.write('er:off\r\ndisplay-power:dim\ndisplay-power:on\n')
    expect(onState.mock.calls).toEqual([['off'], ['dim'], ['on']])
  })

  it('launches a hidden helper with literal development path and parent PID', () => {
    mocks.spawn.mockReturnValue(makeChild())
    dispose = startDisplayPowerMonitor(vi.fn())
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringContaining('powershell.exe'),
      expect.arrayContaining(['-File', join(mocks.app.getAppPath(), 'resources', 'windows', 'display-power-monitor.ps1'), '-ParentProcessId', String(process.pid)]),
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  })

  it('uses the unpacked resource location in packaged applications', () => {
    mocks.app.isPackaged = true
    mocks.spawn.mockReturnValue(makeChild())
    dispose = startDisplayPowerMonitor(vi.fn())
    expect(mocks.spawn.mock.calls[0][1]).toContain(join(process.resourcesPath, 'windows', 'display-power-monitor.ps1'))
  })

  it('restarts failed helpers without resuming reminders on its own', () => {
    const first = makeChild()
    const second = makeChild()
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const onState = vi.fn()
    dispose = startDisplayPowerMonitor(onState)
    first.stdout.write('display-power:off\n')
    first.emit('error', new Error('helper unavailable'))
    first.emit('close', 1, null)
    expect(onState.mock.calls).toEqual([['off']])
    vi.advanceTimersByTime(30_000)
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(onState.mock.calls).toEqual([['off']])
    second.stdout.write('display-power:on\n')
    expect(onState.mock.calls).toEqual([['off'], ['on']])
  })

  it('stops the helper once and ignores late messages after disposal', () => {
    const child = makeChild()
    mocks.spawn.mockReturnValue(child)
    const onState = vi.fn()
    dispose = startDisplayPowerMonitor(onState)
    dispose()
    dispose()
    child.stdout.write('display-power:on\n')
    child.emit('close', 0, null)
    vi.advanceTimersByTime(60_000)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(onState).not.toHaveBeenCalled()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('cancels pending retries when the application exits', () => {
    mocks.spawn.mockImplementation(() => { throw new Error('spawn unavailable') })
    dispose = startDisplayPowerMonitor(vi.fn())
    dispose()
    vi.advanceTimersByTime(60_000)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('does not launch a Windows helper on other platforms', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    dispose = startDisplayPowerMonitor(vi.fn())
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
