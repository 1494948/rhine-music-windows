/**
 * 生成 Windows 打包所需的图标（零外部依赖）。
 *
 * 上游 `scripts/build-icons.mjs` 依赖 sharp，本机没装也不该为了一张图标装原生模块。
 * 这里的做法：直接复用上游已生成的 `public/icons/icon-512.png`，
 * 用 Node 内置 zlib 手写 PNG 解码/编码，抽取所需尺寸后打包成 ICO。
 *
 * ICO 格式允许内嵌 PNG（Vista+ 全部支持），因此不需要 BMP 编码。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'public', 'icons', 'icon-512.png')
const OUT_DIR = join(ROOT, 'assets')

/** 读PNG 头部，拿到宽高与色彩类型。 */
function readPngHeader(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('不是 PNG 文件')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const bitDepth = buf[24]
  const colorType = buf[25]
  if (bitDepth !== 8) throw new Error(`只支持 8 位色深，当前 ${bitDepth}`)
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`只支持 RGBA(6) / RGB(2)，当前 colorType=${colorType}`)
  }
  return { width, height, channels: colorType === 6 ? 4 : 3 }
}

/** 把 PNG 的 IDAT 全部解开，输出原始像素。 */
function decodePixels(buf, header) {
  const { width, height, channels } = header
  // 收集所有 IDAT chunk
  const idat = []
  let offset = 8
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(buf.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }
  if (!idat.length) throw new Error('PNG 里没有 IDAT 数据')

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)

  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0 // 左侧
      const b = prev ? prev[x] : 0 // 上方
      const c = prev && x >= channels ? prev[x - channels] : 0 // 左上
      let value = line[x]
      switch (filter) {
        case 0: break
        case 1: value = (value + a) & 0xff; break
        case 2: value = (value + b) & 0xff; break
        case 3: value = (value + ((a + b) >> 1)) & 0xff; break
        case 4: value = (value + paeth(a, b, c)) & 0xff; break
        default: throw new Error(`未知的行过滤器类型 ${filter}`)
      }
      cur[x] = value
    }
  }
  return { pixels: out, width, height, channels }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 用 3x3 超采样缩放（盒式滤波，比最近邻平滑）。 */
function resize(src, targetW, targetH) {
  const { pixels, width, height, channels } = src
  const out = Buffer.alloc(targetW * targetH * 4)
  const scaleX = width / targetW
  const scaleY = height / targetH
  const samples = 3

  for (let y = 0; y < targetH; y += 1) {
    for (let x = 0; x < targetW; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0; let count = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const srcX = Math.min(width - 1, Math.floor((x + (sx + 0.5) / samples) * scaleX))
          const srcY = Math.min(height - 1, Math.floor((y + (sy + 0.5) / samples) * scaleY))
          const idx = (srcY * width + srcX) * channels
          r += pixels[idx]
          g += pixels[idx + 1]
          b += pixels[idx + 2]
          a += channels === 4 ? pixels[idx + 3] : 255
          count += 1
        }
      }
      const dst = (y * targetW + x) * 4
      out[dst] = Math.round(r / count)
      out[dst + 1] = Math.round(g / count)
      out[dst + 2] = Math.round(b / count)
      out[dst + 3] = Math.round(a / count)
    }
  }
  return { pixels: out, width: targetW, height: targetH, channels: 4 }
}

/** CRC32（PNG chunk 用）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 编码成 PNG（始终 RGBA / filter 0）。 */
function encodePng({ pixels, width, height }) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 打包成 ICO（内嵌 PNG）。 */
function buildIco(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = header.length + dir.length
  entries.forEach((entry, i) => {
    const base = i * 16
    // 256 必须写成 0（ICO 约定：0 表示 256）
    dir[base] = entry.size >= 256 ? 0 : entry.size
    dir[base + 1] = entry.size >= 256 ? 0 : entry.size
    dir[base + 2] = 0 // 调色板
    dir[base + 3] = 0 // reserved
    dir.writeUInt16LE(1, base + 4) // planes
    dir.writeUInt16LE(32, base + 6) // bpp
    dir.writeUInt32LE(entry.png.length, base + 8)
    dir.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`找不到源图标：${SRC}`)
    console.error('请先运行上游的 node scripts/build-icons.mjs')
    process.exitCode = 1
    return
  }
  const source = decodePixels(readFileSync(SRC), readPngHeader(readFileSync(SRC)))
  console.log(`源图标：${source.width}×${source.height}`)

  mkdirSync(OUT_DIR, { recursive: true })

  // 托盘图标：32×32（Windows 托盘标准尺寸）
  const tray = encodePng(resize(source, 32, 32))
  writeFileSync(join(OUT_DIR, 'icon.png'), tray)
  console.log('✓ assets/icon.png（32×32，托盘用）')

  // ICO：16 / 24 / 32 / 48 / 64 / 128 / 256
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const entries = sizes.map((size) => ({ size, png: encodePng(resize(source, size, size)) }))
  writeFileSync(join(OUT_DIR, 'icon.ico'), buildIco(entries))
  console.log(`✓ assets/icon.ico（${sizes.join('/')}）`)
}

main()
