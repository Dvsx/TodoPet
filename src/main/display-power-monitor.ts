import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { app } from 'electron'

export type DisplayPowerState = 'off' | 'on' | 'dim'

/** Only the helper's explicit, complete state messages can change reminder state. */
export function parseDisplayPowerState(line: string): DisplayPowerState | null {
  const match = /^display-power:(off|on|dim)$/.exec(line.trim())
  return match ? match[1] as DisplayPowerState : null
}

/** Electron has no display-power event: listen to the interactive Windows session. */
export function startDisplayPowerMonitor(onState: (state: DisplayPowerState) => void): () => void {
  if (process.platform !== 'win32') return () => {}

  const scriptPath = app.isPackaged
    ? join(process.resourcesPath, 'windows', 'display-power-monitor.ps1')
    : join(app.getAppPath(), 'resources', 'windows', 'display-power-monitor.ps1')
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  let disposed = false
  let child: ChildProcess | null = null
  let lines: Interface | null = null
  let retry: ReturnType<typeof setTimeout> | null = null

  const warn = (message: string): void => console.warn(`[display-power] ${message}`)

  const launch = (): void => {
    if (disposed) return
    let launched: ChildProcess
    try {
      launched = spawn(powershell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
        '-File', scriptPath, '-ParentProcessId', String(process.pid)
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      warn(`Could not start monitor: ${String(error)}`)
      scheduleRetry()
      return
    }
    child = launched
    let stderr = ''
    if (launched.stdout) {
      lines = createInterface({ input: launched.stdout })
      lines.on('line', (line: string) => {
        if (disposed || child !== launched) return
        const state = parseDisplayPowerState(line)
        if (state) onState(state)
      })
    }
    launched.stderr?.on('data', (chunk: Buffer) => {
      // Keep diagnostics bounded; PowerShell may print long compiler error records.
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    launched.once('error', (error) => {
      if (!disposed) warn(`Monitor failed: ${error.message}`)
    })
    launched.once('close', (code, signal) => {
      if (child !== launched) return
      lines?.close()
      lines = null
      child = null
      if (!disposed) {
        warn(`Monitor stopped (${code ?? signal ?? 'unknown'}). ${stderr.trim()}`)
        // Re-register after a helper failure; never invent a display-on event.
        scheduleRetry()
      }
    })
  }

  const scheduleRetry = (): void => {
    if (disposed || retry) return
    retry = setTimeout(() => {
      retry = null
      launch()
    }, 30_000)
    retry.unref()
  }

  launch()
  return () => {
    if (disposed) return
    disposed = true
    if (retry) clearTimeout(retry)
    retry = null
    lines?.close()
    lines = null
    child?.kill()
    child = null
  }
}
