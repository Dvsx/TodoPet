import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceActivity, type DeviceActivityActions } from './device-activity'

function setup() {
  const actions: DeviceActivityActions = {
    pauseDelivery: vi.fn(), clearPresentation: vi.fn(), pauseRecording: vi.fn(),
    recordLock: vi.fn(), resumeRecording: vi.fn(), displayChanged: vi.fn()
  }
  return { actions, device: new DeviceActivity(actions) }
}

afterEach(() => vi.useRealTimers())

describe('device activity delivery boundary', () => {
  it('consumes wake input observed before the display-on notification arrives', () => {
    vi.useFakeTimers()
    const { actions, device } = setup()
    device.display('off')
    device.input()
    expect(actions.resumeRecording).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    device.display('on')
    expect(actions.resumeRecording).toHaveBeenCalledExactlyOnceWith(false)
    expect(actions.pauseDelivery).toHaveBeenLastCalledWith(false)
    device.display('on')
    expect(actions.resumeRecording).toHaveBeenCalledOnce()
  })

  it('keeps an unlock that precedes display-on as real return input', () => {
    const { actions, device } = setup()
    device.lock()
    device.display('off')
    device.unlock()
    expect(actions.resumeRecording).not.toHaveBeenCalled()
    device.display('on')
    expect(actions.resumeRecording).toHaveBeenCalledExactlyOnceWith(true)
    expect(actions.pauseDelivery).toHaveBeenLastCalledWith(false)
  })

  it('does not replay old display-off input when a later screen-on has no recent user activity', () => {
    vi.useFakeTimers()
    const { actions, device } = setup()
    device.display('off')
    device.input()
    vi.advanceTimersByTime(5001)
    device.display('on')
    expect(actions.resumeRecording).not.toHaveBeenCalled()
    expect(actions.pauseDelivery).toHaveBeenCalledExactlyOnceWith(true)
    device.input()
    expect(actions.pauseDelivery).toHaveBeenLastCalledWith(false)
  })

  it('a new suspend discards previous display wake input and ignores input while suspended', () => {
    const { actions, device } = setup()
    device.display('off')
    device.input()
    device.suspend()
    device.input()
    device.resume()
    device.display('on')
    expect(actions.resumeRecording).not.toHaveBeenCalled()
    device.input()
    expect(actions.pauseDelivery).toHaveBeenLastCalledWith(false)
  })

  it('ignores input while locked and requires the subsequent unlock', () => {
    const { actions, device } = setup()
    device.display('off')
    device.input()
    device.lock()
    device.input()
    device.display('on')
    expect(actions.resumeRecording).not.toHaveBeenCalled()
    device.unlock()
    expect(actions.resumeRecording).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('screen off pauses recording and reminders even without a suspend event', () => {
    const { actions, device } = setup()
    device.display('off')
    device.input()
    expect(actions.pauseDelivery).toHaveBeenCalledExactlyOnceWith(true)
    expect(actions.pauseRecording).toHaveBeenCalledOnce()
    expect(actions.clearPresentation).toHaveBeenCalledOnce()
    expect(actions.resumeRecording).not.toHaveBeenCalled()
  })

  it('screen on waits for input before starting a fresh reminder interval', () => {
    const { actions, device } = setup()
    device.display('off'); device.display('on')
    expect(actions.pauseDelivery).toHaveBeenCalledExactlyOnceWith(true)
    device.input()
    expect(actions.resumeRecording).toHaveBeenLastCalledWith(false)
    expect(actions.pauseDelivery).toHaveBeenLastCalledWith(false)
    device.input()
    expect(actions.pauseDelivery).toHaveBeenCalledTimes(2)
  })

  it('lock keeps the posture rule while blocking both water and stand reminders', () => {
    const { actions, device } = setup()
    device.lock(); device.lock(); device.input()
    expect(actions.recordLock).toHaveBeenCalledOnce()
    expect(actions.pauseRecording).not.toHaveBeenCalled()
    expect(actions.resumeRecording).not.toHaveBeenCalled()
    device.unlock()
    expect(actions.resumeRecording).toHaveBeenLastCalledWith(true)
    expect(actions.pauseDelivery).toHaveBeenLastCalledWith(false)
  })

  it('unlock or input cannot override an independent screen-off/suspend state', () => {
    const { actions, device } = setup()
    device.lock(); device.display('off'); device.suspend()
    device.unlock(); device.display('on'); device.input()
    expect(actions.resumeRecording).not.toHaveBeenCalled()
    device.resume()
    expect(actions.resumeRecording).not.toHaveBeenCalled()
    device.input()
    expect(actions.resumeRecording).toHaveBeenLastCalledWith(true)
    expect(actions.pauseDelivery).toHaveBeenLastCalledWith(false)
  })

  it('deduplicates display notifications and does not treat dim as off', () => {
    const { actions, device } = setup()
    device.display('on'); device.display('dim')
    expect(actions.pauseRecording).not.toHaveBeenCalled()
    device.display('off'); device.display('off')
    expect(actions.pauseRecording).toHaveBeenCalledOnce()
    device.display('dim'); device.input()
    expect(actions.pauseDelivery).toHaveBeenLastCalledWith(false)
  })
})
