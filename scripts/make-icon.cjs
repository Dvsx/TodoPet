/**
 * 图标管线：resources/icon/source.png
 *   1. 边缘泛洪去白底 -> 透明
 *   2. 内容 bbox 裁剪 + 留边 -> 1024 主图
 *   3. 缩放出 16/24/32/48/64/128/256 PNG
 *   4. 打包成 build/icon.ico（PNG-in-ICO），并导出运行时 PNG 到 resources/icon/
 * 用法：pnpm icon
 */
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SOURCE = path.join(ROOT, 'resources', 'icon', 'source.png')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function buildIco(pngBuffers) {
  const count = pngBuffers.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  const entries = []
  let offset = 6 + count * 16
  pngBuffers.forEach(({ size, buffer }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bpp
    entry.writeUInt32LE(buffer.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += buffer.length
  })
  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.buffer)])
}

;(async () => {
  if (!fs.existsSync(SOURCE)) throw new Error(`缺少源图 ${SOURCE}`)
  const srcB64 = fs.readFileSync(SOURCE).toString('base64')

  const browser = await chromium.launch()
  const page = await browser.newPage()
  const result = await page.evaluate(async ({ b64, sizes }) => {
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = `data:image/png;base64,${b64}`
    })

    const W = img.naturalWidth
    const H = img.naturalHeight
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, W, H)
    const px = data.data

    const isWhite = (i) => px[i] > 245 && px[i + 1] > 245 && px[i + 2] > 245

    // 从四条边泛洪填充：只把与边缘连通的白色区域转透明，
    // 避免误伤徽章内部可能出现的白色。
    const visited = new Uint8Array(W * H)
    const stack = []
    const seed = (x, y) => { const p = y * W + x; if (!visited[p]) { visited[p] = 1; stack.push(p) } }
    for (let x = 0; x < W; x++) { seed(x, 0); seed(x, H - 1) }
    for (let y = 0; y < H; y++) { seed(0, y); seed(W - 1, y) }
    while (stack.length) {
      const p = stack.pop()
      const i = p * 4
      if (!isWhite(i)) continue
      px[i + 3] = 0
      const x = p % W
      const y = (p / W) | 0
      if (x > 0 && !visited[p - 1]) { visited[p - 1] = 1; stack.push(p - 1) }
      if (x < W - 1 && !visited[p + 1]) { visited[p + 1] = 1; stack.push(p + 1) }
      if (y > 0 && !visited[p - W]) { visited[p - W] = 1; stack.push(p - W) }
      if (y < H - 1 && !visited[p + W]) { visited[p + W] = 1; stack.push(p + W) }
    }
    ctx.putImageData(data, 0, 0)

    // 内容包围盒
    let minX = W, minY = H, maxX = -1, maxY = -1
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (px[(y * W + x) * 4 + 3] > 0) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) throw new Error('去白底后没有任何内容，检查源图背景是否为纯白')
    const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02)
    const cropX = Math.max(0, minX - pad)
    const cropY = Math.max(0, minY - pad)
    const cropW = Math.min(W, maxX + pad) - cropX
    const cropH = Math.min(H, maxY + pad) - cropY

    // 主图 1024：内容居中，四周留 3% 呼吸位
    const render = (target) => {
      const c = document.createElement('canvas')
      c.width = target
      c.height = target
      const cctx = c.getContext('2d')
      cctx.imageSmoothingEnabled = true
      cctx.imageSmoothingQuality = 'high'
      const margin = Math.round(target * 0.03)
      const inner = target - margin * 2
      const scale = Math.min(inner / cropW, inner / cropH)
      const dw = cropW * scale
      const dh = cropH * scale
      cctx.drawImage(canvas, cropX, cropY, cropW, cropH, (target - dw) / 2, (target - dh) / 2, dw, dh)
      return c.toDataURL('image/png')
    }

    const out = { master: render(1024), sizes: {} }
    for (const s of sizes) out.sizes[s] = render(s)
    return out
  }, { b64: srcB64, sizes: ICO_SIZES })
  await browser.close()

  const writeDataUrl = (dataUrl, file) => {
    const buffer = Buffer.from(dataUrl.split(',')[1], 'base64')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, buffer)
    return buffer
  }

  // 主图与运行时 PNG
  writeDataUrl(result.master, path.join(ROOT, 'resources', 'icon', 'icon-1024.png'))
  const png256 = writeDataUrl(result.sizes[256], path.join(ROOT, 'resources', 'icon', 'icon.png'))
  writeDataUrl(result.sizes[32], path.join(ROOT, 'resources', 'icon', 'icon-tray.png'))
  console.log('icon.png (256):', png256.length, 'bytes')

  // ICO
  const buffers = ICO_SIZES.map((size) => ({ size, buffer: Buffer.from(result.sizes[size].split(',')[1], 'base64') }))
  const ico = buildIco(buffers)
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico)
  console.log('build/icon.ico:', ico.length, 'bytes, sizes:', ICO_SIZES.join('/'))
})().catch((e) => { console.error(e); process.exit(1) })
