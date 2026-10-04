// Isolated Windows acceptance: simulated power events + real OS mouse input.
// Run after build: node scripts/verify-pet-wake.cjs [--exe=path/to/TodoPet.exe] [--real-wake]
// This never locks/suspends Windows. --real-wake waits for the user to do so.
const { _electron: electron } = require('playwright')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')

const root = resolve(__dirname, '..')
mkdirSync(join(root, '.pet-run'), { recursive: true })
const run = mkdtempSync(join(root, '.pet-run/wake-regression-'))
const profile = join(run, 'profile')
mkdirSync(profile)
const executablePath = process.argv.find(value => value.startsWith('--exe='))?.slice(6)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const sleep = ms => new Promise(done => setTimeout(done, ms))
const evidence = { startedAt: new Date().toISOString(), executablePath: executablePath ? resolve(executablePath) : null, profile, powerEventsAreSimulated: true, nativeMouse: true, samples: [], rendererEvents: [], errors: [] }
let client
let main

function record(sample) {
  const entry = { at: new Date().toISOString(), ...sample }
  evidence.samples.push(entry)
  console.log(JSON.stringify(entry))
  return entry
}

async function nativeState() {
  return client.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && win.webContents.getURL().includes('view=pet')).sort((a, b) => b.id - a.id)[0]
    if (!window) return null
    const bounds = window.getBounds()
    return { id: window.id, hwnd: window.getNativeWindowHandle().toString('hex'), bounds, visible: window.isVisible(), crashed: window.webContents.isCrashed(), workArea: screen.getDisplayMatching(bounds).workArea }
  })
}

async function currentPet({ replacedId, visible = true } = {}) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const state = await nativeState()
    if (state && (replacedId == null || state.id !== replacedId) && (!visible || state.visible)) {
      for (const page of client.windows().filter(page => !page.isClosed() && page.url().includes('view=pet'))) {
        try {
          const window = await client.browserWindow(page)
          const id = await window.evaluate(win => win.id)
          await window.dispose()
          if (id !== state.id) continue
          await page.waitForSelector('.pet-sprite', { state: 'attached', timeout: 4000 })
          await page.waitForFunction(() => {
            const image = document.querySelector('.pet-cutout')
            return image?.complete && image.naturalWidth > 0 && Boolean(window.todoPet)
          }, null, { timeout: 4000 })
          await page.evaluate(() => {
            if (window.__wakeProbe) return
            window.__wakeProbe = []
            const note = event => {
              const entry = { at: new Date().toISOString(), ...event }
              window.__wakeProbe.push(entry)
              console.log('__PET_WAKE_PROBE__' + JSON.stringify(entry))
            }
            for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
              window.addEventListener(type, event => note({ type, screenX: event.screenX, screenY: event.screenY, pointerId: event.pointerId }), true)
            }
            window.todoPet.events.onPetReset(() => note({ type: 'pet:reset-interaction' }))
            window.todoPet.events.onPetEvent(event => note({ type: 'pet:event', action: event.action }))
          })
          return { page, state: await nativeState() }
        } catch (error) {
          if (!page.isClosed()) throw error
        }
      }
    }
    await sleep(75)
  }
  throw new Error(`Pet window did not become ready: ${JSON.stringify({ replacedId, visible, state: await nativeState() })}`)
}

async function snapshot(label) {
  const { page, state } = await currentPet({ visible: false })
  const renderer = await page.evaluate(() => ({
    documentHidden: document.hidden,
    visibilityState: document.visibilityState,
    stage: document.querySelector('.pet-stage').className,
    busy: document.querySelector('.pet-stage').classList.contains('busy'),
    pointerEvents: getComputedStyle(document.querySelector('.pet-sprite')).pointerEvents,
    events: window.__wakeProbe
  }))
  return record({ label, window: state, renderer, settings: await main.evaluate(() => window.todoPet.pet.getSettings()) })
}

function nativeDragMouse(start, end) {
  // Each coordinate comes from Electron's DIP -> physical pixel conversion.
  // Restore the cursor and release the left button even if an assertion later fails.
  const command = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WakeMouse { [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; } [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra); }'
[WakeMouse]::SetProcessDPIAware() | Out-Null
$previous = New-Object WakeMouse+Point
[WakeMouse]::GetCursorPos([ref]$previous) | Out-Null
try {
  [WakeMouse]::SetCursorPos(${start.x},${start.y}) | Out-Null
  Start-Sleep -Milliseconds 120
  [WakeMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  for ($step = 1; $step -le 10; $step++) {
    [WakeMouse]::SetCursorPos([int](${start.x}+(${end.x}-${start.x})*$step/10),[int](${start.y}+(${end.y}-${start.y})*$step/10)) | Out-Null
    Start-Sleep -Milliseconds 35
  }
} finally {
  [WakeMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  [WakeMouse]::SetCursorPos($previous.X,$previous.Y) | Out-Null
}`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000, stdio: 'pipe' })
}

async function drag(label) {
  const { page, state } = await currentPet()
  await page.waitForFunction(() => !document.querySelector('.pet-stage').classList.contains('busy'), null, { timeout: 1500 })
  await client.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).moveTop(), state.id)
  await sleep(150)
  const rect = await page.locator('.pet-sprite').boundingBox()
  assert.ok(rect, `${label}: sprite has no bounds`)
  const before = await nativeState()
  const center = { x: Math.round(before.bounds.x + rect.x + rect.width / 2), y: Math.round(before.bounds.y + rect.y + rect.height / 2) }
  const dx = center.x > before.workArea.x + before.workArea.width / 2 ? -48 : 48
  const dy = center.y > before.workArea.y + before.workArea.height / 2 ? -24 : 24
  const points = await client.evaluate(({ screen }, input) => ({ start: screen.dipToScreenPoint(input.start), end: screen.dipToScreenPoint(input.end) }), { start: center, end: { x: center.x + dx, y: center.y + dy } })
  await page.evaluate(() => { window.__wakeProbe.length = 0 })
  nativeDragMouse(points.start, points.end)
  await sleep(250)
  const after = await snapshot(label)
  record({ label: `${label}-movement`, before, after: after.window, physicalMouse: points })
  assert.equal(after.window.id, before.id, `${label}: unexpectedly replaced window while dragging`)
  assert.ok(Math.abs(after.window.bounds.x - before.bounds.x) > 4 || Math.abs(after.window.bounds.y - before.bounds.y) > 4, `${label}: OS mouse input did not move the pet`)
  assert.ok(after.renderer.events.some(event => event.type === 'pointerdown'), `${label}: no native pointerdown reached renderer`)
  assert.ok(after.renderer.events.some(event => event.type === 'pointerup'), `${label}: no native pointerup reached renderer`)
  assert.equal(after.renderer.busy, false, `${label}: pet remained busy`)
  return after
}

async function power(event) {
  record({ label: 'simulated-power-event', event, window: await nativeState() })
  await client.evaluate(({ powerMonitor }, name) => powerMonitor.emit(name), event)
}

async function assertRestored(label, previous) {
  const { page } = await currentPet({ replacedId: previous.window.id })
  await page.waitForFunction(() => !document.querySelector('.pet-stage').classList.contains('busy'), null, { timeout: 1500 })
  const next = await snapshot(label)
  // Check original geometry before any mouse action; never move to a test coordinate.
  assert.deepEqual(next.window.bounds, previous.window.bounds, `${label}: wake changed position or size`)
  assert.notEqual(next.window.id, previous.window.id, `${label}: old BrowserWindow was reused`)
  assert.notEqual(next.window.hwnd, previous.window.hwnd, `${label}: old HWND was reused`)
  assert.equal(next.window.visible, true, `${label}: recovered pet is hidden`)
  assert.equal(next.window.crashed, false, `${label}: recovered renderer crashed`)
  assert.equal(next.renderer.busy, false, `${label}: recovered pet is busy`)
  assert.notEqual(next.renderer.pointerEvents, 'none', `${label}: sprite still blocks pointer input`)
  assert.equal(next.settings.paused, false, `${label}: wake changed hidden preference`)
  // Renderer-only image: useful debugging evidence, not a desktop compositor check.
  await page.locator('.pet-sprite').screenshot({ path: join(run, `${label}-renderer-sprite.png`), omitBackground: true })
  return next
}

async function realWake() {
  await client.evaluate(({ powerMonitor }) => {
    Object.assign(powerMonitor, global.__petWakeIdleMethods)
    delete global.__petWakeIdleMethods
  })
  const previous = await snapshot('before-real-wake-wait')
  evidence.realWake = { requested: true, verified: false, timeoutMs: 180000 }
  await client.evaluate(({ BrowserWindow, powerMonitor }) => {
    const events = []
    const listeners = []
    for (const name of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) {
      const listener = () => {
        const window = BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win.webContents.getURL().includes('view=pet'))
        events.push({ event: name, at: new Date().toISOString(), timestamp: Date.now(), window: window ? { id: window.id, hwnd: window.getNativeWindowHandle().toString('hex'), bounds: window.getBounds() } : null })
      }
      powerMonitor.on(name, listener)
      listeners.push([name, listener])
    }
    global.__petWakeHardwareProbe = { events, listeners }
  })
  console.log('REAL_WAKE_READY: Waiting up to 180 seconds for the user to lock/unlock or suspend/resume Windows. Do not drag the pet until verification finishes.')
  const deadline = Date.now() + evidence.realWake.timeoutMs
  try {
    while (Date.now() < deadline) {
      const events = await client.evaluate(() => global.__petWakeHardwareProbe.events)
      evidence.realWake.events = events
      const wake = events.filter(event => event.event === 'unlock-screen' || event.event === 'resume').at(-1)
      if (wake && Date.now() - wake.timestamp >= 2000) {
        const away = events.find(event => event.window && (event.event === 'lock-screen' || event.event === 'suspend'))
        const baseline = away ? { ...previous, window: { ...previous.window, ...away.window } } : previous
        await assertRestored('after-real-wake', baseline)
        await drag('after-real-wake-native-drag')
        evidence.realWake.verified = true
        evidence.realWake.completedAt = new Date().toISOString()
        console.log('PASS real power event recovery and native mouse dragging')
        return
      }
      await sleep(400)
    }
    evidence.realWake.timedOut = true
    console.log('REAL_WAKE_UNVERIFIED: No completed real wake event within 180 seconds. Simulated acceptance passed; hardware wake remains unverified.')
  } finally {
    await client.evaluate(({ powerMonitor }) => {
      for (const [name, listener] of global.__petWakeHardwareProbe.listeners) powerMonitor.removeListener(name, listener)
      delete global.__petWakeHardwareProbe
    }).catch(() => {})
  }
}

;(async () => {
  assert.equal(process.platform, 'win32', 'This regression uses the Windows native mouse')
  client = await electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : [root]), `--user-data-dir=${profile}`], env, cwd: root })
  const observed = new WeakSet()
  const observe = page => {
    if (observed.has(page)) return
    observed.add(page)
    page.on('console', message => {
      const text = message.text()
      if (text.startsWith('__PET_WAKE_PROBE__')) evidence.rendererEvents.push({ url: page.url(), ...JSON.parse(text.slice('__PET_WAKE_PROBE__'.length)) })
    })
    page.on('pageerror', error => evidence.errors.push({ at: new Date().toISOString(), url: page.url(), message: error.message }))
  }
  client.on('window', observe)
  client.windows().forEach(observe)
  for (let i = 0; i < 100; i++) {
    main = client.windows().find(page => !page.isClosed() && page.url().includes('index.html') && !page.url().includes('view='))
    if (main) break
    await sleep(100)
  }
  assert.ok(main, 'Main renderer did not start')
  await main.waitForFunction(() => Boolean(window.todoPet))
  await client.evaluate(({ BrowserWindow, powerMonitor }) => {
    BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('view='))?.hide()
    // Avoid the host's real idle state affecting simulated lock/unlock tests.
    global.__petWakeIdleMethods = { getSystemIdleTime: powerMonitor.getSystemIdleTime, getSystemIdleState: powerMonitor.getSystemIdleState }
    powerMonitor.getSystemIdleTime = () => 0
    powerMonitor.getSystemIdleState = () => 'active'
  })

  await drag('startup-drag')
  let previous = await snapshot('before-lock')
  await power('lock-screen')
  await power('unlock-screen')
  await assertRestored('after-unlock', previous)
  await drag('after-unlock-drag')

  previous = await snapshot('before-suspend')
  await power('suspend')
  await power('resume')
  await assertRestored('after-resume', previous)
  await drag('after-resume-drag')

  previous = await snapshot('before-stale-renderer-lock')
  await power('lock-screen')
  const stale = await currentPet({ visible: false })
  await client.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    window.webContents.send('pet:event', { animation: 'waiting', action: 'health-water', message: 'Wake regression: stale reminder' })
  }, stale.state.id)
  await stale.page.waitForSelector('.pet-stage.busy', { state: 'attached' })
  await sleep(100)
  // Inject after the reminder's initial IPC, so hang-mode setup cannot clear it.
  await client.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).setIgnoreMouseEvents(true, { forward: true }), stale.state.id)
  record({ label: 'injected-old-window-fault', busyReminder: true, ignoreMouseEvents: true, window: await nativeState() })
  await snapshot('stale-renderer-during-lock')
  await power('unlock-screen')
  await assertRestored('stale-renderer-recovered', previous)
  await drag('stale-renderer-recovered-drag')
  await sleep(7000)
  await drag('after-old-animation-deadline-drag')

  for (let i = 0; i < 2; i++) {
    previous = await snapshot(`before-manual-show-${i}`)
    await main.evaluate(() => window.todoPet.pet.show())
    await assertRestored(`after-manual-show-${i}`, previous)
    await drag(`after-manual-show-${i}-drag`)
  }

  previous = await snapshot('before-user-hide')
  await main.evaluate(() => window.todoPet.pet.updateSettings({ paused: true }))
  await power('lock-screen')
  await power('suspend')
  await power('resume')
  await power('unlock-screen')
  // Allow both scheduled wake recovery delays to expire.
  await sleep(1500)
  const hidden = await snapshot('user-hidden-after-wake')
  assert.equal(hidden.window.visible, false, 'Wake unexpectedly showed a user-hidden pet')
  assert.equal(hidden.settings.paused, true, 'Wake lost the user-hidden preference')
  assert.deepEqual(hidden.window.bounds, previous.window.bounds, 'Wake moved a user-hidden pet')
  await main.evaluate(() => window.todoPet.pet.show())
  await assertRestored('user-hidden-manual-recovery', { ...previous, window: hidden.window })
  await drag('user-hidden-manual-recovery-drag')
  assert.deepEqual(evidence.errors, [], 'Renderer errors occurred during acceptance')
  evidence.simulatedPassed = true
  console.log('PASS simulated wake recovery, HWND replacement, preserved geometry, native mouse dragging, and user-hidden preference')
  if (process.argv.includes('--real-wake')) await realWake()
  else evidence.realWake = { requested: false, verified: false }
  evidence.passed = evidence.realWake.requested && !evidence.realWake.verified ? null : true
  evidence.status = evidence.passed ? 'passed' : 'simulated-passed-hardware-unverified'
})().catch(error => {
  evidence.passed = false
  evidence.failure = { message: error.message, stack: error.stack }
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  evidence.finishedAt = new Date().toISOString()
  writeFileSync(join(run, 'results.json'), JSON.stringify(evidence, null, 2))
  console.log('Evidence:', join(run, 'results.json'))
  if (client) {
    await client.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await client.close().catch(() => {})
  }
})
