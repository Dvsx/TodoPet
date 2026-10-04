const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { resolve } = require('node:path')

async function main() {
  const profile = mkdtempSync(resolve('.pet-run/task-completion-'))
  const packaged = process.argv.includes('--packaged')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const client = await electron.launch({
    ...(packaged ? { executablePath: resolve('release/win-unpacked/TodoPet.exe') } : {}),
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${profile}`],
    env,
    timeout: 30000
  })
  const errors = []
  try {
    console.log('Client launched', { profile })
    assert.equal(await client.evaluate(({ app }) => app.getPath('userData')), profile)
    // Pet/bubble renderers can finish before the main window.
    let page
    const deadline = Date.now() + 15000
    while (!page && Date.now() < deadline) {
      page = client.windows().find((window) => window.url().includes('/index.html') && !window.url().includes('view='))
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(page, 'Main task window did not load')
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await page.waitForSelector('.new-task')
    const task = await page.evaluate(() => window.todoPet.tasks.create({ title: '完成回归测试' }))
    await page.reload()
    await page.getByRole('button', { name: `完成 ${task.title}`, exact: true }).click()
    if (process.argv.includes('--expect-broken')) {
      await page.waitForFunction(() => document.querySelector('.task-card:not(.done)'))
      await page.waitForTimeout(300)
      assert.ok(errors.some((message) => message.includes('cancel is not a function')), JSON.stringify(errors))
      const saved = await page.evaluate(() => window.todoPet.tasks.list('all'))
      assert.equal(saved[0].status, 'open')
      console.log('REPRODUCED:', errors, 'task remains open')
      return
    }
    await page.getByRole('button', { name: `取消完成 ${task.title}`, exact: true }).waitFor()
    const done = await page.evaluate(() => window.todoPet.tasks.list('completed'))
    assert.equal(done[0].id, task.id)
    assert.ok(done[0].completedAt)
    await page.getByRole('button', { name: `取消完成 ${task.title}`, exact: true }).click()
    await page.getByRole('button', { name: `完成 ${task.title}`, exact: true }).waitFor()
    await page.getByRole('button', { name: '＋ 新建任务', exact: true }).click()
    await page.getByPlaceholder('写下要完成的一件事…').fill('编辑后完成')
    await page.getByPlaceholder('写下要完成的一件事…').press('Enter')
    await page.getByRole('button', { name: '完成 编辑后完成', exact: true }).waitFor()
    await page.getByPlaceholder('留下一点上下文…').fill('点击完成前的修改必须保存')
    await page.getByRole('button', { name: '完成 编辑后完成', exact: true }).click()
    await page.getByRole('button', { name: '取消完成 编辑后完成', exact: true }).waitFor()
    const edited = await page.evaluate(() => window.todoPet.tasks.list('completed'))
    assert.equal(edited[0].notes, '点击完成前的修改必须保存')
    await page.reload()
    await page.getByRole('button', { name: '取消完成 编辑后完成', exact: true }).waitFor()
    await page.getByRole('button', { name: /数据分析/ }).click()
    await page.waitForSelector('.hero-today')
    await page.getByRole('button', { name: /灵感/, exact: false }).click()
    await page.getByRole('button', { name: /任务清单/ }).click()
    await page.getByRole('button', { name: '完成 完成回归测试', exact: true }).waitFor()
    await page.locator('.task-card').filter({ hasText: '完成回归测试' }).click()
    await page.getByRole('button', { name: '删除任务', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[aria-label="完成 完成回归测试"]'))
    assert.equal((await page.evaluate(() => window.todoPet.tasks.list('all'))).length, 1)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve('.pet-run/verify-task-completion.png') })
    console.log('PASS: complete, reopen, create, save-before-complete, reload persistence, navigation, deletion; no renderer errors.', { packaged, profile })
  } catch (error) {
    console.error('Interaction failed', error, errors)
    throw error
  } finally {
    // Production windows hide on close to stay in the tray. Let this isolated
    // test instance actually exit so failures cannot leave a client running.
    await client.evaluate(({ app, BrowserWindow }) => {
      app.removeAllListeners('window-all-closed')
      for (const window of BrowserWindow.getAllWindows()) {
        window.removeAllListeners('close')
        window.setClosable(true)
      }
    })
    await client.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
