// Real application screenshots with synthetic data in a disposable profile.
// Build first, then run: node scripts/capture-readme.cjs
const { _electron: electron } = require('playwright')
const { mkdirSync, mkdtempSync } = require('node:fs')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')

async function capture() {
  mkdirSync(resolve('.pet-run'), { recursive: true })
  mkdirSync(resolve('assets/readme'), { recursive: true })
  const profile = mkdtempSync(resolve('.pet-run/readme-demo-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const client = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env })
  try {
    assert.equal(await client.evaluate(({ app }) => app.getPath('userData')), profile)
    let page
    for (let i = 0; i < 100; i++) {
      page = client.windows().find(p => p.url().includes('index.html') && !p.url().includes('view='))
      if (page) break
      await new Promise(done => setTimeout(done, 100))
    }
    assert.ok(page)
    await page.waitForSelector('.new-task')
    await page.evaluate(async () => {
      await window.todoPet.health.setAutoResume(false)
      await window.todoPet.pet.updateSettings({ paused: true })
      await window.todoPet.tasks.create({ title: '完成今天最重要的一件事', priority: 'high', notes: '先留出一段不被打扰的时间，把最重要的部分做完。' })
      await window.todoPet.tasks.create({ title: '整理本周的工作复盘', priority: 'medium', notes: '记录做成的事、遇到的问题，以及下一步。' })
      await window.todoPet.tasks.create({ title: '读 20 分钟，记下一条收获', priority: 'low', notes: '让每天的小进步有迹可循。' })
      const completed = await window.todoPet.tasks.create({ title: '把脑海里的灵感记下来', notes: '给稍纵即逝的想法找个落脚点。' })
      await window.todoPet.tasks.complete(completed.id)
      await window.todoPet.notes.create('spark', { title: '把提醒做成温柔的陪伴', body: '做完一件事时给一点反馈，休息提醒保持简单。' })
    })
    await page.reload()
    await page.locator('.task-card').filter({ hasText: '完成今天最重要的一件事' }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: resolve('assets/readme/tasks.png') })
    await page.getByRole('button', { name: /健康记录/ }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: resolve('assets/readme/health.png') })
    console.log('Saved two real application screenshots using synthetic demo data.')
  } finally {
    await client.evaluate(({ app, BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.setClosable(true)
      app.quit()
    }).catch(() => {})
    await client.close()
  }
}
capture().catch(error => { console.error(error); process.exitCode = 1 })
