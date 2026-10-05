const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

// Exercise the renderer drag IPC against real Windows bounds in an isolated profile.
async function main() {
  mkdirSync('.pet-run', { recursive: true })
  const profile = mkdtempSync(resolve('.pet-run/drag-edges-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = process.argv.find(arg => arg.startsWith('--exe='))?.slice(6)
  const client = await electron.launch({
    ...(exe ? { executablePath: resolve(exe) } : {}),
    args: [...(exe ? [] : ['.']), `--user-data-dir=${profile}`],
    env
  })
  const results = []
  try {
    assert.equal(await client.evaluate(({ app }) => app.getPath('userData')), profile)
    async function petPage(previous) {
      let page
      await assertEventually(async () => {
        page = client.windows().find(p => p !== previous && !p.isClosed() && p.url().includes('view=pet'))
        return Boolean(page)
      })
      await page.waitForSelector('.pet-sprite')
      return page
    }
    async function geometry(page) {
      const native = await client.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=pet'))
        const bounds = window.getBounds()
        return { bounds, work: screen.getDisplayMatching(bounds).workArea }
      })
      const sprite = await page.locator('.pet-sprite').boundingBox()
      return { ...native, sprite, left: native.bounds.x + sprite.x, right: native.bounds.x + sprite.x + sprite.width }
    }
    let pet = await petPage()
    for (const size of ['small', 'medium', 'large']) {
      await pet.evaluate(size => window.todoPet.pet.updateSettings({ size }), size)
      await pet.reload()
      await pet.waitForSelector('.pet-sprite')
      for (const edge of ['right', 'left']) {
        await pet.evaluate(dx => {
          window.todoPet.pet.nudge({ dx, dy: 0 })
          window.todoPet.pet.endDrag()
        }, edge === 'right' ? 100000 : -100000)
        await assertEventually(async () => {
          const g = await geometry(pet)
          return Math.abs(edge === 'right' ? g.right - g.work.x - g.work.width : g.left - g.work.x) <= 1
        })
        const before = await geometry(pet)
        const saved = await pet.evaluate(() => window.todoPet.pet.getSettings())
        assert.ok(Math.abs(saved.x - before.left) <= 1, 'drag position must be persisted')
        await pet.evaluate(async () => {
          await window.todoPet.pet.setToastVisible(true)
          await window.todoPet.pet.setToastVisible(false)
        })
        assert.deepEqual((await geometry(pet)).bounds, before.bounds, 'toast must not shift or resize the pet')
        await pet.evaluate(() => window.todoPet.pet.show()).catch(() => {})
        pet = await petPage(pet)
        await assertEventually(async () => JSON.stringify((await geometry(pet)).bounds) === JSON.stringify(before.bounds))
        results.push({ size, edge, ...before, savedX: saved.x })
      }
    }
    console.log(JSON.stringify(results, null, 2))
    console.log('PASS: six edge positions, persistence, stable toast bounds and redisplay')
  } finally {
    writeFileSync(resolve(profile, 'results.json'), JSON.stringify(results, null, 2))
    console.log('Evidence:', resolve(profile, 'results.json'))
    await client.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await client.close().catch(() => {})
  }
}

async function assertEventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for expected pet bounds')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
