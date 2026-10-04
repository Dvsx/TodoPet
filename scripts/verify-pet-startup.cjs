// Real compositor acceptance: desktop pixels, not only BrowserWindow.isVisible().
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const run = fs.mkdtempSync(path.join(root, '.pet-run/startup-'))
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function test(label, bypassOpacity, executablePath) {
  const profile = path.join(run, label); fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, 'window-settings.json'), JSON.stringify({ pet: { x: 594, y: 120, size: 'medium', paused: false } }))
  if (process.argv.includes('--saved-position')) fs.copyFileSync(path.join(process.env.APPDATA, 'todopet/window-settings.json'), path.join(profile, 'window-settings.json'))
  const bootstrap = path.join(profile, 'bootstrap.cjs')
  fs.writeFileSync(bootstrap, `${bypassOpacity ? "require('electron').BrowserWindow.prototype.setOpacity = function () {};" : ''}\nrequire(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
  const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : [bootstrap]), `--user-data-dir=${profile}`], env })
  try {
    let pet, main
    for (let i = 0; i < 100; i++) {
      pet = app.windows().find(w => w.url().includes('view=pet'))
      main = app.windows().find(w => w.url().includes('index.html') && !w.url().includes('view='))
      if (pet && main) break
      await sleep(100)
    }
    await pet.waitForSelector('.pet-cutout')
    await pet.waitForFunction(() => { const i = document.querySelector('.pet-cutout'); return i.complete && i.naturalWidth > 0 })
    async function prepareUnderlay() { await app.evaluate(({ BrowserWindow, screen }) => {
      const pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=pet'))
      const main = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('view='))
      // White underlay makes actual desktop sprite pixels measurable.
      main.setBounds(screen.getPrimaryDisplay().workArea); main.show(); main.setAlwaysOnTop(true)
      pet.moveTop()
    })
    await main.evaluate(() => { document.body.innerHTML = '<div style="position:fixed;inset:0;background:white"></div>' })
    }
    console.log('renderer', await pet.evaluate(() => ({ width: innerWidth, height: innerHeight, sprite: document.querySelector('.pet-sprite').getBoundingClientRect().toJSON(), image: document.querySelector('.pet-cutout').naturalWidth })))
    async function snapshot(stage) {
      await sleep(900)
      const result = await app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
        const pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=pet'))
        const b = pet.getBounds(), d = screen.getDisplayMatching(b), s = d.scaleFactor
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * s), height: Math.round(d.size.height * s) } })
        const source = sources.find(x => x.display_id === String(d.id)) || sources[0]
        const crop = source.thumbnail.crop({ x: Math.round((b.x - d.bounds.x) * s), y: Math.round((b.y - d.bounds.y) * s), width: Math.round(b.width * s), height: Math.round(b.height * s) })
        const bitmap = crop.toBitmap(); let redPixels = 0
        for (let i = 0; i < bitmap.length; i += 4) { const blue = bitmap[i], green = bitmap[i + 1], red = bitmap[i + 2]; if (red > 100 && red > green * 1.5 && red > blue * 1.3) redPixels++ }
        return { visible: pet.isVisible(), bounds: b, redPixels, png: crop.toPNG().toString('base64') }
      })
      fs.writeFileSync(path.join(run, `${label}-${stage}.png`), Buffer.from(result.png, 'base64')); delete result.png
      console.log(label, stage, result)
      return result
    }
    await prepareUnderlay()
    const results = { startup: await snapshot('startup') }
    await main.evaluate(() => window.todoPet.pet.updateSettings({ paused: true }))
    results.hidden = await snapshot('hidden')
    await main.evaluate(() => window.todoPet.pet.show())
    results.reshown = await snapshot('reshown')
    for (let i = 0; i < 3; i++) await main.evaluate(() => window.todoPet.pet.show())
    results.repeated = await snapshot('repeated')
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('lock-screen'); powerMonitor.emit('unlock-screen') })
    await sleep(800)
    results.unlockEvent = await snapshot('unlock-event')
    return results
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
}

;(async () => {
  const compare = process.argv.includes('--compare')
  const exeArg = process.argv.find(x => x.startsWith('--exe='))
  const result = compare
    ? { original: await test('original', false), bypassOpacity: await test('bypass-opacity', true) }
    : { fixed: await test('fixed', false, exeArg ? path.resolve(exeArg.slice(6)) : undefined) }
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(result, null, 2))
  console.log('ARTIFACTS', run)
  for (const [label, samples] of Object.entries(result)) {
    if (label === 'original') continue
    assert.equal(samples.hidden.visible, false)
    assert.ok(samples.hidden.redPixels < 100, `${label}: hidden sprite still on desktop`)
    for (const stage of ['startup', 'reshown', 'repeated', 'unlockEvent']) {
      assert.ok(samples[stage].visible && samples[stage].redPixels > 500, `${label}/${stage}: missing actual desktop sprite`)
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
