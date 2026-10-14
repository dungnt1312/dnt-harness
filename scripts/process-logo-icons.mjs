#!/usr/bin/env node
// Turn two GenerateImage/EditImage app-icon renders (one rounded-square tile each,
// centered on a near-white page) into the app's logo assets. Pure pixel work:
// nothing is redrawn, only cropped, made transparent outside the tile and resized.
//
// Usage: node scripts/process-logo-icons.mjs <dark-tile.png> <light-tile.png>
//
// Writes into web/public/icons: icon-512.png, icon-192.png, icon-maskable-512.png,
// apple-touch-icon.png, favicon-32.png, logo-dark.png, logo-light.png.
// logo-dark is the dark tile (shown on the light theme), logo-light the light tile.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'web/public/icons')
const [darkPath, lightPath] = process.argv.slice(2)
if (darkPath === undefined || lightPath === undefined) {
  console.error('usage: node scripts/process-logo-icons.mjs <dark-tile.png> <light-tile.png>')
  process.exit(1)
}
const read = (file) => fs.readFileSync(file).toString('base64')

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const result = await page.evaluate(async ({ dark, light }) => {
  const load = async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    return img
  }

  // Crop to the tile and clear everything outside it. The page colour is sampled
  // from the corner rather than assumed white: a light tile can sit only ~12
  // levels away from the page, so the flood fill uses a tight tolerance.
  const cut = (img, name) => {
    const { width: W, height: H } = img
    const src = document.createElement('canvas')
    src.width = W
    src.height = H
    const sctx = src.getContext('2d', { willReadFrequently: true })
    sctx.drawImage(img, 0, 0)
    const d = sctx.getImageData(0, 0, W, H)
    const bg = [d.data[(2 * W + 2) * 4], d.data[(2 * W + 2) * 4 + 1], d.data[(2 * W + 2) * 4 + 2]]
    const far = (p, tol) => Math.abs(d.data[p * 4] - bg[0]) + Math.abs(d.data[p * 4 + 1] - bg[1]) + Math.abs(d.data[p * 4 + 2] - bg[2]) > tol

    let x0 = W, y0 = H, x1 = 0, y1 = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (far(y * W + x, 6)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    }
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    if (w < W * 0.4 || Math.abs(w - h) / Math.max(w, h) > 0.08) throw new Error(`${name}: no single square tile found (bbox ${w}x${h} in ${W}x${H})`)

    const side = Math.max(w, h)
    const t = document.createElement('canvas')
    t.width = side
    t.height = side
    const tctx = t.getContext('2d', { willReadFrequently: true })
    tctx.drawImage(src, x0, y0, w, h, 0, 0, side, side)
    const td = tctx.getImageData(0, 0, side, side)
    const seen = new Uint8Array(side * side)
    const stack = []
    const isBg = (p) => !seen[p] && Math.abs(td.data[p * 4] - bg[0]) + Math.abs(td.data[p * 4 + 1] - bg[1]) + Math.abs(td.data[p * 4 + 2] - bg[2]) <= 6
    const push = (x, y) => { const p = y * side + x; if (isBg(p)) { seen[p] = 1; stack.push(p) } }
    for (let i = 0; i < side; i++) { push(i, 0); push(i, side - 1); push(0, i); push(side - 1, i) }
    while (stack.length > 0) {
      const p = stack.pop()
      const x = p % side
      const y = (p - x) / side
      if (x > 0) push(x - 1, y)
      if (x < side - 1) push(x + 1, y)
      if (y > 0) push(x, y - 1)
      if (y < side - 1) push(x, y + 1)
    }
    for (let p = 0; p < side * side; p++) if (seen[p]) td.data[p * 4 + 3] = 0
    tctx.putImageData(td, 0, 0)

    const alphaAt = (x, y) => td.data[(y * side + x) * 4 + 3]
    const mid = side >> 1
    if (alphaAt(1, 1) !== 0 || alphaAt(mid, mid) !== 255) throw new Error(`${name}: background removal failed (corner alpha ${alphaAt(1, 1)}, centre alpha ${alphaAt(mid, mid)})`)
    // The tile colour, read just inside the top edge, fills the maskable canvas.
    const e = tctx.getImageData(mid, Math.round(side * 0.02), 1, 1).data
    return { canvas: t, side, bg, color: `rgb(${e[0]},${e[1]},${e[2]})` }
  }

  const scaled = (src, size, fill) => {
    const o = document.createElement('canvas')
    o.width = size
    o.height = size
    const octx = o.getContext('2d')
    octx.imageSmoothingQuality = 'high'
    if (fill !== undefined) { octx.fillStyle = fill; octx.fillRect(0, 0, size, size) }
    octx.drawImage(src, 0, 0, size, size)
    return o
  }
  const png = (cv) => cv.toDataURL('image/png').split(',')[1]

  const d = cut(await load(dark), 'dark tile')
  const l = cut(await load(light), 'light tile')

  // Maskable: the platform crops to a circle/squircle, so the tile colour fills
  // the whole canvas and the tile itself sits in the central 80 percent.
  const maskable = scaled(d.canvas, 410)
  const m = document.createElement('canvas')
  m.width = 512
  m.height = 512
  const mctx = m.getContext('2d')
  mctx.imageSmoothingQuality = 'high'
  mctx.fillStyle = d.color
  mctx.fillRect(0, 0, 512, 512)
  mctx.drawImage(maskable, 51, 51)

  return {
    info: { dark: { side: d.side, bg: d.bg, color: d.color }, light: { side: l.side, bg: l.bg, color: l.color } },
    files: {
      'icon-512.png': png(scaled(d.canvas, 512)),
      'icon-192.png': png(scaled(d.canvas, 192)),
      'apple-touch-icon.png': png(scaled(d.canvas, 180, d.color)),
      'favicon-32.png': png(scaled(d.canvas, 32)),
      'icon-maskable-512.png': png(m),
      'logo-dark.png': png(scaled(d.canvas, 128)),
      'logo-light.png': png(scaled(l.canvas, 128)),
    },
  }
}, { dark: read(darkPath), light: read(lightPath) }).catch((error) => {
  console.error(String(error.message ?? error))
  return undefined
})

await browser.close()
if (result === undefined) process.exit(1)
console.log(JSON.stringify(result.info))
for (const [name, b64] of Object.entries(result.files)) {
  fs.writeFileSync(path.join(outDir, name), Buffer.from(b64, 'base64'))
  console.log('wrote', path.relative(root, path.join(outDir, name)))
}
