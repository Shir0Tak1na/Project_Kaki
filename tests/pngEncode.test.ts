/**
 * 最小 PNG 编码器的单测。
 *
 * 为什么要写得这么"解码式"：编码器的正确性没法靠"看着像 base64"来保证 ——
 * 唯一有意义的断言是**把编码结果解回来，像素逐字节等于输入**。
 * 所以这里带一个极简解码器（只认我们自己写出来的那一种流：存储块 + 无过滤），
 * 用标准库的 `zlib.inflateSync` 当裁判 —— 数据本身是标准 deflate，标准库一定能解。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

import { bytesToBase64, encodeRgbaPngBase64, pngBase64Length, pngEncodedBytes } from '../src/render/pngEncode.ts'

interface DecodedPng {
  width: number
  height: number
  /** 逐像素 RGBA（行优先，**已剥掉每行开头那个过滤类型字节**） */
  pixels: number[]
}

function decodeBase64(text: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = text.replace(/=+$/, '')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    buffer = (buffer << 6) | alphabet.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

/** 解出我们这一种 PNG 的尺寸与像素（够用来证明编码没写错） */
function decodePng(base64: string): DecodedPng {
  const bytes = decodeBase64(base64)
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 签名',
  )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  const idat: Uint8Array[] = []
  const chunks: string[] = []
  while (offset < bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    chunks.push(type)
    const payload = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0)
      height = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4)
      assert.equal(payload[8], 8, '位深 8')
      assert.equal(payload[9], 6, '真彩 + alpha')
    }
    if (type === 'IDAT') idat.push(payload)
    offset += 12 + length
  }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND'], '块的种类与顺序')

  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part)))))
  const pixels: number[] = []
  const stride = width * 4
  for (let row = 0; row < height; row += 1) {
    assert.equal(raw[row * (stride + 1)], 0, '每行的过滤类型必须是 0（我们写的就是不过滤）')
    for (let index = 0; index < stride; index += 1) {
      pixels.push(raw[row * (stride + 1) + 1 + index]!)
    }
  }
  return { width, height, pixels }
}

test('bytesToBase64：与 Buffer 的结果一致（含补位的那两种情况）', () => {
  for (const bytes of [Uint8Array.from([]), Uint8Array.from([0]), Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3]), Uint8Array.from([255, 254, 253, 252])]) {
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), JSON.stringify([...bytes]))
  }
})

test('encodeRgbaPngBase64：解回来必须与输入像素**逐字节相同**', () => {
  const width = 3
  const height = 2
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    0, 0, 0, 0, 128, 128, 128, 255, 255, 255, 255, 255,
  ])
  const decoded = decodePng(encodeRgbaPngBase64(pixels, width, height))
  assert.equal(decoded.width, width)
  assert.equal(decoded.height, height)
  assert.deepEqual(decoded.pixels, [...pixels])
})

test('encodeRgbaPngBase64：大图也稳（跨过一个存储块的上限）', () => {
  // 200×200 RGBA = 160000 字节原始数据，按 65535 一块要切成 3 块
  const width = 200
  const height = 200
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = index % 256
  const decoded = decodePng(encodeRgbaPngBase64(pixels, width, height))
  assert.equal(decoded.pixels.length, pixels.length)
  assert.deepEqual(decoded.pixels.slice(0, 64), [...pixels.slice(0, 64)])
  assert.deepEqual(decoded.pixels.slice(-64), [...pixels.slice(-64)])
  assert.deepEqual(decoded.pixels, [...pixels], '逐字节相同')
})

test('encodeRgbaPngBase64：全透明（没有数据的场）也编得出来，且 alpha 保持 0', () => {
  const pixels = new Uint8ClampedArray(4 * 4)
  const decoded = decodePng(encodeRgbaPngBase64(pixels, 2, 2))
  assert.deepEqual(decoded.pixels, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
})

test('encodeRgbaPngBase64：尺寸被夹到至少 1×1（空场不该编出一张非法 PNG）', () => {
  const decoded = decodePng(encodeRgbaPngBase64(new Uint8ClampedArray(0), 0, 0))
  assert.equal(decoded.width, 1)
  assert.equal(decoded.height, 1)
})

test('pngEncodedBytes / pngBase64Length：预估的体积必须**恒等于**真编出来的长度', () => {
  // 导出侧的体积上限就靠这两个数（编码前先判断，不然白编一张几十万字节的图）。
  // 一旦编码器的分块方式变了而这里没跟上，"上限"就成了假的 —— 所以逐尺寸钉死。
  // 尺寸里**故意**跨过 65535 字节那个存储块边界（128×513 附近）与那几个小尺寸。
  for (const [width, height] of [
    [0, 0],
    [1, 1],
    [3, 2],
    [40, 9],
    [128, 128],
    [129, 127],
  ] as const) {
    const encoded = encodeRgbaPngBase64(new Uint8ClampedArray(Math.max(0, width * height * 4)), width, height)
    // 编码器把尺寸夹到 ≥1（空场也编一张合法 PNG），预估必须走同一条夹取
    const cols = Math.max(1, width)
    const rows = Math.max(1, height)
    assert.equal(encoded.length, pngBase64Length(width, height), `${width}×${height} 的 base64 长度`)
    assert.equal(pngBase64Length(width, height), Math.ceil(pngEncodedBytes(width, height) / 3) * 4)
    // 字节数换算回 base64 再解回来，长度也要对得上（证明预估不是凭空写的公式）
    assert.equal(decodeBase64(encoded).length, pngEncodedBytes(cols, rows))
  }
  // 存储块上界的另一侧：raw > 65535 之后要多一个 5 字节的块头
  const big = encodeRgbaPngBase64(new Uint8ClampedArray(200 * 200 * 4), 200, 200)
  assert.equal(big.length, pngBase64Length(200, 200), '跨过存储块上限时也要一致')
})