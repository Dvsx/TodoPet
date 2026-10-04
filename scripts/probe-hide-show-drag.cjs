const {_electron: electron} = require('playwright')
const {mkdtempSync, writeFileSync, mkdirSync} = require('fs')
const {resolve} = require('path')

async function wait(ms) { return new Promise((done) => setTimeout(done, ms)) }

;(async () => {
  const env = {...process.env}
  delete env.ELECTRON_RUN_AS_NODE
  mkdirSync(resolve('.pet-run'), {recursive: true})
  const profile = mkdtempSync(resolve('.pet-run/hide-show-drag-'))
  const app = await electron.launch({args: ['.', `--user-data-dir=${profile}`], env})
  let pet, main
  for (let i = 0; i < 100; i++) {
    pet = app.windows().find((page) => page.url().includes('view=pet'))
    main = app.windows().find((page) => page.url().includes('index.html') && !page.url().includes('view='))
    if (pet && main) break
    await wait(100)
  }
  if (!pet || !main) throw new Error('pet or main window missing')
  await pet.waitForSelector('.pet-sprite')
  await app.evaluate(({BrowserWindow}) => {
    const petWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('view=pet'))
    petWindow.setPosition(500, 280)
    globalThis.probePet = petWindow
  })
  await main.evaluate(() => window.todoPet.pet.show())
  await wait(300)

  await pet.evaluate(() => {
    globalThis.probeEvents = []
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'visibilitychange']) {
      window.addEventListener(type, (event) => {
        globalThis.probeEvents.push({
          type,
          hidden: document.hidden,
          visibilityState: document.visibilityState,
          buttons: event.buttons,
          pointerId: event.pointerId,
          target: event.target?.className || ''
        })
        globalThis.probeEvents = globalThis.probeEvents.slice(-50)
      }, true)
    }
  })

  async function snap(label) {
    return {
      label,
      native: await app.evaluate(() => ({
        bounds: probePet.getBounds(),
        visible: probePet.isVisible(),
        opacity: probePet.getOpacity()
      })),
      renderer: await pet.evaluate(() => ({
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        stage: document.querySelector('.pet-stage')?.className,
        events: globalThis.probeEvents.splice(0)
      }))
    }
  }

  async function playwrightDrag() {
    const box = await pet.locator('.pet-sprite').boundingBox()
    await pet.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await pet.mouse.down()
    await pet.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 + 40, {steps: 8})
    await pet.mouse.up()
    await wait(200)
  }

  async function ipcNudge() {
    await pet.evaluate(() => window.todoPet.pet.nudge({dx: -40, dy: 40}))
    await wait(100)
    await pet.evaluate(() => window.todoPet.pet.endDrag())
    await wait(100)
  }

  const start = await snap('start')
  await playwrightDrag()
  const afterPlaywright = await snap('after-playwright-drag')
  await ipcNudge()
  const afterNudge = await snap('after-ipc-nudge')

  await main.evaluate(() => window.todoPet.pet.updateSettings({paused: true}))
  await wait(400)
  const hidden = await snap('hidden')

  await main.evaluate(() => window.todoPet.pet.show())
  await wait(500)
  const shown = await snap('shown')

  await playwrightDrag()
  const afterPlaywright2 = await snap('after-playwright-drag-2')
  await ipcNudge()
  const afterNudge2 = await snap('after-ipc-nudge-2')

  const moved = (a, b) => a.x !== b.x || a.y !== b.y
  const summary = {
    documentHiddenWhileHidden: hidden.renderer.hidden,
    visibilityWhileHidden: hidden.renderer.visibilityState,
    nativeVisibleWhileHidden: hidden.native.visible,
    documentHiddenAfterShow: shown.renderer.hidden,
    visibilityAfterShow: shown.renderer.visibilityState,
    playwrightMovedBeforeHide: moved(start.native.bounds, afterPlaywright.native.bounds),
    ipcMovedBeforeHide: moved(afterPlaywright.native.bounds, afterNudge.native.bounds),
    playwrightMovedAfterShow: moved(shown.native.bounds, afterPlaywright2.native.bounds),
    ipcMovedAfterShow: moved(afterPlaywright2.native.bounds, afterNudge2.native.bounds),
    playwrightEventsBefore: afterPlaywright.renderer.events.map((event) => `${event.type}:hidden=${event.hidden}:buttons=${event.buttons}`),
    playwrightEventsAfter: afterPlaywright2.renderer.events.map((event) => `${event.type}:hidden=${event.hidden}:buttons=${event.buttons}`),
    stageAfterShow: shown.renderer.stage,
    bounds: {
      start: start.native.bounds,
      afterPlaywright: afterPlaywright.native.bounds,
      afterNudge: afterNudge.native.bounds,
      shown: shown.native.bounds,
      afterPlaywright2: afterPlaywright2.native.bounds,
      afterNudge2: afterNudge2.native.bounds
    }
  }
  writeFileSync(resolve('.pet-run/hide-show-drag-report.json'), JSON.stringify({summary, start, afterPlaywright, afterNudge, hidden, shown, afterPlaywright2, afterNudge2}, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  await main.evaluate(() => window.todoPet.window.quit()).catch(() => {})
  await app.close()
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
