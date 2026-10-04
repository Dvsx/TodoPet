const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

async function main() {
  const packaged = process.argv.includes('--packaged')
  const profile = mkdtempSync(resolve('.pet-run/overlay-regression-'))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const client = await electron.launch({
    ...(packaged ? { executablePath: resolve('release/win-unpacked/TodoPet.exe') } : {}),
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${profile}`], env
  })
  try {
    let petPage
    for (let i=0; i<100 && !petPage; i++) {
      petPage = client.windows().find(p => p.url().includes('view=pet'))
      if (!petPage) await new Promise(r=>setTimeout(r,100))
    }
    assert.ok(petPage)
    await petPage.waitForSelector('.pet-cutout')
    const info = await client.evaluate(({BrowserWindow,screen}) => {
      const pet = BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('view=pet'))
      const main = BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('view='))
      main.hide()
      pet.setPosition(200,150)
      const b = pet.getBounds()
      const backdrop = new BrowserWindow({x:b.x-20,y:b.y-20,width:b.width+40,height:b.height+40,frame:false,backgroundColor:'#123456',show:true})
      backdrop.setAlwaysOnTop(true, 'floating')
      backdrop.loadURL('data:text/html,<body style="margin:0;background:%23123456"></body>')
      global.overlayTest = {pet,backdrop}
      pet.moveTop()
      return { version:process.versions.electron, bounds:b, display:screen.getDisplayMatching(b) }
    })
    await new Promise(r=>setTimeout(r,700))
    for(let i=0;i<5;i++) {
      await client.evaluate(()=>{const {pet}=global.overlayTest;pet.setFocusable(true);pet.focus()})
      await new Promise(r=>setTimeout(r,100))
      await client.evaluate(()=>{const {pet,backdrop}=global.overlayTest; backdrop.focus();pet.setFocusable(false); pet.hide(); pet.showInactive();pet.moveTop()})
      await new Promise(r=>setTimeout(r,120))
    }
    async function capture(label) {
      await new Promise(r=>setTimeout(r,350))
      const result = await client.evaluate(async ({desktopCapturer,screen})=>{
        const b=global.overlayTest.pet.getBounds()
        const d=screen.getDisplayMatching(b)
        const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(d.size.width*d.scaleFactor),height:Math.round(d.size.height*d.scaleFactor)}})
        const source=sources.find(s=>s.display_id===String(d.id)) || sources[0]
        const size=source.thumbnail.getSize(), scale=size.width/d.size.width
        const crop=source.thumbnail.crop({x:Math.round((b.x-d.bounds.x)*scale),y:Math.round((b.y-d.bounds.y)*scale),width:Math.round(b.width*scale),height:Math.round(Math.min(b.height,240)*scale)})
        const bitmap=crop.toBitmap(), w=crop.getSize().width
        let bad=0, total=0
        // Entire left side is transparent. Native caption pixels must never cover the backdrop.
        for(let y=4;y<32;y+=2) for(let x=20;x<150;x+=5) {
          const offset=(Math.round(y*scale)*w+Math.round(x*scale))*4
          const expected=[0x56,0x34,0x12]
          if(expected.some((v,i)=>Math.abs(bitmap[offset+i]-v)>4)) bad++
          total++
        }
        return {bad,total,png:crop.toPNG().toString('base64')}
      })
      writeFileSync(resolve(`.pet-run/overlay-${label}.png`),Buffer.from(result.png,'base64'))
      console.log(label,{bad:result.bad,total:result.total})
      return result.bad
    }
    console.log(info)
    const bad = await capture('fixed')
    assert.equal(bad,0,'Native caption covers transparent top area')
    const before=await client.evaluate(()=>global.overlayTest.pet.getBounds())
    await petPage.evaluate(()=>window.todoPet.pet.nudge({ dx:20, dy:10 }))
    await new Promise(r=>setTimeout(r,150))
    await petPage.evaluate(()=>window.todoPet.pet.endDrag())
    const after=await client.evaluate(()=>global.overlayTest.pet.getBounds())
    assert.equal(after.x,before.x+20)
    assert.equal(after.y,before.y+10)
    assert.equal(await capture('after-drag'),0)
    await client.evaluate(()=>{const {pet}=global.overlayTest; pet.webContents.send('pet:event',{animation:'waiting',action:'health-water',title:'回归测试',message:'透明窗口提醒验证'})})
    await petPage.waitForSelector('.hang-actor.dropped')
    assert.equal(await capture('after-drop'),0)
    await petPage.waitForFunction(()=>!document.querySelector('.hang-actor.dropped'), {timeout:15000})
    assert.equal(await capture('after-return'),0)
    console.log('PASS: native desktop pixels, repeated focus/show, drag and event', {packaged})
  } finally {
    await client.evaluate(({app,BrowserWindow})=>{app.removeAllListeners('window-all-closed');for(const w of BrowserWindow.getAllWindows()){w.removeAllListeners('close');w.setClosable(true)}})
    await client.close()
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
