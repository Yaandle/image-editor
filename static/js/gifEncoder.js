// gifEncoder.js
// A small, dependency-free GIF89a encoder (header + NETSCAPE loop extension +
// per-frame Graphic Control Extension + LZW-compressed image data). No build
// step available in this app, and fetching a vendored library (gif.js) wasn't
// possible in this environment (network fetch to the CDN was blocked) — so
// this is hand-written rather than vendored.
//
// Palette: a fixed 6x6x6 "web-safe-style" colour cube (216 entries, padded to
// the 256 a global colour table needs). Chosen over adaptive quantization
// (e.g. median-cut) because it needs zero per-pixel search — just arithmetic
// — which matters here since export can sample many frames across several
// pages. Trade-off: flat vector fills (inkkit's primary content) reproduce
// cleanly; photographic/gradient imports will show visible banding. Flagged,
// not fixed — swap in a median-cut quantizer later if photo fidelity matters.

const GIF_LEVELS = [0, 51, 102, 153, 204, 255];

function buildGifPalette() {
  const palette = [];
  for (const r of GIF_LEVELS) for (const g of GIF_LEVELS) for (const b of GIF_LEVELS) palette.push([r, g, b]);
  return palette; // 216 entries
}
const GIF_PALETTE = buildGifPalette();

function gifPaletteIndex(r, g, b) {
  const qr = Math.min(5, Math.round(r / 51));
  const qg = Math.min(5, Math.round(g / 51));
  const qb = Math.min(5, Math.round(b / 51));
  return qr * 36 + qg * 6 + qb;
}

// LSB-first bit packer + GIF sub-block framing (length-prefixed chunks of up
// to 255 bytes, terminated by a zero-length block) — required wrapper format
// for GIF image data regardless of the compression inside it.
class GifBitWriter {
  constructor() {
    this.bytes = [];
    this.buffer = 0;
    this.bufferBits = 0;
    this.subBlock = [];
  }
  write(code, numBits) {
    this.buffer |= code << this.bufferBits;
    this.bufferBits += numBits;
    while (this.bufferBits >= 8) {
      this.subBlock.push(this.buffer & 0xFF);
      if (this.subBlock.length === 255) this._flushSubBlock();
      this.buffer >>= 8;
      this.bufferBits -= 8;
    }
  }
  _flushSubBlock() {
    if (!this.subBlock.length) return;
    this.bytes.push(this.subBlock.length, ...this.subBlock);
    this.subBlock = [];
  }
  flush() {
    if (this.bufferBits > 0) {
      this.subBlock.push(this.buffer & 0xFF);
      this.buffer = 0; this.bufferBits = 0;
    }
    this._flushSubBlock();
    this.bytes.push(0x00); // block terminator
  }
}

// Standard GIF/LZW variable-code-width compressor. minCodeSize is fixed at 8
// here (we always use the full 256-entry global colour table).
function gifLzwEncode(minCodeSize, indices) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const writer = new GifBitWriter();
  let codeSize, dict, nextCode, maxCode;

  function resetDict() {
    dict = new Map();
    for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
    maxCode = (1 << codeSize) - 1;
  }

  resetDict();
  writer.write(clearCode, codeSize);

  let w = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = String(indices[i]);
    const wk = w + "," + k;
    if (dict.has(wk)) { w = wk; continue; }

    writer.write(dict.get(w), codeSize);
    dict.set(wk, nextCode++);
    if (nextCode - 1 >= maxCode) {
      if (codeSize < 12) { codeSize++; maxCode = (1 << codeSize) - 1; }
      else { writer.write(clearCode, codeSize); resetDict(); }
    }
    w = k;
  }
  writer.write(dict.get(w), codeSize);
  writer.write(eoiCode, codeSize);
  writer.flush();
  return writer.bytes;
}

class GifWriter {
  constructor(width, height, { loop = 0 } = {}) {
    this.width = width;
    this.height = height;
    this.chunks = [];
    this._writeHeader(loop);
  }

  _push(...bytes) { this.chunks.push(new Uint8Array(bytes)); }
  _pushBytes(arr) { this.chunks.push(arr instanceof Uint8Array ? arr : new Uint8Array(arr)); }
  _u16(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }

  _writeHeader(loop) {
    this._push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
    this._push(...this._u16(this.width), ...this._u16(this.height));
    this._push(0xF7, 0, 0); // packed (global colour table, 256 entries), bg colour index, pixel aspect ratio

    const gct = [];
    for (const c of GIF_PALETTE) gct.push(c[0], c[1], c[2]);
    while (gct.length < 256 * 3) gct.push(0, 0, 0); // pad 216 -> 256 entries
    this._push(...gct);

    // NETSCAPE2.0 application extension — enables looping (0 = infinite)
    this._push(
      0x21, 0xFF, 0x0B,
      0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30, // "NETSCAPE2.0"
      0x03, 0x01, ...this._u16(loop), 0x00
    );
  }

  // imageData: a canvas ImageData for a frame the size of this GIF's
  // width/height. delayMs: how long this frame holds before the next one.
  addFrame(imageData, delayMs) {
    const delayCs = Math.max(1, Math.round(delayMs / 10)); // GIF delay unit = 1/100s
    this._push(0x21, 0xF9, 0x04, 0x04, ...this._u16(delayCs), 0x00, 0x00); // Graphic Control Extension
    this._push(0x2C, 0, 0, 0, 0, ...this._u16(this.width), ...this._u16(this.height), 0x00); // Image Descriptor

    const total = this.width * this.height;
    const indices = new Uint8Array(total);
    const data = imageData.data;
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      indices[i] = gifPaletteIndex(data[p], data[p + 1], data[p + 2]);
    }

    this._push(8); // LZW minimum code size
    this._pushBytes(gifLzwEncode(8, indices));
  }

  finish() {
    this._push(0x3B); // trailer
    return new Blob(this.chunks, { type: "image/gif" });
  }
}
