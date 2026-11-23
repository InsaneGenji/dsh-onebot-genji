// 生成 dsh-onebot-genji 的 GitHub social preview（1280x640）
// 用法：node scripts/make-social-preview.mjs
// 依赖 @napi-rs/canvas（已在 package.json dependencies 里）
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'node:fs'

const W = 1280
const H = 640
const canvas = createCanvas(W, H)
const ctx = canvas.getContext('2d')

GlobalFonts.registerFromPath('C:\\Windows\\Fonts\\msyhbd.ttc', 'YaHeiBold')
GlobalFonts.registerFromPath('C:\\Windows\\Fonts\\msyh.ttc', 'YaHei')

// 背景：深蓝 → 靛紫的对角渐变
const bg = ctx.createLinearGradient(0, 0, W, H)
bg.addColorStop(0, '#0b1533')
bg.addColorStop(0.45, '#122a5c')
bg.addColorStop(1, '#1b3f7a')
ctx.fillStyle = bg
ctx.fillRect(0, 0, W, H)

// 右上角一团柔光
const glow = ctx.createRadialGradient(W * 0.78, H * 0.18, 20, W * 0.78, H * 0.18, 460)
glow.addColorStop(0, 'rgba(96,165,250,0.42)')
glow.addColorStop(1, 'rgba(96,165,250,0)')
ctx.fillStyle = glow
ctx.fillRect(0, 0, W, H)

// 细网格
ctx.strokeStyle = 'rgba(255,255,255,0.045)'
ctx.lineWidth = 1
for (let x = 0; x < W; x += 40) {
  ctx.beginPath()
  ctx.moveTo(x + 0.5, 0)
  ctx.lineTo(x + 0.5, H)
  ctx.stroke()
}
for (let y = 0; y < H; y += 40) {
  ctx.beginPath()
  ctx.moveTo(0, y + 0.5)
  ctx.lineTo(W, y + 0.5)
  ctx.stroke()
}

// 左侧文字块
ctx.textBaseline = 'alphabetic'
ctx.fillStyle = '#93c5fd'
ctx.font = '600 26px YaHei'
ctx.fillText('DeepSeek Harness · OneBot 11', 76, 150)

ctx.fillStyle = '#ffffff'
ctx.font = 'bold 62px YaHeiBold'
ctx.fillText('dsh-onebot-genji', 72, 262)

// 渐变的副标题
const sub = ctx.createLinearGradient(72, 0, 720, 0)
sub.addColorStop(0, '#bfdbfe')
sub.addColorStop(1, '#60a5fa')
ctx.fillStyle = sub
ctx.font = 'bold 44px YaHeiBold'
ctx.fillText('把 QQ 接进你的 AI 搭档', 76, 348)

// 特性小标签
const tags = ['表情包库', '主动搭话', '语音转写', '群聊上下文']
ctx.font = '500 24px YaHei'
let tx = 76
const ty = 412
for (const t of tags) {
  const w = ctx.measureText(t).width + 34
  ctx.fillStyle = 'rgba(147,197,253,0.14)'
  ctx.beginPath()
  ctx.roundRect(tx, ty - 30, w, 46, 23)
  ctx.fill()
  ctx.strokeStyle = 'rgba(147,197,253,0.35)'
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.fillStyle = '#dbeafe'
  ctx.fillText(t, tx + 17, ty)
  tx += w + 12
}

// 安装命令
ctx.fillStyle = 'rgba(0,0,0,0.32)'
ctx.beginPath()
ctx.roundRect(76, 470, 596, 62, 12)
ctx.fill()
ctx.strokeStyle = 'rgba(147,197,253,0.3)'
ctx.stroke()
ctx.fillStyle = '#a3e635'
ctx.font = 'bold 26px YaHeiBold'
ctx.fillText('$', 98, 510)
ctx.fillStyle = '#e5e7eb'
ctx.font = '24px YaHei'
ctx.fillText('dsh plugin --profile web add dsh-onebot-genji', 122, 510)

// 右下角作者
ctx.fillStyle = 'rgba(191,219,254,0.75)'
ctx.font = '22px YaHei'
ctx.fillText('github.com/InsaneGenji/dsh-onebot-genji', 76, 588)

// 右侧立绘：贴右下，圆形裁切
const img = await loadImage('docs\\avatar.jpg')
const size = 400
const cx = W - size / 2 - 60
const cy = H / 2 + 6
ctx.save()
// 光晕
const halo = ctx.createRadialGradient(cx, cy, size * 0.36, cx, cy, size * 0.62)
halo.addColorStop(0, 'rgba(96,165,250,0.5)')
halo.addColorStop(1, 'rgba(96,165,250,0)')
ctx.fillStyle = halo
ctx.beginPath()
ctx.arc(cx, cy, size * 0.66, 0, Math.PI * 2)
ctx.fill()

ctx.beginPath()
ctx.arc(cx, cy, size / 2, 0, Math.PI * 2)
ctx.closePath()
ctx.save()
ctx.clip()
ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size)
ctx.restore()

// 圆环
ctx.beginPath()
ctx.arc(cx, cy, size / 2, 0, Math.PI * 2)
ctx.strokeStyle = 'rgba(191,219,254,0.85)'
ctx.lineWidth = 6
ctx.stroke()
ctx.restore()

const out = 'D:\\Software\\dsh-workspace\\dsh-onebot-genji\\docs\\social-preview.png'
writeFileSync(out, canvas.encodeSync('png'))
console.log('wrote', out)
