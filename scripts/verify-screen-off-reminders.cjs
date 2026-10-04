// Build first. This script uses an isolated profile and never changes display power.
// Mouse input occurs only with the explicitly requested --native-drag option.
// node scripts/verify-screen-off-reminders.cjs [--exe=release-.../win-unpacked/TodoPet.exe] [--real-display] [--native-drag]
const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const root = resolve(__dirname, '..')
const executablePath = process.argv.find(value => value.startsWith('--exe='))?.slice(6)
const realDisplay = process.argv.includes('--real-display')
const nativeDrag = process.argv.includes('--native-drag')
const run = join(root, '.pet-run', `screen-off-${executablePath ? 'packaged' : 'source'}-${Date.now()}`)
const profile = join(run, 'profile')
mkdirSync(profile, { recursive: true })
const resultPath = join(run, 'result.json')
const runtimeEventsPath = join(run, 'native-events.ndjson')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const evidence = {
  startedAt: new Date().toISOString(), executablePath: executablePath ? resolve(executablePath) : null,
  profile, simulatedInput: true, mouseInput: false, nativeDragRequested: nativeDrag, changesDisplayPower: false,
  status: 'running', checks: [], samples: [], errors: [], helperWarnings: [], playwrightEvents: [], runtimeEventsPath,
  realDisplay: { requested: realDisplay, status: 'unverified' }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const save = () => writeFileSync(resultPath, JSON.stringify(evidence, null, 2))
let client, main
let helperPids = []

function readRuntimeEvents() {
  if (!existsSync(runtimeEventsPath)) return []
  return readFileSync(runtimeEventsPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return { type: 'incomplete-native-log', line } }
  })
}

// A Playwright Page can lose its CDP target while the actual Electron window
// remains alive. Resolve the current native main window for every health read.
// A missing/crashed native renderer is still an explicit failure, never retried away.
async function mainEvaluate(callback, value) {
  const code = `(${callback.toString()})(${JSON.stringify(value) ?? 'undefined'})`
  return client.evaluate(async ({ BrowserWindow }, code) => {
    const window = BrowserWindow.getAllWindows().find(window => {
      const url = window.webContents.getURL()
      return url.includes('index.html') && !url.includes('view=')
    })
    if (!window) throw new Error('Native main BrowserWindow is missing')
    if (window.webContents.isCrashed()) throw new Error('Native main renderer has crashed')
    return window.webContents.executeJavaScript(code)
  }, code)
}

async function eventually(label, read, accept, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accept(value)) return value
    await sleep(100)
  }
  throw new Error(`${label}: timeout; last value=${JSON.stringify(value)}`)
}

async function currentPet() {
  const page = await eventually('pet renderer', async () => {
    const state = await client.evaluate(({ BrowserWindow }) => {
      const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet'))
      return pet ? { id: pet.id, url: pet.webContents.getURL() } : null
    })
    if (!state) return null
    for (const candidate of client.windows()) {
      if (candidate.isClosed() || !candidate.url().includes('view=pet')) continue
      try {
        const handle = await client.browserWindow(candidate)
        const id = await handle.evaluate(window => window.id)
        await handle.dispose()
        if (id !== state.id) continue
        await candidate.waitForSelector('.pet-stage', { state: 'attached', timeout: 3000 })
        await candidate.evaluate(() => {
          if (window.__screenOffRenderer) return
          const stage = document.querySelector('.pet-stage')
          const trace = window.__screenOffRenderer = []
          const note = () => trace.push({ at: Date.now(), busy: stage.classList.contains('busy'), classes: stage.className })
          new MutationObserver(note).observe(stage, { attributes: true, attributeFilter: ['class'] })
          note()
        })
        return candidate
      } catch (error) { if (!candidate.isClosed()) throw error }
    }
    return null
  }, Boolean)
  return page
}

async function snapshot(label) {
  const [health, native] = await Promise.all([
    mainEvaluate(async () => ({ session: await window.todoPet.health.session(), presets: await window.todoPet.health.list() })),
    client.evaluate(({ BrowserWindow }) => ({
      displayEvents: global.__screenOffProbe.displayEvents,
      healthEvents: global.__screenOffProbe.healthEvents,
      windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, webContentsId: window.webContents.id, url: window.webContents.getURL(), visible: window.isVisible(), crashed: window.webContents.isCrashed() }))
    }))
  ])
  const sample = { label, at: new Date().toISOString(), ...health, ...native,
    originalPlaywrightMainClosed: main?.isClosed() ?? null,
    playwrightPages: client.windows().map(page => ({ url: page.url(), closed: page.isClosed() })) }
  evidence.samples.push(sample)
  save()
  return sample
}

async function display(state) {
  await client.evaluate(({ app }, state) => {
    global.__screenOffProbe.simulatingDisplay = true
    try { app.emit('todopet:display-power', state) }
    finally { global.__screenOffProbe.simulatingDisplay = false }
  }, state)
}

async function setIdle(seconds) {
  await client.evaluate((_, seconds) => { global.__screenOffProbe.idle = seconds }, seconds)
}

function occurrence(kind, ageMs = 0, status = 'fired') {
  const at = new Date(Date.now() - ageMs).toISOString()
  return { id: randomUUID(), sourceType: 'health', sourceId: kind, scheduledAt: at, status,
    firedAt: status === 'fired' ? at : null, acknowledgedAt: null, snoozedFromId: null,
    title: `${kind} screen-off acceptance` }
}

async function databaseOccurrences(rows, readOnly = false) {
  return client.evaluate(({ app }, { expectedProfile, rows, readOnly }) => {
    if (app.getPath('userData') !== expectedProfile) throw new Error('Refusing database access outside the isolated profile')
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const { join } = process.getBuiltinModule('node:path')
    const db = new DatabaseSync(join(expectedProfile, 'todopet.db'), { readOnly })
    try {
      if (!readOnly) {
        const insert = db.prepare('INSERT INTO reminder_occurrences VALUES (?,?,?,?,?,?,?,?,?)')
        for (const row of rows) insert.run(row.id, row.sourceType, row.sourceId, row.scheduledAt, row.status, row.firedAt, null, null, row.title)
      }
      return db.prepare('SELECT id,source_id,status,scheduled_at,fired_at FROM reminder_occurrences ORDER BY scheduled_at').all()
    } finally { db.close() }
  }, { expectedProfile: profile, rows, readOnly })
}

async function inject(rows) {
  await client.evaluate(({ BrowserWindow }, rows) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet'))
    if (!pet) throw new Error('Missing pet renderer')
    global.__screenOffProbe.injectingReminder = true
    try {
      for (const reminder of rows) pet.webContents.send('pet:event', {
        animation: 'waiting', action: `health-${reminder.sourceId}`, message: reminder.title, reminder
      })
    } finally { global.__screenOffProbe.injectingReminder = false }
  }, rows)
}

async function assertQuiet(label, durationMs = 1500) {
  const deadline = Date.now() + durationMs
  const windows = new Map()
  const samples = []
  let lastLiveAt = Date.now()
  // Display-off can detach Chromium's CDP pages while the native windows stay
  // healthy. Observe the actual Electron renderer through the main inspector.
  do {
    const sample = await client.evaluate(async ({ BrowserWindow }) => {
      const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet'))
      if (!pet) return null
      const contents = pet.webContents
      if (contents.isCrashed()) throw new Error('Native pet renderer crashed during quiet assertion')
      const id = pet.id, hwnd = pet.getNativeWindowHandle().toString('hex')
      let timer, onDestroyed
      try {
        const script = `(() => {
          const stage = document.querySelector('.pet-stage');
          if (!stage) return null;
          if (!window.__screenOffRenderer) {
            const trace = window.__screenOffRenderer = [];
            const note = () => trace.push({ at: Date.now(), busy: stage.classList.contains('busy'), classes: stage.className });
            new MutationObserver(note).observe(stage, { attributes: true, attributeFilter: ['class'] });
            note();
          }
          return { busy: stage.classList.contains('busy'), trace: window.__screenOffRenderer, length: window.__screenOffRenderer.length };
        })()`
        // Electron may leave executeJavaScript pending when a renderer is
        // deliberately destroyed during wake recovery. Race that lifecycle,
        // while a live renderer that stops responding remains a hard failure.
        const goneOrTimeout = new Promise((resolve, reject) => {
          onDestroyed = () => resolve(null)
          contents.once('destroyed', onDestroyed)
          timer = setTimeout(() => {
            if (contents.isDestroyed()) resolve(null)
            else reject(new Error(`Native pet renderer ${id} did not answer within 3 seconds`))
          }, 3000)
        })
        const renderer = await Promise.race([contents.executeJavaScript(script), goneOrTimeout])
        return renderer ? { id, hwnd, renderer } : null
      } catch (error) {
        if (contents.isDestroyed()) return null // deliberate native-window replacement
        throw error
      } finally {
        clearTimeout(timer)
        if (onDestroyed) contents.removeListener('destroyed', onDestroyed)
      }
    })
    if (sample) {
      const { id, renderer } = sample
      renderer.trace = windows.has(id) ? renderer.trace.slice(windows.get(id)) : renderer.trace.slice(-1)
      assert.equal(renderer.busy, false, `${label}: pet is still animating`)
      assert.ok(renderer.trace.every(item => !item.busy), `${label}: a queued animation restarted`)
      windows.set(id, renderer.length)
      samples.push(sample)
      lastLiveAt = Date.now()
    } else {
      assert.ok(Date.now() - lastLiveAt < 3000, `${label}: native pet renderer failed to recover`)
    }
    await sleep(100)
  } while (Date.now() < deadline || Date.now() - lastLiveAt >= 1000)
  assert.ok(samples.length, `${label}: no live renderer was observed`)
  evidence.checks.push({ label, renderer: { transport: 'native-webContents', windowsObserved: windows.size, samples } })
  save()
}

async function assertPaused(label) {
  const sample = await snapshot(label)
  assert.equal(sample.session.state, 'paused', `${label}: health recording did not pause`)
  assert.equal(sample.session.active, false)
  assert.ok(sample.presets.every(preset => preset.nextTriggerAt === null), `${label}: reminders still have a scheduled deadline`)
  return sample
}

async function resumeFromInput(label) {
  const inputAt = Date.now()
  await setIdle(0)
  await eventually(`${label} session`, () => mainEvaluate(() => window.todoPet.health.session()), session => session.state === 'sitting', 4000)
  const sample = await snapshot(label)
  for (const preset of sample.presets) {
    assert.ok(preset.nextTriggerAt, `${preset.kind} has no next reminder`)
    assert.ok(Date.parse(preset.nextTriggerAt) >= inputAt + preset.intervalMinutes * 60_000 - 1000,
      `${preset.kind} did not restart a full interval after return`)
  }
  await setIdle(100)
  await assertQuiet(`${label}-no-burst`, 2500)
  return sample
}

async function waitForRealDisplayPair() {
  // Only the user/OS changes monitor power. Idle remains controlled to separate
  // a real power-on notification from the subsequent input-based resume check.
  const start = await client.evaluate(() => global.__screenOffProbe.displayEvents.length)
  evidence.realDisplay = { requested: true, status: 'waiting', deadline: new Date(Date.now() + 180_000).toISOString() }
  save()
  console.log('REAL_DISPLAY_READY: Waiting up to 180 seconds for a real display off/on pair; this script will not turn off the display.')
  let off, on
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const events = await client.evaluate((_, start) => global.__screenOffProbe.displayEvents.slice(start), start)
    const offIndex = events.findIndex(event => !event.simulated && event.state === 'off')
    off = events[offIndex]
    if (off) on = events.slice(offIndex + 1).find(event => !event.simulated && event.state === 'on')
    evidence.realDisplay.events = events
    if (on) evidence.realDisplay.on = on
    save()
    if (off && !on && !evidence.realDisplay.off) {
      evidence.realDisplay.off = off
      await assertPaused('real-display-off')
    }
    if (off && on) break
    await sleep(250)
  }
  if (!off || !on) {
    evidence.realDisplay = { ...evidence.realDisplay, status: 'unverified', reason: 'No complete native display off/on pair within 180 seconds', off: off || null, on: on || null }
    save()
    return
  }
  await sleep(1400)
  await assertPaused('real-display-on-without-input')
  await assertQuiet('real-display-on-no-old-animations')
  await resumeFromInput('real-display-resumed-after-simulated-input')
  evidence.realDisplay = { ...evidence.realDisplay, status: 'passed', off, on, inputWasSimulated: true }
  save()
}

async function verifyNativeDrag() {
  const before = await client.evaluate(async ({ BrowserWindow, screen }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet'))
    if (!pet || pet.webContents.isCrashed()) throw new Error('No healthy native pet window for drag acceptance')
    pet.moveTop()
    const renderer = await pet.webContents.executeJavaScript(`(() => {
      window.__screenOffDragEvents = [];
      for (const type of ['pointerdown', 'pointerup']) window.addEventListener(type, event => window.__screenOffDragEvents.push({ type, at: Date.now(), x: event.screenX, y: event.screenY }), true);
      const sprite = document.querySelector('.pet-sprite'), style = getComputedStyle(sprite), image = document.querySelector('.pet-cutout');
      return { rect: sprite.getBoundingClientRect().toJSON(), busy: document.querySelector('.pet-stage').classList.contains('busy'), image: { complete: image.complete, naturalWidth: image.naturalWidth }, style: { pointerEvents: style.pointerEvents, opacity: style.opacity, transform: style.transform } };
    })()`)
    const bounds = pet.getBounds(), workArea = screen.getDisplayMatching(bounds).workArea
    const center = { x: Math.round(bounds.x + renderer.rect.x + renderer.rect.width / 2), y: Math.round(bounds.y + renderer.rect.y + renderer.rect.height / 2) }
    const delta = { x: center.x > workArea.x + workArea.width / 2 ? -48 : 48, y: center.y > workArea.y + workArea.height / 2 ? -24 : 24 }
    return { id: pet.id, hwnd: pet.getNativeWindowHandle().toString('hex'), visible: pet.isVisible(), enabled: pet.isEnabled(), alwaysOnTop: pet.isAlwaysOnTop(), bounds, renderer,
      start: screen.dipToScreenPoint(center), end: screen.dipToScreenPoint({ x: center.x + delta.x, y: center.y + delta.y }) }
  })
  assert.equal(before.renderer.busy, false, 'Pet is busy before native drag')
  for (const point of [before.start, before.end]) for (const coordinate of [point.x, point.y]) assert.ok(Number.isInteger(coordinate))
  await sleep(150)
  const { start, end } = before
  const expectedHwndHex = Buffer.from(before.hwnd, 'hex').readBigUInt64LE().toString(16)
  const command = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ScreenOffMouse { [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; } [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra); [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flags); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint processId); [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index); }'
[ScreenOffMouse]::SetProcessDPIAware() | Out-Null
$previous = New-Object ScreenOffMouse+Point
[ScreenOffMouse]::GetCursorPos([ref]$previous) | Out-Null
$targetHwnd = [IntPtr]::new([Convert]::ToInt64('${expectedHwndHex}',16))
$targetExStyle = [ScreenOffMouse]::GetWindowLongPtr($targetHwnd,-20).ToInt64()
function Get-MouseHit {
  $actual = New-Object ScreenOffMouse+Point
  $cursorRead = [ScreenOffMouse]::GetCursorPos([ref]$actual)
  $hitHwnd = [ScreenOffMouse]::WindowFromPoint($actual)
  $hitRoot = [ScreenOffMouse]::GetAncestor($hitHwnd,2)
  [uint32]$hitProcessId = 0
  [ScreenOffMouse]::GetWindowThreadProcessId($hitRoot,[ref]$hitProcessId) | Out-Null
  return [pscustomobject]@{ cursorRead=$cursorRead; x=$actual.X; y=$actual.Y; hwnd=$hitHwnd.ToInt64().ToString('x'); rootHwnd=$hitRoot.ToInt64().ToString('x'); processId=$hitProcessId }
}
$probe = [ordered]@{ targetHwnd='${expectedHwndHex}'; targetExStyle=$targetExStyle; targetTransparent=(($targetExStyle -band 0x20) -ne 0); previous=@{x=$previous.X;y=$previous.Y}; moves=@() }
$pressed = $false
try {
  $probe.startSet = [ScreenOffMouse]::SetCursorPos(${start.x},${start.y})
  Start-Sleep -Milliseconds 120
  $probe.beforeDown = Get-MouseHit
  if ($probe.beforeDown.rootHwnd -ne $probe.targetHwnd) {
    $probe.skipped = 'Cursor hit a different native window; no button was pressed'
  } else {
    [ScreenOffMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    $pressed = $true
    for ($step = 1; $step -le 10; $step++) {
      $moved = [ScreenOffMouse]::SetCursorPos([int](${start.x}+(${end.x}-${start.x})*$step/10),[int](${start.y}+(${end.y}-${start.y})*$step/10))
      $probe.moves += [pscustomobject]@{success=$moved;hit=(Get-MouseHit)}
      Start-Sleep -Milliseconds 35
    }
  }
} finally {
  if ($pressed) { [ScreenOffMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
  $probe.beforeRestore = Get-MouseHit
  $probe.restored = [ScreenOffMouse]::SetCursorPos($previous.X,$previous.Y)
  $probe.afterRestore = Get-MouseHit
}
$probe | ConvertTo-Json -Depth 6 -Compress
`
  evidence.mouseInput = true
  save()
  const mouseProbe = JSON.parse(execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000, stdio: 'pipe', encoding: 'utf8' }).trim())
  await sleep(250)
  const after = await client.evaluate(async ({ BrowserWindow }, id) => {
    const pet = BrowserWindow.fromId(id)
    if (!pet || pet.isDestroyed()) throw new Error('Pet window was replaced during the native drag')
    return { id: pet.id, hwnd: pet.getNativeWindowHandle().toString('hex'), bounds: pet.getBounds(),
      renderer: await pet.webContents.executeJavaScript(`({ busy: document.querySelector('.pet-stage').classList.contains('busy'), events: window.__screenOffDragEvents })`) }
  }, before.id)
  evidence.nativeDrag = { before, after, mouseProbe, displayEvents: evidence.realDisplay.status === 'passed' ? 'native' : 'simulated' }
  save()
  assert.ok(Math.abs(after.bounds.x - before.bounds.x) > 4 || Math.abs(after.bounds.y - before.bounds.y) > 4, 'Native mouse input did not move the pet')
  assert.ok(after.renderer.events.some(event => event.type === 'pointerdown'), 'Native pointerdown did not reach the pet')
  assert.ok(after.renderer.events.some(event => event.type === 'pointerup'), 'Native pointerup did not reach the pet')
  assert.equal(after.renderer.busy, false, 'Pet remained busy after native drag')
  evidence.nativeDrag.status = 'passed'
  save()
}

async function runAcceptance() {
  assert.equal(process.platform, 'win32', 'This acceptance checks the Windows display-power helper')
  client = await electron.launch({
    ...(executablePath ? { executablePath: resolve(executablePath) } : {}),
    args: [...(executablePath ? [] : [root]), `--user-data-dir=${profile}`], cwd: root, env
  })
  // Install immediately: the native helper normally sends its initial state
  // while renderers are still loading. A missing notification fails explicitly.
  await client.evaluate(async ({ app, powerMonitor, webContents, BrowserWindow }, runtimeEventsPath) => {
    await app.whenReady()
    const { appendFileSync } = process.getBuiltinModule('node:fs')
    global.__screenOffProbe = { idle: 100, displayEvents: [], healthEvents: [], simulatingDisplay: false, injectingReminder: false, expectedQuit: false }
    const probe = global.__screenOffProbe
    const note = (type, detail = {}) => appendFileSync(runtimeEventsPath, JSON.stringify({ at: new Date().toISOString(), type, expectedQuit: probe.expectedQuit, ...detail }) + '\n')
    note('probe-installed', { pid: process.pid })
    app.on('before-quit', () => note('before-quit', { fatal: !probe.expectedQuit }))
    app.on('window-all-closed', () => note('window-all-closed'))
    app.on('child-process-gone', (_, details) => note('child-process-gone', { ...details, fatal: !probe.expectedQuit && details.reason !== 'clean-exit' }))
    const observeWindow = window => {
      const id = window.id
      let lastUrl = window.webContents.getURL()
      window.webContents.on('did-navigate', (_, url) => { lastUrl = url })
      const detail = () => ({ id, url: lastUrl })
      for (const name of ['show', 'hide', 'unresponsive', 'responsive']) window.on(name, () => note(`window-${name}`, detail()))
      window.on('closed', () => note('window-closed', { ...detail(), fatal: !probe.expectedQuit && lastUrl.includes('index.html') && !lastUrl.includes('view=') }))
      note('window-observed', detail())
    }
    BrowserWindow.getAllWindows().forEach(observeWindow)
    app.on('browser-window-created', (_, window) => observeWindow(window))
    probe.realIdleTime = powerMonitor.getSystemIdleTime
    probe.realIdleState = powerMonitor.getSystemIdleState
    powerMonitor.getSystemIdleTime = () => probe.idle
    powerMonitor.getSystemIdleState = () => 'active'
    app.prependListener('todopet:display-power', state => {
      const event = { at: Date.now(), state, simulated: probe.simulatingDisplay }
      probe.displayEvents.push(event)
      // Persist before application callbacks: transport/renderer failure cannot
      // erase the native off/on evidence captured immediately before it.
      note('display-power', event)
    })
    const observe = contents => {
      const id = contents.id
      let lastUrl = contents.getURL()
      contents.on('did-navigate', (_, url) => { lastUrl = url; note('renderer-navigate', { id, url }) })
      contents.on('render-process-gone', (_, details) => note('render-process-gone', { id, url: lastUrl, ...details, fatal: !probe.expectedQuit && details.reason !== 'clean-exit' }))
      contents.on('destroyed', () => note('renderer-destroyed', { id, url: lastUrl }))
      contents.on('did-fail-load', (_, errorCode, errorDescription, url, isMainFrame) => note('renderer-load-failed', { id, errorCode, errorDescription, url, isMainFrame, fatal: !probe.expectedQuit && isMainFrame && errorCode !== -3 }))
      const send = contents.send.bind(contents)
      contents.send = (channel, ...args) => {
        const event = args[0]
        if ((channel === 'pet:event' && (event?.action === 'health-water' || event?.action === 'health-stand')) ||
            (channel === 'reminder:raised' && event?.sourceType === 'health')) {
          probe.healthEvents.push({ at: Date.now(), channel, event, injected: probe.injectingReminder })
        }
        return send(channel, ...args)
      }
    }
    webContents.getAllWebContents().forEach(observe)
    app.on('web-contents-created', (_, contents) => observe(contents))
  }, runtimeEventsPath)
  const notePlaywright = (type, detail = {}) => {
    evidence.playwrightEvents.push({ at: new Date().toISOString(), type, ...detail })
    save()
  }
  client.process().on('exit', (code, signal) => notePlaywright('electron-process-exit', { code, signal }))
  client.process().stderr?.on('data', chunk => {
    const text = chunk.toString()
    if (text.includes('[display-power]')) evidence.helperWarnings.push({ at: new Date().toISOString(), text })
  })
  const observe = page => {
    page.on('pageerror', error => evidence.errors.push({ at: new Date().toISOString(), url: page.url(), message: error.message }))
    page.on('close', () => notePlaywright('page-close', { url: page.url() }))
    page.on('crash', () => { evidence.errors.push({ at: new Date().toISOString(), url: page.url(), message: 'Playwright observed a renderer crash' }); save() })
  }
  client.on('window', observe)
  client.windows().forEach(observe)
  assert.equal(await client.evaluate(({ app }) => app.getPath('userData')), profile)
  main = await eventually('main renderer', async () => client.windows().find(page => !page.isClosed() && page.url().includes('index.html') && !page.url().includes('view=')), Boolean)
  await main.waitForFunction(() => Boolean(window.todoPet))
  const nativeReady = await eventually('native helper initial on notification',
    () => client.evaluate(() => global.__screenOffProbe.displayEvents),
    events => events.some(event => !event.simulated && event.state === 'on'), 20_000)
  evidence.nativeInitialEvents = nativeReady
  evidence.helper = await client.evaluate(({ app }) => {
    const { existsSync, readFileSync } = process.getBuiltinModule('node:fs')
    const { join } = process.getBuiltinModule('node:path')
    const { createHash } = process.getBuiltinModule('node:crypto')
    const script = app.isPackaged ? join(process.resourcesPath, 'windows', 'display-power-monitor.ps1') : join(app.getAppPath(), 'resources', 'windows', 'display-power-monitor.ps1')
    const children = process._getActiveHandles().filter(handle => Array.isArray(handle.spawnargs) && handle.spawnargs.some(arg => String(arg).endsWith('display-power-monitor.ps1')))
    return { script, exists: existsSync(script), sha256: createHash('sha256').update(readFileSync(script)).digest('hex'), pids: children.map(child => child.pid), mainPid: process.pid }
  })
  assert.equal(evidence.helper.exists, true)
  assert.ok(evidence.helper.pids.length > 0, 'No tracked native helper process')
  helperPids = evidence.helper.pids
  await mainEvaluate(async () => {
    await window.todoPet.health.setAutoResume(true)
    await window.todoPet.pet.updateSettings({ paused: false, reducedMotion: false })
    for (const preset of await window.todoPet.health.list()) await window.todoPet.health.update({ ...preset, enabled: true, intervalMinutes: 5, windowStart: '', windowEnd: '', weekdays: [1, 2, 3, 4, 5, 6, 7] })
    await window.todoPet.health.start()
  })
  await currentPet()
  await snapshot('initial-active')

  const stale = [occurrence('water', 6 * 3600_000), occurrence('stand', 6 * 3600_000)]
  await databaseOccurrences(stale)
  await inject(stale)
  await assertQuiet('old-fired-events-ignored', 1200)

  const fresh = [occurrence('water'), occurrence('stand')]
  await databaseOccurrences(fresh)
  await inject(fresh)
  const activePet = await currentPet()
  await activePet.waitForSelector('.pet-stage.busy', { state: 'attached' })
  await display('off')
  await assertPaused('screen-off')
  // Longer than the complete 6.78s animation: neither its continuation nor the
  // queued stand reminder may resurrect after the reset.
  await assertQuiet('screen-off-cancels-current-and-queued-animation', 8000)
  const recordsAfterOff = await databaseOccurrences([], true)
  for (const row of [...stale, ...fresh]) assert.equal(recordsAfterOff.find(item => item.id === row.id)?.status, 'missed')
  evidence.databaseAfterOff = recordsAfterOff

  // Model overdue timers that reach the main process only after a long absence.
  const overdue = [occurrence('water', 6 * 3600_000, 'pending'), occurrence('stand', 6 * 3600_000, 'pending')]
  await databaseOccurrences(overdue)
  await display('on')
  await sleep(1400)
  await assertPaused('display-on-without-input')
  await assertQuiet('display-on-no-replay')
  await resumeFromInput('input-resumes-fresh-intervals')
  evidence.databaseAfterReturn = await databaseOccurrences([], true)
  for (const row of overdue) assert.ok(['missed', 'cancelled'].includes(evidence.databaseAfterReturn.find(item => item.id === row.id)?.status), 'An overdue health reminder remained deliverable')

  if (realDisplay) await waitForRealDisplayPair()
  if (nativeDrag) await verifyNativeDrag()
  const final = await snapshot('final')
  assert.deepEqual(final.healthEvents.filter(event => !event.injected), [], 'Old health reminders were emitted after wake')
  assert.deepEqual(evidence.errors, [], 'Renderer errors occurred')
  assert.deepEqual(evidence.helperWarnings, [], 'Native display-power helper failed')
  assert.deepEqual(readRuntimeEvents().filter(event => event.fatal), [], 'Native window/renderer/GPU lifecycle failure occurred')
  evidence.status = 'passed'
}

;(async () => {
  save()
  try { await runAcceptance() }
  catch (error) { evidence.status = 'failed'; evidence.failure = error.stack || String(error); process.exitCode = 1 }
  finally {
    if (client) {
      // Normal quit exercises the application's disposal path, including helper cleanup.
      await client.evaluate(({ app, BrowserWindow }) => {
        if (global.__screenOffProbe) global.__screenOffProbe.expectedQuit = true
        for (const window of BrowserWindow.getAllWindows()) window.setClosable(true)
        app.quit()
      }).catch(() => {})
      await client.close().catch(() => {})
    }
    const orphaned = []
    for (const pid of helperPids) {
      let alive = true
      for (let attempt = 0; attempt < 20; attempt++) {
        try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') { alive = false; break } }
        await sleep(250)
      }
      if (alive) {
        orphaned.push(pid)
        // Clean up only the helper created by this isolated test.
        try { process.kill(pid) } catch { /* report the failed cleanup below */ }
      }
    }
    evidence.helperCleanup = { trackedPids: helperPids, orphaned, passed: orphaned.length === 0 }
    evidence.nativeRuntimeEvents = readRuntimeEvents()
    if (evidence.nativeRuntimeEvents.some(event => event.fatal)) { evidence.status = 'failed'; process.exitCode = 1 }
    if (orphaned.length) { evidence.status = 'failed'; process.exitCode = 1 }
    evidence.finishedAt = new Date().toISOString()
    save()
    console.log(JSON.stringify({ status: evidence.status, realDisplay: evidence.realDisplay.status, resultPath, failure: evidence.failure }, null, 2))
  }
})()
