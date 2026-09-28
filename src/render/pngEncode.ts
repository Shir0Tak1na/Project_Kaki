/**
 * 最小 PNG 编码器（**纯函数模块，不 import obsidian，也不碰 DOM**）。
 *
 * 为什么需要它：连续场的颜色面是一张 RGBA 栅格，SVG 里唯一能"原样铺一张连续渐变"的手段
 * 就是内联一张位图（`<image href="data:image/png;base64,…">`）。
 * 而 `mapPreview.ts` 是纯模块（跑在假 DOM 里也能测），拿不到 `canvas.toDataURL()` ——
 * 于是这里自己把像素编成 PNG：签名 + IHDR + IDAT + IEND，双方都只用 `Uint8Array`。
 *
 * 两个刻意的取舍：
 * 1. **用 zlib 的"存储块"（stored blocks）而不是真压缩** —— 一个 Huffman 编码器要几百行，
 *    而这里的图是几万像素级的小图（128×128 约 64 KiB，base64 后约 88 KiB）。
 *    能跑、可断言、无依赖，比"省一半体积但多三百行没人看得懂的代码"值；
 * 2. **base64 自己编**：`btoa` 在 Node 的测试环境里不一定有，而表驱动只要十几行。
 *
 * 正确性有单测钉住：解出来的像素必须与输入**逐字节相同**（`pngEncode.test.ts`）。
 */

/** PNG 的 8 字节文件签名 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** 每个 IDAT 最多塞这么多原始字节（一个存储块的载荷上限 65535） */
const STORED_BLOCK_LIMIT = 65535

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(payload, 8)
  // CRC 覆盖"类型 + 载荷"
  view.setUint32(8 + payload.length, crc32(out.subarray(4, 8 + payload.length)))
  return out
}

/** zlib 包装（`0x78 0x01` + 存储块 + adler32）—— 解压器不需要任何字典 */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_BLOCK_LIMIT))
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  let offset = 0
  out[offset++] = 0x78
  out[offset++] = 0x01
  for (let index = 0; index < blocks; index += 1) {
    const start = index * STORED_BLOCK_LIMIT
    const end = Math.min(raw.length, start + STORED_BLOCK_LIMIT)
    const length = end - start
    const last = index === blocks - 1
    out[offset++] = last ? 1 : 0
    out[offset++] = length & 0xff
    out[offset++] = (length >>> 8) & 0xff
    out[offset++] = ~length & 0xff
    out[offset++] = (~length >>> 8) & 0xff
    out.set(raw.subarray(start, end), offset)
    offset += length
  }
  const view = new DataView(out.buffer)
  view.setUint32(offset, adler32(raw))
  return out.subarray(0, offset + 4)
}

/**
 * 这张尺寸的栅格编成 PNG 之后**正好**多少字节。
 *
 * 为什么要把"体积"单独做一个入口：导出的 SVG 有一条**体积上限**（内联 data URL 超过 128 KiB
 * 就退回矢量，见 `mapPreview.ts`），而判断必须在**编码之前**做（不然白编一张几十万字节的图）。
 * 代价是这里与 `encodeRgbaPngBase64` 各写了一遍"分块怎么算大小" —— 所以单测里有一条
 * **逐尺寸比对**：`pngEncodedBytes(w,h)` 必须恒等于真编码出来的长度，谁都改不动一边。
 * 公式与编码器一一对应：签名 8 + IHDR(12+13) + IDAT(12+ zlib 长度) + IEND(12+0)。
 */
export function pngEncodedBytes(width: number, height: number): number {
  const cols = Math.max(1, Math.floor(width))
  const rows = Math.max(1, Math.floor(height))
  // 每行多一个过滤类型字节（编码器里就是 `cols * 4 + 1`）
  const raw = rows * (cols * 4 + 1)
  const blocks = Math.max(1, Math.ceil(raw / STORED_BLOCK_LIMIT))
  const zlib = 2 + raw + blocks * 5 + 4
  return PNG_SIGNATURE.length + (12 + 13) + (12 + zlib) + (12 + 0)
}

/** 内联成 base64 之后的**字符数**（= data URL 里那一段的长度；base64 每 3 字节出 4 个字符） */
export function pngBase64Length(width: number, height: number): number {
  return Math.ceil(pngEncodedBytes(width, height) / 3) * 4
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 字节 → base64（自己编：`btoa` 在 Node 测试环境里不一定存在） */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!
    const b = index + 1 < bytes.length ? bytes[index + 1]! : 0
    const c = index + 2 < bytes.length ? bytes[index + 2]! : 0
    out += BASE64_ALPHABET[a >> 2]
    out += BASE64_ALPHABET[((a & 0x03) << 4) | (b >> 4)]
    out += index + 1 < bytes.length ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : '='
    out += index + 2 < bytes.length ? BASE64_ALPHABET[c & 0x3f] : '='
  }
  return out
}

/**
 * RGBA 像素 → PNG 的 base64（**不含** `data:` 前缀）。
 *
 * 只写一种格式：8 位 / 真彩 + alpha（color type 6）/ 无交错 —— 这是所有浏览器与
 * 图片查看器都认识的最宽口径，够用且没有可选分支（分支才是编码器出错的地方）。
 */
export function encodeRgbaPngBase64(pixels: Uint8ClampedArray, width: number, height: number): string {
  const cols = Math.max(1, Math.floor(width))
  const rows = Math.max(1, Math.floor(height))
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, cols)
  ihdrView.setUint32(4, rows)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 真彩 + alpha
  ihdr[10] = 0 // 压缩方法（deflate）
  ihdr[11] = 0 // 过滤方法
  ihdr[12] = 0 // 非交错

  // 每行前面要加一个"过滤类型"字节（0 = 不过滤）：这是 PNG 的规定，少写这一列整张图会错位
  const raw = new Uint8Array(rows * (cols * 4 + 1))
  for (let row = 0; row < rows; row += 1) {
    const target = row * (cols * 4 + 1)
    raw[target] = 0
    const source = row * cols * 4
    for (let index = 0; index < cols * 4; index += 1) {
      raw[target + 1 + index] = pixels[source + index] ?? 0
    }
  }

  const parts = [
    new Uint8Array(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const png = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return bytesToBase64(png)
}