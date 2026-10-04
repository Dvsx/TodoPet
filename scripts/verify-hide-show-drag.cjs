const { _electron: electron } = require('playwright')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  mkdirSync('.pet-run', { recursive: true })
  const profile = mkdtempSync(resolve('.pet-run/reshow-regression-'))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const exe = process.argv.find(a => a.startsWith('--exe='))?.slice(6)
  const client = await electron.launch({ ...(exe ? { executablePath: resolve(exe) } : {}), args: [...(exe ? [] : ['.']), `--user-data-dir=${profile}`], env })
  const results = []
  try {
    let pet, main
    for (let i = 0; i < 100; i++) {
      pet = client.windows().find(p => p.url().includes('view=pet'))
      main = client.windows().find(p => p.url().includes('index.html') && !p.url().includes('view='))
      if (pet && main) break
      await sleep(100)
    }
    await pet.waitForSelector('.pet-sprite')
    await pet.evaluate(() => {
      window.dragEvents = []
      for (const type of ['pointerdown', 'pointerup']) window.addEventListener(type, e => window.dragEvents.push(e.type), true)
    })
    await client.evaluate(({ BrowserWindow }) => {
      global.testPet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=pet'))
      BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('view='))?.hide()
    })
    async function drag(label) {
      // Recovery can replace the native window and renderer. Never inject
      // input into the old page or keep using its stale BrowserWindow handle.
      for (let i = 0; i < 100; i++) {
        pet = client.windows().find(p => !p.isClosed() && p.url().includes('view=pet'))
        if (pet) break
        await sleep(100)
      }
      await pet.waitForSelector('.pet-sprite')
      await pet.evaluate(() => {
        if (window.dragEvents) return
        window.dragEvents = []
        for (const type of ['pointerdown', 'pointerup']) window.addEventListener(type, e => window.dragEvents.push(e.type), true)
      })
      await client.evaluate(({ BrowserWindow }) => {
        global.testPet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=pet'))
      })
      await client.evaluate(() => { testPet.setPosition(300, 180); testPet.moveTop() })
      await sleep(250)
      const rect = await pet.locator('.pet-sprite').boundingBox()
      const before = await client.evaluate(() => testPet.getBounds())
      const point = await client.evaluate(({ screen }, p) => screen.dipToScreenPoint(p), { x: Math.round(before.x + rect.x + rect.width / 2), y: Math.round(before.y + rect.y + rect.height / 2) })
      await pet.evaluate(() => { window.dragEvents = [] })
      const ps = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class MouseProbe { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'; [MouseProbe]::SetProcessDPIAware() | Out-Null; [MouseProbe]::SetCursorPos(${point.x},${point.y}) | Out-Null; Start-Sleep -Milliseconds 100; [MouseProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero); for($step=1;$step -le 8;$step++){ [MouseProbe]::SetCursorPos(${point.x}+$step*8,${point.y}+$step*4) | Out-Null; Start-Sleep -Milliseconds 35 }; [MouseProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps])
      await sleep(200)
      const result = { label, at: new Date().toISOString(), before, after: await client.evaluate(() => testPet.getBounds()), renderer: await pet.evaluate(() => ({ hidden: document.hidden, stage: document.querySelector('.pet-stage').className, events: window.dragEvents })) }
      results.push(result)
      console.log(JSON.stringify(result))
      return result
    }
    await drag('startup')
    for (let i = 0; i < 3; i++) {
      await main.evaluate(() => window.todoPet.pet.updateSettings({ paused: true }))
      await sleep(150)
      await main.evaluate(() => window.todoPet.pet.show())
      await drag(`hide-show-${i}`)
    }
    await client.evaluate(() => testPet.webContents.send('pet:event', { animation: 'waiting', action: 'health-water', message: '测试提醒' }))
    await pet.waitForSelector('.pet-stage.busy')
    await main.evaluate(() => window.todoPet.pet.updateSettings({ paused: true }))
    await sleep(150)
    await main.evaluate(() => window.todoPet.pet.show())
    await drag('hide-during-reminder')
    // The old async animation must not resume and disable a recovered pet.
    await sleep(7000)
    await drag('after-cancelled-animation-deadline')
    await client.evaluate(() => testPet.webContents.send('pet:event', { animation: 'waiting', action: 'health-water', message: '测试重新显示' }))
    await pet.waitForSelector('.pet-stage.busy')
    await main.evaluate(() => window.todoPet.pet.show())
    await drag('manual-redisplay-during-reminder')
    for (const result of results) {
      assert.ok(result.after.x !== result.before.x || result.after.y !== result.before.y, `${result.label}: Windows mouse did not move the pet`)
      assert.ok(result.renderer.events.includes('pointerdown'), `${result.label}: no pointerdown`)
      assert.ok(result.renderer.events.includes('pointerup'), `${result.label}: no pointerup`)
    }
  } finally {
    writeFileSync(resolve(profile, 'results.json'), JSON.stringify(results, null, 2))
    console.log('Evidence:', resolve(profile, 'results.json'))
    await client.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await client.close().catch(() => {})
  }
})().catch(e => { console.error(e); process.exitCode = 1 })
